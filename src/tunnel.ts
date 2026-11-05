/**
 * One supervised SSH local-forward, implemented in-process with `ssh2`.
 *
 * There is no dependency on an operating-system `ssh` binary, so the same
 * provider works on Linux, macOS, and Windows. The class owns one ssh2 client
 * and one loopback TCP listener: each accepted connection asks ssh2 to open a
 * `direct-tcpip` channel to sub2api and pipes the two sockets together.
 *
 * Readiness means the forward really accepts a connection, not merely that a
 * client object exists. An unexpected disconnect closes the listener and
 * reconnects with exponential backoff; requests wait for the next ready
 * generation instead of failing on a sleeping NAS.
 *
 * @module dsh-llm-ssh-tunnel/tunnel
 */

import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import { createServer, Socket } from 'node:net'
import type { Server } from 'node:net'
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.js'
import { KnownHosts } from './known-hosts.js'
import type { HostKeyPolicy } from './known-hosts.js'

/** The logging surface a Cordis context provides. */
export interface TunnelLogger {
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
}

/** What {@link SshTunnel} needs from configuration. */
export type SshTunnelConfig = Pick<ResolvedConfig, 'ssh' | 'remote' | 'localPort'>

/** Resolve one credential reference to its literal value. */
export type SecretResolver = (ref: string) => Promise<string | undefined>

/** How long one TCP readiness probe may take. */
const PROBE_TIMEOUT_MS = 750

/** Delay before the first restart, doubled per consecutive failure. */
const RESTART_BASE_MS = 1_000

/** Cap on restart backoff. */
const RESTART_MAX_MS = 30_000

/** How long one ssh2 connect may take to authenticate and become ready. */
const START_TIMEOUT_MS = 20_000

/** TCP keepalive interval for a connected SSH transport. */
const KEEPALIVE_INTERVAL_MS = 15_000

/** Pick a free loopback TCP port. */
export async function findFreePort(): Promise<number> {
  const server = createServer()
  server.unref()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('could not allocate a loopback port')
  }
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** True when something accepts TCP connections on `port` within the probe window. */
export async function probePort(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new Socket()
    let settled = false
    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ready)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.connect({ host: '127.0.0.1', port })
  })
}

/** Render an unknown error for a log line or a request diagnostic. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One supervised local forward. */
export class SshTunnel {
  private readonly config: SshTunnelConfig
  private readonly logger: TunnelLogger
  private readonly resolveSecret: SecretResolver | undefined
  private port: number
  private client: Client | undefined
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()
  private ready = false
  private stopped = false
  private connecting = false
  private attempts = 0
  private restartTimer: NodeJS.Timeout | undefined
  private lastError: string | undefined
  private allocated = false

  constructor(config: SshTunnelConfig, logger: TunnelLogger, resolveSecret?: SecretResolver) {
    this.config = config
    this.logger = logger
    this.resolveSecret = resolveSecret
    this.port = config.localPort
  }

  /** The loopback origin currently forwarding to sub2api. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}${this.config.remote.basePath}`
  }

  /** The resolved local port; changes only when an auto-port is rebound after a bind conflict. */
  get localPort(): number {
    return this.port
  }

  /** True while the forward is usable. */
  get isReady(): boolean {
    return this.ready && this.client !== undefined
  }

  /** The last SSH diagnostic, for a request-time failure message. */
  get lastErrorText(): string | undefined {
    return this.lastError
  }

  /** Allocate the loopback port, once, before the provider descriptors are built. */
  async allocate(): Promise<void> {
    if (this.allocated) return
    if (this.port === 0) this.port = await findFreePort()
    this.allocated = true
    this.logger.info(
      `ssh-tunnel: forwarding 127.0.0.1:${this.port} -> ${this.config.remote.host}:${this.config.remote.port}`
      + ` via ${this.config.ssh.user === undefined ? '' : `${this.config.ssh.user}@`}${this.config.ssh.host}:${this.config.ssh.port}`,
    )
  }

  /** Start (or resume) supervision. Returns immediately; readiness is observed separately. */
  start(): void {
    if (this.stopped || this.client !== undefined || this.restartTimer !== undefined) return
    void this.connect()
  }

