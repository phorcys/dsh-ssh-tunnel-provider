import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ssh2 from 'ssh2'
import {
  Config,
  KnownHosts,
  discoverModels,
  parseModelList,
  readConfig,
  reasoningFields,
  resolveConfig,
} from '../lib/index.js'

const { utils } = ssh2

/** Resolve a schema-validated (and therefore volatile) Config into its plain form. */
function resolve(config) {
  return resolveConfig(readConfig(Config(config)))
}

test('resolveConfig applies ssh2, remote, credential, and image defaults', () => {
  const config = resolve({
    ssh: { host: 'nas', identityFile: '~/.ssh/id_ed25519' },
    remote: { port: 8080 },
    apiKeyEnv: 'SUB2API_API_KEY',
  })
  assert.equal(config.provider, 'sub2api-ssh')
  assert.equal(config.ssh.port, 22)
  assert.equal(config.ssh.strictHostKeyChecking, 'accept-new')
  assert.equal(config.remote.host, '127.0.0.1')
  assert.equal(config.remote.basePath, '/v1')
  assert.equal(config.discoverModels, true)
  assert.deepEqual(config.defaults.input, ['text'])
  assert.equal(config.defaults.contextWindow, 262144)
  assert.equal(config.requestTimeoutMs, 20_000)
  assert.equal(config.startupTimeoutMs, 8_000)
  assert.equal(config.compat.thinkingFormat, 'openai')
  assert.equal(config.compat.maxTokensField, 'max_tokens')
  assert.match(config.ssh.identityFile, /\.ssh\/id_ed25519$/)
})

test('resolveConfig keeps configured models and disables discovery only when asked', () => {
  const config = resolve({
    provider: 'nas-models',
    ssh: { host: 'nas', port: 2222 },
    remote: { host: '192.0.2.10', port: 9000, basePath: '/openai/v1/' },
    models: [{ id: 'glm-5', contextWindow: 128000, maxTokens: 32000, input: ['text', 'image'] }],
  })
  assert.equal(config.ssh.host, 'nas')
  assert.equal(config.ssh.port, 2222)
  assert.equal(config.remote.basePath, '/openai/v1')
  assert.equal(config.discoverModels, false)
  assert.equal(config.models[0].id, 'glm-5')
  assert.deepEqual(config.models[0].input, ['text', 'image'])
})

test('resolveConfig rejects the empty catalog dead end', () => {
  assert.throws(
    () => resolve({
      ssh: { host: 'nas' },
      remote: { port: 8080 },
      discoverModels: false,
    }),
    /models is empty and discoverModels is false/,
  )
})

test('resolveConfig rejects duplicate model ids and conflicting key spellings', () => {
  assert.throws(
    () => resolve({
      ssh: { host: 'nas' },
      remote: { port: 8080 },
      models: [{ id: 'same' }, { id: 'same' }],
    }),
    /duplicate id/,
  )
  assert.throws(
    () => resolve({
      ssh: { host: 'nas', identityFile: '~/.ssh/a', key: '~/.ssh/b' },
      remote: { port: 8080 },
    }),
    /name different files/,
  )
})

