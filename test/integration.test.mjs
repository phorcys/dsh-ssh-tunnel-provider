import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer, connect as connectTcp } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ssh2 from 'ssh2'
import { apply } from '../lib/index.js'

const { Server, utils } = ssh2

/**
 * Generate one throwaway Ed25519 key, retrying the rare output ssh2 cannot
 * parse. Keys live only in this test process; no private key is checked in.
 */
function testKey() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pair = utils.generateKeyPairSync('ed25519')
    try {
      const parsed = utils.parseKey(pair.private)
      if (parsed !== undefined && !(parsed instanceof Error)) return pair.private
    } catch {
      // Try another generation.
    }
  }
  throw new Error('could not generate a parsable test SSH key')
}

const HOST_KEY = testKey()
const USER_KEY = testKey()

/** A minimal OpenAI-compatible endpoint with a model list and one text stream. */
async function startMockSub2Api() {
  const requests = []
  const listed = [
    { id: 'mock-large', name: 'Mock Large', context_window: 100000, max_output_tokens: 8000 },
    { id: 'mock-vision', name: 'Mock Vision', context_window: 64000, architecture: { input_modalities: ['text', 'image'] } },
    // The shape sub2api actually returns: an id and nothing else.
    { id: 'deepseek-v4-flash', type: 'model', display_name: 'deepseek-v4-flash', created_at: '2024-01-01T00:00:00Z' },
    { id: 'deepseek/deepseek-v4.1-flash', type: 'model', display_name: 'deepseek/deepseek-v4.1-flash', created_at: '2024-01-01T00:00:00Z' },
  ]
  const server = createHttpServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body })
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: listed }))
        return
      }
      if (request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":"Hello"},"index":0,"finish_reason":null}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":" from mock"},"index":0,"finish_reason":null}]}\n\n')
        response.write('data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n')
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  return {
    port: address.port,
    requests,
    /** Simulate a sub2api-side catalog addition. */
    addModel: (entry) => { listed.push(entry) },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * An in-process SSH server implementing exactly what the tunnel uses:
 * public-key auth plus direct-tcpip channels. This is the cross-platform
 * substitute for a system sshd; no `ssh` executable is involved.
 */
async function startSshServer() {
  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') ctx.accept()
      else if (ctx.method === 'none') ctx.reject(['publickey'])
      else ctx.reject(['publickey'])
    })
    client.on('tcpip', (acceptChannel, _reject, info) => {
      const stream = acceptChannel()
      const upstream = connectTcp(info.destPort, info.destIP)
      upstream.on('connect', () => {
        stream.pipe(upstream).pipe(stream)
      })
      const close = () => {
        stream.destroy()
        upstream.destroy()
      }
      upstream.on('error', close)
      stream.on('error', close)
      stream.on('close', close)
    })
    client.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A fake Cordis context that records the adapter and owns the disposers. */
function fakeContext() {
  const logs = []
  const emitted = []
  const disposers = []
  const listeners = {}
  let registration
  const ctx = {
    logger: {
      info: message => logs.push(['info', message]),
      warn: (message, error) => logs.push(['warn', message, error]),
      error: (message, error) => logs.push(['error', message, error]),
    },
    get: name => name === 'credentials'
      ? { resolve: async ref => ({ value: process.env[ref] }) }
      : undefined,
    emit: (event) => { emitted.push(event) },
    on: (event, listener) => { (listeners[event] ??= []).push(listener) },
    inject: () => {},
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    llm: {
      registerAdapter: (routes, adapter) => {
        registration = { routes, adapter }
        const dispose = () => {}
        dispose.replace = () => {}
        return dispose
      },
    },
  }
  return {
    ctx,
    logs,
    emitted,
    listeners,
    get registration() { return registration },
    dispose: async () => {
      for (const disposer of disposers.reverse()) await disposer()
    },
  }
}

/** Wait until `check` returns a truthy value or the deadline expires. */
async function eventually(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw lastError ?? new Error('condition not met before deadline')
}

