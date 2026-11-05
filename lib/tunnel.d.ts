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
import type { ResolvedConfig } from './config.js';
/** The logging surface a Cordis context provides. */
export interface TunnelLogger {
    info(message: string): void;
    warn(message: string, error?: unknown): void;
    error(message: string, error?: unknown): void;
}
/** What {@link SshTunnel} needs from configuration. */
export type SshTunnelConfig = Pick<ResolvedConfig, 'ssh' | 'remote' | 'localPort'>;
/** Resolve one credential reference to its literal value. */
export type SecretResolver = (ref: string) => Promise<string | undefined>;
/** Pick a free loopback TCP port. */
export declare function findFreePort(): Promise<number>;
/** True when something accepts TCP connections on `port` within the probe window. */
export declare function probePort(port: number, timeoutMs?: number): Promise<boolean>;
/** One supervised local forward. */
export declare class SshTunnel {
    private readonly config;
    private readonly logger;
    private readonly resolveSecret;
    private port;
    private client;
    private server;
    private readonly sockets;
    private ready;
    private stopped;
    private connecting;
    private attempts;
    private restartTimer;
    private lastError;
    private allocated;
    constructor(config: SshTunnelConfig, logger: TunnelLogger, resolveSecret?: SecretResolver);
    /** The loopback origin currently forwarding to sub2api. */
    get baseUrl(): string;
    /** The resolved local port; changes only when an auto-port is rebound after a bind conflict. */
    get localPort(): number;
    /** True while the forward is usable. */
    get isReady(): boolean;
    /** The last SSH diagnostic, for a request-time failure message. */
    get lastErrorText(): string | undefined;
    /** Allocate the loopback port, once, before the provider descriptors are built. */
    allocate(): Promise<void>;
    /** Start (or resume) supervision. Returns immediately; readiness is observed separately. */
    start(): void;
    /**
     * Wait until a fresh forward accepts a connection.
     * @param timeoutMs - maximum wait; the caller's request budget.
     * @param signal - request cancellation.
     * @throws LlmError `TUNNEL_UNAVAILABLE` when no forward is ready in time.
     */
    ensureReady(timeoutMs: number, signal?: AbortSignal): Promise<void>;
    /** Stop supervision and close both the listener and the SSH transport. */
    stop(): void;
    /** Resolve one optional credential reference. */
    private secret;
    /** Infer the configured agent endpoint, if any. */
    private agent;
    /** Connect once, load auth material, and install a host-key verifier. */
    private connect;
    /** Publish readiness only after the loopback listener is actually bound. */
    private onReady;
    /** Bind the loopback listener, rebinding an auto-port that lost a race. */
    private listen;
    /** Pipe one accepted loopback connection through a direct-tcpip channel. */
    private forward;
    /** Drop readiness and restart after the transport closes. */
    private onDisconnect;
    /** Force the current generation down; the close handler restarts it. */
    private markDown;
    /** Close the loopback listener and every connection it accepted. */
    private closeServer;
    /** Restart with exponential backoff. */
    private scheduleRestart;
}
