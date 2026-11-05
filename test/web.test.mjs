import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerSettingsRoute, SETTINGS_ROUTE } from '../lib/index.js'

/** Read the catalog model count out of one settings response. */
function refreshViewCount(view) {
  return view.catalog?.models
}

test('settings route serves a token-guarded GET/POST and persists the override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-tunnel-web-'))
  const settingsFile = join(directory, 'settings.json')
  const applied = []
  let refreshed = 0
  const credentials = {
    async describe(ref) { return { ref, configured: ref !== 'EMPTY', writable: true } },
    async set(ref, value) { credentials.last = { ref, value } },
  }
  let settings = {
    ssh: { host: 'nas', port: 22, strictHostKeyChecking: 'accept-new' },
    remote: { host: '127.0.0.1', port: 8080, basePath: '/v1' },
    apiKeyEnv: 'SUB2API_API_KEY',
  }
  const runtime = {
    settingsSnapshot: () => settings,
    catalogSnapshot: () => ({ models: 2, refreshedAt: Date.now(), maxAgeMs: 600_000 }),
    async refreshModels() {
      refreshed += 1
      return 3
    },
    async applySettings(patch) {
      applied.push(patch)
      settings = {
        ...settings,
        ...patch.apiKeyEnv === undefined ? {} : { apiKeyEnv: patch.apiKeyEnv },
        ssh: { ...settings.ssh, ...patch.ssh },
        remote: { ...settings.remote, ...patch.remote },
      }
    },
  }

  let handler
  const scope = {
    webServer: {
      register: route => {
        handler = route.handler
        return () => {}
      },
    },
    effect: callback => { callback() },
    get: name => name === 'credentials' ? credentials : undefined,
  }
  const ctx = {
    inject: (names, callback) => {
      assert.deepEqual(names, ['webServer'])
      callback(scope)
    },
  }
  registerSettingsRoute(ctx, { runtime, settingsFile, token: 'test-token' })
  assert.equal(typeof handler, 'function')

  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}${SETTINGS_ROUTE}`
  try {
    const getResponse = await fetch(url, { headers: { host: `127.0.0.1:${address.port}` } })
    assert.equal(getResponse.status, 200)
    const view = await getResponse.json()
    assert.equal(view.token, 'test-token')
    assert.equal(view.settings.ssh.host, 'nas')
    assert.equal(view.credential.configured, true)

    assert.equal(view.catalog.models, 2)

    const denied = await fetch(url, { method: 'POST', body: '{}' })
    assert.equal(denied.status, 403)

    const refresh = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-ssh-tunnel-token': 'test-token' },
      body: JSON.stringify({ action: 'refresh' }),
    })
    assert.equal(refresh.status, 200)
    const refreshedView = await refresh.json()
    assert.equal(refreshedView.refreshed, 3)
    assert.equal(refreshViewCount(refreshedView), 2)

    const post = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-ssh-tunnel-token': 'test-token',
      },
      body: JSON.stringify({
        settings: {
          ssh: {
            host: 'nas.example',
            port: 2222,
            user: 'deploy',
            identityFile: 'C:\\Users\\me\\.ssh\\id_ed25519',
            strictHostKeyChecking: 'yes',
          },
          remote: { host: '127.0.0.1', port: 8080, basePath: '/v1' },
          apiKeyEnv: 'NEW_REF',
        },
        apiKey: 'secret-value',
      }),
    })
    assert.equal(post.status, 200)
    const updated = await post.json()
    assert.equal(updated.settings.ssh.host, 'nas.example')
    assert.equal(updated.settings.ssh.port, 2222)
    assert.equal(updated.settings.apiKeyEnv, 'NEW_REF')
    assert.equal(updated.credential.ref, 'NEW_REF')
    assert.deepEqual(credentials.last, { ref: 'NEW_REF', value: 'secret-value' })
    assert.equal(applied.length, 1)
    assert.equal(applied[0].ssh.strictHostKeyChecking, 'yes')

    const document = JSON.parse(await readFile(settingsFile, 'utf8'))
    assert.equal(document.version, 1)
    assert.equal(document.settings.ssh.host, 'nas.example')
    assert.equal(JSON.stringify(document).includes('secret-value'), false)
    assert.equal(refreshed, 1)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('a key entered without a reference persists the default reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-tunnel-web-'))
  const settingsFile = join(directory, 'settings.json')
  let settings = {
    ssh: { host: 'nas', port: 22, strictHostKeyChecking: 'accept-new' },
    remote: { host: '127.0.0.1', port: 8080, basePath: '/v1' },
  }
  const credentials = {
    async describe(ref) { return { ref, configured: false, writable: true } },
    async set(ref, value) { credentials.last = { ref, value } },
  }
  const applied = []
  const runtime = {
    settingsSnapshot: () => settings,
    catalogSnapshot: () => ({ models: 0, maxAgeMs: 600_000 }),
    async refreshModels() { return 0 },
    async applySettings(patch) {
      applied.push(patch)
      settings = { ...settings, ...patch.apiKeyEnv === undefined ? {} : { apiKeyEnv: patch.apiKeyEnv } }
    },
  }
  let handler
  const scope = {
    webServer: { register: route => { handler = route.handler; return () => {} } },
    effect: callback => { callback() },
    get: name => name === 'credentials' ? credentials : undefined,
  }
  const ctx = { inject: (names, callback) => callback(scope) }
  registerSettingsRoute(ctx, { runtime, settingsFile, token: 'test-token' })
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}${SETTINGS_ROUTE}`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-ssh-tunnel-token': 'test-token' },
      body: JSON.stringify({
        settings: { ssh: { host: 'nas' }, remote: { port: 8080 } },
        apiKey: 'secret-value',
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(applied.length, 1)
    assert.equal(applied[0].apiKeyEnv, 'SUB2API_API_KEY')
    assert.deepEqual(credentials.last, { ref: 'SUB2API_API_KEY', value: 'secret-value' })
    const document = JSON.parse(await readFile(settingsFile, 'utf8'))
    assert.equal(document.settings.apiKeyEnv, 'SUB2API_API_KEY')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('an empty optional field is sent through so it can clear an override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-tunnel-web-'))
  const settingsFile = join(directory, 'settings.json')
  const applied = []
  const runtime = {
    settingsSnapshot: () => ({
      ssh: { host: 'nas', port: 22, strictHostKeyChecking: 'accept-new', knownHostsFile: '/tmp/old' },
      remote: { host: '127.0.0.1', port: 8080, basePath: '/v1' },
    }),
    catalogSnapshot: () => ({ models: 1, maxAgeMs: 600_000 }),
    async refreshModels() { return 1 },
    async applySettings(patch) { applied.push(patch) },
  }
  let handler
  const scope = {
    webServer: { register: route => { handler = route.handler; return () => {} } },
    effect: callback => { callback() },
    get: () => undefined,
  }
  registerSettingsRoute({ inject: (names, callback) => callback(scope) },
    { runtime, settingsFile, token: 'test-token' })
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}${SETTINGS_ROUTE}`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-ssh-tunnel-token': 'test-token' },
      body: JSON.stringify({ settings: { ssh: { knownHostsFile: '' } } }),
    })
    assert.equal(response.status, 200)
    assert.equal(applied.length, 1)
    assert.equal(applied[0].ssh.knownHostsFile, '')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