  /**
   * Wait until a fresh forward accepts a connection.
   * @param timeoutMs - maximum wait; the caller's request budget.
   * @param signal - request cancellation.
   * @throws LlmError `TUNNEL_UNAVAILABLE` when no forward is ready in time.
   */
  async ensureReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.isReady) {
      // A live client is not proof that the forward still accepts connections
      // (a suspended NAS or a dead NAT mapping can keep TCP alive), so every
      // request pays one loopback connect before it pays a model request.
      if (await probePort(this.port)) return
      this.markDown('readiness probe failed')
    }
    if (this.stopped) throw new LlmError('ssh-tunnel: tunnel is stopped', 'TUNNEL_UNAVAILABLE')
    this.start()

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new LlmError('ssh-tunnel: request aborted while waiting for tunnel', 'ABORTED')
      if (this.isReady && await probePort(this.port)) return
      await sleep(Math.min(150, Math.max(1, deadline - Date.now())), undefined, { signal })
        .catch((error: unknown) => {
          if (signal?.aborted) throw new LlmError('ssh-tunnel: request aborted while waiting for tunnel', 'ABORTED', { cause: error })
          throw error
        })
    }
    throw new LlmError(
      `ssh-tunnel: no SSH forward to ${this.config.ssh.host}:${this.config.ssh.port} after ${timeoutMs}ms`
      + (this.lastErrorText === undefined ? '' : ` (${this.lastErrorText})`),
      'TUNNEL_UNAVAILABLE',
    )
  }

  /** Stop supervision and close both the listener and the SSH transport. */
  stop(): void {
    this.stopped = true
    this.ready = false
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.closeServer()
    const client = this.client
    this.client = undefined
    if (client !== undefined) client.end()
  }

  /** Resolve one optional credential reference. */
  private async secret(ref: string | undefined, label: string): Promise<string | undefined> {
    if (ref === undefined) return undefined
    const value = await this.resolveSecret?.(ref)
    if (value === undefined || value.length === 0) {
      throw new Error(`${label} credential ${ref} is not set`)
    }
    return value
  }

  /** Infer the configured agent endpoint, if any. */
  private agent(): string | undefined {
    const configured = this.config.ssh.agent
    if (configured === false) return undefined
    if (typeof configured === 'string' && configured.length > 0) return configured
    if (configured === true) {
      if (process.env.SSH_AUTH_SOCK !== undefined && process.env.SSH_AUTH_SOCK.length > 0) {
        return process.env.SSH_AUTH_SOCK
      }
      return process.platform === 'win32' ? 'pageant' : undefined
    }
    // An explicitly configured key is preferred; otherwise a conventional
    // agent socket is a harmless fallback.
    if (this.config.ssh.identityFile !== undefined) return undefined
    const ambient = process.env.SSH_AUTH_SOCK
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  /** Connect once, load auth material, and install a host-key verifier. */
  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.client !== undefined) return
    this.connecting = true
    this.ready = false
    this.lastError = undefined
    let pending: Client | undefined
    try {
      const identityFile = this.config.ssh.identityFile
      const privateKey = identityFile === undefined
        ? undefined
        : await readFile(identityFile).catch((error: unknown) => {
          throw new Error(`could not read SSH private key ${identityFile}: ${errorText(error)}`)
        })
      const passphrase = await this.secret(this.config.ssh.passphraseEnv, 'SSH key passphrase')
      const password = await this.secret(this.config.ssh.passwordEnv, 'SSH password')
      const agent = this.agent()
      if (privateKey === undefined && agent === undefined && password === undefined) {
        throw new Error('no SSH authentication method: set ssh.identityFile, ssh.agent, or ssh.passwordEnv')
      }

      const knownHostsFile = this.config.ssh.knownHostsFile ?? KnownHosts.defaultFile()
      const knownHosts = await KnownHosts.load(knownHostsFile, this.config.ssh.host, this.config.ssh.port)
      const policy: HostKeyPolicy = this.config.ssh.strictHostKeyChecking
      let appendLine: string | undefined
      const hostVerifier = (key: Buffer): boolean => {
        const check = knownHosts.check(key, policy)
        if (!check.ok) {
          this.lastError = check.reason
          return false
        }
        appendLine = check.append
        return true
      }

      if (this.stopped) {
        this.connecting = false
        return
      }
      const client = new Client()
      pending = client
      this.client = client
      client.on('ready', () => {
        void this.onReady(client, knownHosts, appendLine)
      })
      client.on('error', (error) => {
        this.lastError = this.lastError ?? error.message
        this.logger.warn(`ssh-tunnel: ssh2 error: ${error.message}`)
      })
      client.on('close', () => {
        this.onDisconnect(client)
      })

      const config: ConnectConfig = {
        host: this.config.ssh.host,
        port: this.config.ssh.port,
        username: this.config.ssh.user ?? userInfo().username,
        readyTimeout: START_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: 3,
        hostVerifier,
        ...privateKey === undefined ? {} : { privateKey },
        ...passphrase === undefined ? {} : { passphrase },
        ...password === undefined ? {} : { password },
        ...agent === undefined ? {} : { agent },
      }
      client.connect(config)
    } catch (error) {
      this.connecting = false
      this.lastError = errorText(error)
      // A synchronous throw from `client.connect()` leaves a dead client
      // assigned; without this, `start()` would refuse to retry forever.
      if (pending !== undefined && this.client === pending) {
        this.client = undefined
        try {
          pending.end()
        } catch {
          // The client may never have reached a connected state.
        }
      }
      this.logger.error(`ssh-tunnel: ${errorText(error)}`)
      this.scheduleRestart()
    }
  }

  /** Publish readiness only after the loopback listener is actually bound. */
  private async onReady(client: Client, knownHosts: KnownHosts, appendLine: string | undefined): Promise<void> {
    if (this.stopped || this.client !== client) {
      client.end()
      return
    }
    try {
      await this.listen()
    } catch (error) {
      this.lastError = errorText(error)
      this.logger.error(`ssh-tunnel: could not open loopback listener: ${errorText(error)}`)
      client.end()
      return
    }
    if (this.stopped || this.client !== client) {
      this.closeServer()
      client.end()
      return
    }
    this.ready = true
    this.connecting = false
    this.attempts = 0
    this.logger.info(`ssh-tunnel: ready at ${this.baseUrl}`)
    if (appendLine !== undefined) {
      void knownHosts.append(appendLine).catch((error: unknown) => {
        this.logger.warn(`ssh-tunnel: connected but could not pin the host key: ${errorText(error)}`)
      })
    }
  }

  /** Bind the loopback listener, rebinding an auto-port that lost a race. */
  private async listen(): Promise<void> {
    const tryListen = async (port: number): Promise<Server> => {
      const server = createServer((socket) => this.forward(socket))
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve())
      })
      server.on('error', (error) => {
        this.lastError = error.message
        this.logger.warn(`ssh-tunnel: loopback listener error: ${error.message}`)
        this.markDown('loopback listener error')
      })
      return server
    }

    this.closeServer()
    try {
      this.server = await tryListen(this.port)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE' || this.config.localPort !== 0) throw error
      this.port = await findFreePort()
      this.logger.warn(`ssh-tunnel: local port changed to ${this.port}`)
      this.server = await tryListen(this.port)
    }
  }

  /** Pipe one accepted loopback connection through a direct-tcpip channel. */
  private forward(socket: Socket): void {
    this.sockets.add(socket)
    const client = this.client
    if (!this.ready || client === undefined) {
      this.sockets.delete(socket)
      socket.destroy()
      return
    }
    client.forwardOut('127.0.0.1', socket.remotePort ?? 0, this.config.remote.host, this.config.remote.port, (error, stream) => {
      if (error !== undefined) {
        this.lastError = error.message
        socket.destroy()
        return
      }
      if (socket.destroyed) {
        stream.destroy()
        return
      }
      const cleanup = (): void => {
        this.sockets.delete(socket)
        socket.destroy()
        stream.destroy()
      }
      socket.on('error', cleanup)
      stream.on('error', cleanup)
      stream.on('close', cleanup)
      socket.pipe(stream).pipe(socket)
    })
  }

  /** Drop readiness and restart after the transport closes. */
  private onDisconnect(client: Client): void {
    if (this.client !== client) return
    this.client = undefined
    this.ready = false
    this.connecting = false
    this.closeServer()
    if (this.stopped) return
    this.lastError = this.lastError ?? 'SSH connection closed'
    this.logger.warn(`ssh-tunnel: SSH connection closed: ${this.lastError}`)
    this.scheduleRestart()
  }

  /** Force the current generation down; the close handler restarts it. */
  private markDown(reason: string): void {
    this.ready = false
    this.lastError = reason
    this.closeServer()
    this.client?.end()
  }

  /** Close the loopback listener and every connection it accepted. */
  private closeServer(): void {
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      try {
        server.close()
      } catch {
        // Already closed.
      }
    }
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  /** Restart with exponential backoff. */
  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer !== undefined) return
    const delay = Math.min(RESTART_BASE_MS * 2 ** Math.min(this.attempts, 5), RESTART_MAX_MS)
    this.attempts += 1
    if (this.attempts <= 3 || this.attempts % 10 === 0) {
      this.logger.warn(`ssh-tunnel: reconnecting in ${delay}ms (attempt ${this.attempts})`)
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.connect()
    }, delay)
    this.restartTimer.unref()
  }
}