test('known_hosts pins a matching key and rejects a changed one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-known-hosts-'))
  const file = join(directory, 'known_hosts')
  try {
    const first = utils.generateKeyPairSync('ed25519')
    const second = utils.generateKeyPairSync('ed25519')
    const firstKey = utils.parseKey(first.public).getPublicSSH()
    const secondKey = utils.parseKey(second.public).getPublicSSH()
    await writeFile(file, `nas ssh-ed25519 ${firstKey.toString('base64')}\n`)
    const known = await KnownHosts.load(file, 'nas', 22)
    assert.equal(known.check(firstKey, 'yes').ok, true)
    const changed = known.check(secondKey, 'yes')
    assert.equal(changed.ok, false)
    assert.match(changed.reason, /does not match/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('known_hosts accepts, returns, and pins an unknown host under accept-new', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-known-hosts-'))
  const file = join(directory, 'known_hosts')
  try {
    const key = utils.generateKeyPairSync('ed25519')
    const blob = utils.parseKey(key.public).getPublicSSH()
    const known = await KnownHosts.load(file, '192.0.2.10', 2222)
    const accepted = known.check(blob, 'accept-new')
    assert.equal(accepted.ok, true)
    assert.equal(accepted.append.startsWith('[192.0.2.10]:2222 ssh-ed25519 '), true)
    await known.append(accepted.append)
    const reread = await KnownHosts.load(file, '192.0.2.10', 2222)
    assert.equal(reread.check(blob, 'yes').ok, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('known_hosts matches a hashed host entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-known-hosts-'))
  const file = join(directory, 'known_hosts')
  try {
    const key = utils.generateKeyPairSync('ed25519')
    const blob = utils.parseKey(key.public).getPublicSSH()
    const salt = Buffer.from('0123456789abcdef')
    const digest = createHmac('sha1', salt).update('nas').digest()
    await writeFile(file, `|1|${salt.toString('base64')}|${digest.toString('base64')} ssh-ed25519 ${blob.toString('base64')}\n`)
    const known = await KnownHosts.load(file, 'nas', 22)
    assert.equal(known.check(blob, 'yes').ok, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('parseModelList accepts data arrays and enriched model maps', () => {
  const fromData = parseModelList({
    object: 'list',
    data: [
      { id: 'a', name: 'A', context_window: 100000, max_output_tokens: 8000, architecture: { input_modalities: ['text', 'image'] } },
      { id: 'b' },
      { id: 'a', name: 'duplicate' },
      'c',
    ],
  })
  assert.deepEqual(fromData, [
    { id: 'a', name: 'A', contextWindow: 100000, maxTokens: 8000, input: ['text', 'image'] },
    { id: 'b' },
    { id: 'c' },
  ])

  const fromMap = parseModelList({
    models: {
      'vendor/model': { name: 'Vendor Model', context_length: 64000 },
      'plain': 'ignored string entry',
    },
  })
  assert.deepEqual(fromMap, [
    { id: 'vendor/model', name: 'Vendor Model', contextWindow: 64000 },
    { id: 'plain' },
  ])
})

test('reasoningFields marks unlisted levels unsupported', () => {
  assert.deepEqual(reasoningFields(undefined), { reasoning: false })
  assert.deepEqual(
    reasoningFields({ low: 'low', high: 'high', max: 'max' }),
    {
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: null,
        high: 'high',
        xhigh: null,
        max: 'max',
      },
    },
  )
})

test('built-in families fill the capacities sub2api does not publish', async () => {
  const { ModelCatalog, lookupKnownModel, resolveConfig, readConfig, Config } = await import('../lib/index.js')
  const config = resolveConfig(readConfig(Config({
    ssh: { host: 'nas' },
    remote: { port: 8080 },
    models: [],
  })))

  assert.equal(lookupKnownModel('deepseek-v4-flash').family, 'deepseek-v4')
  assert.equal(lookupKnownModel('deepseek/deepseek-v4.1-flash').family, 'deepseek-v4 vision')
  assert.equal(lookupKnownModel('space-bunny'), undefined)
  // A generic "vision" substring must not inherit DeepSeek's 1M window.
  assert.equal(lookupKnownModel('gpt-4-vision-preview'), undefined)
  assert.equal(lookupKnownModel('glm5.3-flash').family, 'glm-5')

  const catalog = new ModelCatalog(config)
  // Exactly what sub2api advertises: ids and nothing else.
  catalog.setDiscovered([
    { id: 'deepseek-v4-flash' },
    { id: 'deepseek/deepseek-v4.1-flash' },
    { id: 'deepseek-v4-flash-vision-exp' },
    { id: 'kimi-k3.1-pro' },
    { id: 'space-bunny' },
  ])
  const byId = new Map(catalog.models().map(model => [model.id, model]))

  const flash = byId.get('deepseek-v4.1-flash')
  assert.equal(flash.contextWindow, 1_000_000)
  assert.equal(flash.maxTokens, 384_000)
  assert.deepEqual(flash.input, ['text', 'image'])
  assert.equal(flash.source, 'known')
  assert.deepEqual(flash.reasoningEfforts, { low: 'low', high: 'high', max: 'max' })

  // Every advertised spelling collapses to one canonical picker entry.
  assert.equal(byId.has('deepseek-v4-flash'), false)
  assert.equal(byId.has('deepseek/deepseek-v4.1-flash'), false)
  assert.equal(byId.has('deepseek-v4-flash-vision-exp'), false)

  const kimi = byId.get('kimi-k3.1-pro')
  assert.deepEqual(kimi.input, ['text', 'image'])
  assert.equal(kimi.contextWindow, 262_144)

  // An unknown id keeps the route defaults and is reported as a fallback.
  const unknown = byId.get('space-bunny')
  assert.equal(unknown.source, 'defaults')
  assert.equal(unknown.contextWindow, 262_144)
  assert.deepEqual(catalog.summary().fallback, ['space-bunny'])
  assert.equal(catalog.summary().known, 2)
})

test('a configured entry still wins over the built-in families', async () => {
  const { ModelCatalog, resolveConfig, readConfig, Config } = await import('../lib/index.js')
  const config = resolveConfig(readConfig(Config({
    ssh: { host: 'nas' },
    remote: { port: 8080 },
    models: [{ id: 'deepseek-v4-flash', contextWindow: 64000, maxTokens: 4096, input: ['text', 'image'] }],
  })))
  const catalog = new ModelCatalog(config)
  const model = catalog.models()[0]
  assert.equal(model.contextWindow, 64000)
  assert.equal(model.maxTokens, 4096)
  assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.source, 'config')
  assert.equal(model.explicitMaxTokens, 4096)
})

test('a configured maxTokens is not clamped to the route default window', async () => {
  const { ModelCatalog, resolveConfig, readConfig, Config } = await import('../lib/index.js')
  const config = resolveConfig(readConfig(Config({
    ssh: { host: 'nas' },
    remote: { port: 8080 },
    // No contextWindow: the built-in DeepSeek family supplies 1M.
    models: [{ id: 'deepseek-v4-flash', maxTokens: 384000 }],
  })))
  const catalog = new ModelCatalog(config)
  assert.equal(catalog.models()[0].contextWindow, 1_000_000)
  assert.equal(catalog.configuredMaxTokens().get('deepseek-v4-flash'), 384_000)
})

test('knownModels: false leaves discovery on the route defaults', async () => {
  const { ModelCatalog, resolveConfig, readConfig, Config } = await import('../lib/index.js')
  const config = resolveConfig(readConfig(Config({
    ssh: { host: 'nas' },
    remote: { port: 8080 },
    knownModels: false,
    models: [],
  })))
  const catalog = new ModelCatalog(config)
  catalog.setDiscovered([{ id: 'deepseek-v4-flash' }])
  const model = catalog.models()[0]
  assert.equal(config.knownModels, false)
  assert.equal(model.contextWindow, 262_144)
  assert.deepEqual(model.input, ['text'])
})

test('claude ids get their real window, and non-chat ids are not advertised', async () => {
  const { ModelCatalog, canonicalModelId, isChatModelId, isRetiredModelId, resolveConfig, readConfig, Config } = await import('../lib/index.js')
  const config = resolveConfig(readConfig(Config({ ssh: { host: 'nas' }, remote: { port: 8080 }, models: [] })))
  const catalog = new ModelCatalog(config)
  const dropped = catalog.setDiscovered([
    { id: 'claude-sonnet-4-5' },
    { id: 'gpt-image-2' },
    { id: 'text-embedding-3-large' },
    { id: 'whisper-1' },
    { id: 'deepseek-v4-flash' },
  ])
  assert.deepEqual(dropped, ['gpt-image-2', 'text-embedding-3-large', 'whisper-1'])
  assert.deepEqual(catalog.models().map(model => model.id), ['claude-sonnet-4-5', 'deepseek-v4.1-flash'])

  const claude = catalog.models()[0]
  assert.equal(claude.contextWindow, 200_000)
  assert.equal(claude.family, 'claude')
  assert.deepEqual(claude.input, ['text', 'image'])

  assert.equal(isChatModelId('glm-5.3-flash'), true)
  assert.equal(canonicalModelId('deepseek/deepseek-flash'), 'deepseek-v4.1-flash')
  assert.equal(isRetiredModelId('deepseek-v4-flash-vision-exp'), true)
  assert.equal(isChatModelId('flux-1.1-pro'), false)
  assert.equal(isChatModelId('gpt-image-2.5-flare'), false)
  assert.equal(isChatModelId('sora-2'), false)
})

test('each model dispatches to the protocol it names', async () => {
  const { ModelCatalog, protocolBaseUrl, resolveConfig, readConfig, Config } = await import('../lib/index.js')
  const config = resolveConfig(readConfig(Config({
    ssh: { host: 'nas' },
    remote: { port: 8080 },
    api: 'openai-responses',
    models: [
      { id: 'a' },
      { id: 'b', api: 'anthropic-messages' },
      { id: 'c', api: 'openai-completions' },
    ],
  })))
  assert.equal(config.api, 'openai-responses')
  const catalog = new ModelCatalog(config)
  assert.deepEqual(catalog.models().map(model => [model.id, model.api]), [
    ['a', 'openai-responses'],
    ['b', 'anthropic-messages'],
    ['c', 'openai-completions'],
  ])

  // OpenAI SDKs append their own path to the /v1 root; the Anthropic SDK
  // appends /v1/messages itself, so it needs the server root.
  const apiRoot = 'http://127.0.0.1:4000/v1'
  assert.equal(protocolBaseUrl(apiRoot, 'openai-completions'), apiRoot)
  assert.equal(protocolBaseUrl(apiRoot, 'openai-responses'), apiRoot)
  assert.equal(protocolBaseUrl(apiRoot, 'anthropic-messages'), 'http://127.0.0.1:4000')
  assert.equal(protocolBaseUrl('http://127.0.0.1:4000', 'anthropic-messages'), 'http://127.0.0.1:4000')

  const descriptors = catalog.piModels('sub2api', apiRoot)
  const claude = descriptors.find(model => model.id === 'b')
  assert.equal(claude.api, 'anthropic-messages')
  assert.equal(claude.baseUrl, 'http://127.0.0.1:4000')
  assert.equal(descriptors.find(model => model.id === 'a').baseUrl, apiRoot)
})

test('a discovered model takes the route protocol', async () => {
  const { ModelCatalog, resolveConfig, readConfig, Config } = await import('../lib/index.js')
  const config = resolveConfig(readConfig(Config({
    ssh: { host: 'nas' },
    remote: { port: 8080 },
    api: 'anthropic-messages',
    models: [],
  })))
  const catalog = new ModelCatalog(config)
  catalog.setDiscovered([{ id: 'deepseek-v4-flash' }])
  assert.equal(catalog.models()[0].api, 'anthropic-messages')
})


test('discovery refuses redirects and oversized listing bodies', async () => {
  let redirected = 0
  const redirector = createServer((_request, response) => {
    redirected += 1
    response.writeHead(302, { location: 'http://127.0.0.1:1/v1/models' })
    response.end()
  })
  await new Promise(resolve => redirector.listen(0, '127.0.0.1', resolve))
  const redirectAddress = redirector.address()
  assert.ok(redirectAddress !== null && typeof redirectAddress !== 'string')
  try {
    await assert.rejects(
      discoverModels({
        baseUrl: `http://127.0.0.1:${redirectAddress.port}/v1`,
        headers: {},
        timeoutMs: 5_000,
      }),
      error => error.code === 'DISCOVERY_FAILED',
    )
    assert.equal(redirected, 1)
  } finally {
    await new Promise(resolve => redirector.close(resolve))
  }

  const oversized = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(9 * 1024 * 1024),
    })
    response.end('{}')
  })
  await new Promise(resolve => oversized.listen(0, '127.0.0.1', resolve))
  const oversizedAddress = oversized.address()
  assert.ok(oversizedAddress !== null && typeof oversizedAddress !== 'string')
  try {
    await assert.rejects(
      discoverModels({
        baseUrl: `http://127.0.0.1:${oversizedAddress.port}/v1`,
        headers: {},
        timeoutMs: 5_000,
      }),
      error => error.code === 'DISCOVERY_FAILED' && /larger/.test(error.message),
    )
  } finally {
    await new Promise(resolve => oversized.close(resolve))
  }
})