/** Write a throwaway SSH private key and known_hosts path for one test. */
async function authFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-tunnel-'))
  const keyPath = join(directory, 'id_ed25519')
  await writeFile(keyPath, USER_KEY, { mode: 0o600 })
  return {
    directory,
    privateKey: USER_KEY,
    keyPath,
    knownHostsFile: join(directory, 'known_hosts'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

test('apply builds a route, discovers models through an in-process SSH forward, and streams a completion', async () => {
  const mock = await startMockSub2Api()
  const ssh = await startSshServer()
  const auth = await authFixture()
  process.env.TEST_SUB2API_KEY = 'test-key'
  const harness = fakeContext()
  try {
    await apply(harness.ctx, {
      provider: 'sub2api-test',
      displayName: 'Sub2API Test',
      ssh: {
        host: '127.0.0.1',
        port: ssh.port,
        user: 'tester',
        identityFile: auth.keyPath,
        knownHostsFile: auth.knownHostsFile,
        strictHostKeyChecking: 'accept-new',
      },
      remote: { host: '127.0.0.1', port: mock.port, basePath: '/v1' },
      apiKeyEnv: 'TEST_SUB2API_KEY',
      discoverModels: true,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: 'max_tokens',
        thinkingFormat: 'openai',
      },
    })

    const { routes, adapter } = harness.registration
    assert.deepEqual(routes, ['sub2api-test'])

    const models = await eventually(async () => {
      const listed = await adapter.listModels('sub2api-test')
      return listed.length === 3 ? listed : undefined
    })
    assert.deepEqual(models.map(model => model.id), [
      'mock-large', 'mock-vision', 'deepseek-v4.1-flash',
    ])
    assert.equal(models[0].name, 'Mock Large')
    assert.deepEqual(models[1].inputModalities, ['text', 'image'])
    const resolvedLarge = await adapter.resolveModel('sub2api-test', 'mock-large')
    assert.equal(resolvedLarge.context?.contextWindow, 100000)
    assert.equal(resolvedLarge.defaultMaxTokens, undefined)

    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'sub2api-test',
      model: 'mock-large',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'say hello' }] }],
      maxTokens: 64,
    })) {
      chunks.push(chunk)
    }

    const text = chunks
      .filter(chunk => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    assert.equal(text, 'Hello from mock')
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'stop')
    const usage = chunks.find(chunk => chunk.type === 'usage')
    assert.equal(usage.usage.inputTokens, 3)
    assert.equal(usage.usage.outputTokens, 2)

    const completion = mock.requests.find(request => request.url === '/v1/chat/completions')
    assert.ok(completion !== undefined)
    assert.equal(completion.headers.authorization, 'Bearer test-key')
    assert.match(completion.body, /"model":"mock-large"/)

    // The agent loop takes `prepareCall`, whose returned stream bypasses the
    // base class's public `stream()` override unless this adapter wraps it.
    const prepared = await adapter.prepareCall('sub2api-test', 'mock-large')
    const preparedText = []
    for await (const chunk of prepared.stream({
      provider: 'sub2api-test',
      model: 'mock-large',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'again' }] }],
      maxTokens: 64,
    })) {
      if (chunk.type === 'text-delta') preparedText.push(chunk.text)
    }
    assert.equal(preparedText.join(''), 'Hello from mock')
  } finally {
    await harness.dispose()
    delete process.env.TEST_SUB2API_KEY
    await auth.cleanup()
    await ssh.close()
    await mock.close()
  }
})

test('a configured catalog serves without discovery', async () => {
  const mock = await startMockSub2Api()
  const ssh = await startSshServer()
  const auth = await authFixture()
  process.env.TEST_SUB2API_KEY = 'test-key'
  const harness = fakeContext()
  try {
    await apply(harness.ctx, {
      provider: 'sub2api-static',
      ssh: {
        host: '127.0.0.1',
        port: ssh.port,
        identityFile: auth.keyPath,
        knownHostsFile: auth.knownHostsFile,
        strictHostKeyChecking: 'accept-new',
      },
      remote: { port: mock.port },
      apiKeyEnv: 'TEST_SUB2API_KEY',
      models: [
        { id: 'mock-large', name: 'Configured Large', contextWindow: 123456, maxTokens: 4096 },
      ],
      discoverModels: false,
    })
    const { adapter } = harness.registration
    const models = await adapter.listModels('sub2api-static')
    assert.equal(models.length, 1)
    assert.equal(models[0].name, 'Configured Large')
    const resolved = await adapter.resolveModel('sub2api-static', 'mock-large')
    assert.equal(resolved.context?.contextWindow, 123456)
    assert.equal(resolved.defaultMaxTokens, 4096)
  } finally {
    await harness.dispose()
    delete process.env.TEST_SUB2API_KEY
    await auth.cleanup()
    await ssh.close()
    await mock.close()
  }
})

test('a stale catalog refreshes on read, so a sub2api-side addition reaches the picker', async () => {
  const mock = await startMockSub2Api()
  const ssh = await startSshServer()
  const auth = await authFixture()
  process.env.TEST_SUB2API_KEY = 'test-key'
  const harness = fakeContext()
  try {
    await apply(harness.ctx, {
      provider: 'sub2api-refresh',
      ssh: {
        host: '127.0.0.1',
        port: ssh.port,
        identityFile: auth.keyPath,
        knownHostsFile: auth.knownHostsFile,
        strictHostKeyChecking: 'accept-new',
      },
      remote: { port: mock.port },
      apiKeyEnv: 'TEST_SUB2API_KEY',
      // A configured catalog keeps boot fast; discovery still enriches it.
      models: [{ id: 'mock-large', name: 'Configured Large' }],
      discoverModels: true,
      // Every catalog read is stale, which is the TTL mechanism under test.
      modelsMaxAgeMs: 0,
    })
    const { adapter } = harness.registration

    const initial = await eventually(async () => {
      const listed = await adapter.listModels('sub2api-refresh')
      return listed.length === 3 ? listed : undefined
    })
    assert.deepEqual(initial.map(model => model.id), [
      'mock-large', 'mock-vision', 'deepseek-v4.1-flash',
    ])
    const announces = harness.emitted.filter(event => event === 'llm/adapters-updated').length
    assert.ok(announces >= 1)

    mock.addModel({ id: 'mock-new', name: 'Mock New', context_window: 32000 })

    const discovered = await eventually(async () => {
      const listed = await adapter.listModels('sub2api-refresh')
      return listed.some(model => model.id === 'mock-new') ? listed : undefined
    })
    assert.deepEqual(discovered.map(model => model.id), [
      'mock-large', 'mock-vision', 'deepseek-v4.1-flash', 'mock-new',
    ])
    assert.ok(
      harness.emitted.filter(event => event === 'llm/adapters-updated').length > announces,
      'a changed catalog is announced so pickers re-read it',
    )

    // An unchanged listing must not keep announcing: that would make every
    // open picker re-read the catalog forever.
    const settled = harness.emitted.filter(event => event === 'llm/adapters-updated').length
    await adapter.listModels('sub2api-refresh')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(harness.emitted.filter(event => event === 'llm/adapters-updated').length, settled)
  } finally {
    await harness.dispose()
    delete process.env.TEST_SUB2API_KEY
    await auth.cleanup()
    await ssh.close()
    await mock.close()
  }
})

test('a sub2api-shaped listing still yields the right context, output, and image support', async () => {
  const mock = await startMockSub2Api()
  const ssh = await startSshServer()
  const auth = await authFixture()
  process.env.TEST_SUB2API_KEY = 'test-key'
  const harness = fakeContext()
  try {
    await apply(harness.ctx, {
      provider: 'sub2api-bare',
      ssh: {
        host: '127.0.0.1',
        port: ssh.port,
        identityFile: auth.keyPath,
        knownHostsFile: auth.knownHostsFile,
        strictHostKeyChecking: 'accept-new',
      },
      remote: { port: mock.port },
      apiKeyEnv: 'TEST_SUB2API_KEY',
      discoverModels: true,
      startupTimeoutSeconds: 20,
    })
    const { adapter } = harness.registration
    const listed = await eventually(async () => {
      const models = await adapter.listModels('sub2api-bare')
      return models.length >= 3 ? models : undefined
    })
    assert.ok(listed.some(model => model.id === 'deepseek-v4.1-flash'))
    assert.equal(listed.some(model => model.id === 'deepseek-v4-flash'), false)
    assert.equal(listed.some(model => model.id === 'deepseek/deepseek-v4.1-flash'), false)

    const flash = await adapter.resolveModel('sub2api-bare', 'deepseek-v4.1-flash')
    assert.equal(flash.context?.contextWindow, 1_000_000)
    assert.deepEqual(flash.inputModalities, ['text', 'image'])
    assert.deepEqual(flash.reasoning?.efforts.map(effort => effort.id), ['low', 'high', 'max'])
  } finally {
    await harness.dispose()
    delete process.env.TEST_SUB2API_KEY
    await auth.cleanup()
    await ssh.close()
    await mock.close()
  }
})

test('the selected protocol is the path the request takes', async () => {
  const mock = await startMockSub2Api()
  const ssh = await startSshServer()
  const auth = await authFixture()
  process.env.TEST_SUB2API_KEY = 'test-key'
  const harness = fakeContext()
  try {
    await apply(harness.ctx, {
      provider: 'sub2api-protocols',
      ssh: {
        host: '127.0.0.1',
        port: ssh.port,
        identityFile: auth.keyPath,
        knownHostsFile: auth.knownHostsFile,
        strictHostKeyChecking: 'accept-new',
      },
      remote: { port: mock.port, basePath: '/v1' },
      apiKeyEnv: 'TEST_SUB2API_KEY',
      models: [
        { id: 'chat-model', api: 'openai-completions' },
        { id: 'response-model', api: 'openai-responses' },
        { id: 'messages-model', api: 'anthropic-messages' },
      ],
      discoverModels: false,
    })
    const { adapter } = harness.registration

    // The mock serves chat completions only; the other two end in an error
    // finish, which is enough to prove where each request went.
    const drain = async (model) => {
      try {
        for await (const _chunk of adapter.stream({
          provider: 'sub2api-protocols',
          model,
          maxTokens: 16,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) {
          // Consume to completion.
        }
      } catch {
        // A transport-level failure is still a dispatched request.
      }
    }

    await drain('chat-model')
    await drain('response-model')
    await drain('messages-model')

    const paths = mock.requests.map(request => request.url)
    assert.ok(paths.includes('/v1/chat/completions'), `expected a chat completions request, saw ${paths.join(', ')}`)
    assert.ok(paths.includes('/v1/responses'), `expected a responses request, saw ${paths.join(', ')}`)
    assert.ok(
      paths.some(path => path.startsWith('/v1/messages')),
      `expected a messages request, saw ${paths.join(', ')}`,
    )
  } finally {
    await harness.dispose()
    delete process.env.TEST_SUB2API_KEY
    await auth.cleanup()
    await ssh.close()
    await mock.close()
  }
})