test('disabling discovery clears the discovered half without touching configured models', async () => {
  const { ModelCatalog, resolveConfig, readConfig, Config } = await import('../lib/index.js')
  const config = resolveConfig(readConfig(Config({
    ssh: { host: 'nas' },
    remote: { port: 8080 },
    models: [{ id: 'configured' }],
    discoverModels: true,
  })))
  const catalog = new ModelCatalog(config)
  catalog.setDiscovered([{ id: 'discovered' }])
  assert.deepEqual(catalog.models().map(model => model.id), ['configured', 'discovered'])
  catalog.clearDiscovered()
  assert.deepEqual(catalog.models().map(model => model.id), ['configured'])
})

test('resolveConfig rejects unsafe base paths and header names', () => {
  assert.throws(
    () => resolve({ ssh: { host: 'nas' }, remote: { port: 8080, basePath: '/v1?x=1' } }),
    /query, fragment/,
  )
  assert.throws(
    () => resolve({ ssh: { host: 'nas' }, remote: { port: 8080 }, headers: { 'bad header': 'x' } }),
    /not a valid HTTP header name/,
  )
  assert.throws(
    () => resolve({ ssh: { host: 'nas' }, remote: { port: 8080 }, headers: { 'x-test': 'a\nb' } }),
    /must not contain a newline/,
  )
})

test('an empty credential reference clears the route key instead of becoming a literal name', () => {
  const config = resolve({
    ssh: { host: 'nas' },
    remote: { port: 8080 },
    apiKeyEnv: '   ',
  })
  assert.equal(config.apiKeyEnv, undefined)
})

test('all advertised DeepSeek V4.1 Flash spellings collapse to one entry', async () => {
  const { ModelCatalog, resolveConfig, readConfig, Config } = await import('../lib/index.js')
  const config = resolveConfig(readConfig(Config({ ssh: { host: 'nas' }, remote: { port: 8080 }, models: [] })))
  const catalog = new ModelCatalog(config)
  const aliases = [
    'deepseek-v4-flash',
    'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-1017',
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4.1-flash',
    'deepseek-flash',
    'deepseek/deepseek-flash',
  ]
  const dropped = catalog.setDiscovered([
    ...aliases.map(id => ({ id, name: id })),
    { id: 'deepseek-v4-flash-vision-exp' },
  ])
  assert.deepEqual(catalog.models().map(model => model.id), ['deepseek-v4.1-flash'])
  assert.equal(catalog.models()[0].name, 'deepseek-v4.1-flash')
  assert.deepEqual(catalog.models()[0].input, ['text', 'image'])
  assert.equal(catalog.models()[0].contextWindow, 1_000_000)
  assert.equal(catalog.models()[0].maxTokens, 384_000)
  // Six aliases plus the retired id.
  assert.equal(dropped.length, 7)
})
