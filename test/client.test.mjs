import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** Load the hand-written browser bundle with a minimal module-loader shim. */
async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  const window = {
    __ModuleLoader__: {
      load: (module) => { loaded = module },
    },
  }
  const require = (name) => {
    if (name === 'react') return { createElement: () => null }
    throw new Error(`unexpected client dependency ${name}`)
  }
  const run = new Function('window', 'require', `${source}\nreturn window.__ModuleLoader__.__loaded`)
  // The bundle assigns through load(); expose the captured object to the caller.
  window.__ModuleLoader__.__loaded = undefined
  const originalLoad = window.__ModuleLoader__.load
  window.__ModuleLoader__.load = (module) => {
    loaded = module
    window.__ModuleLoader__.__loaded = module
  }
  run(window, require)
  assert.equal(typeof originalLoad, 'function')
  assert.ok(loaded !== undefined)
  return loaded.factory(require)
}

test('client bundle registers one Plugins-page settings card', async () => {
  const client = await loadClient()
  assert.equal(client.name, 'llm-ssh-tunnel')
  assert.deepEqual(client.inject, ['slots', 'locale'])

  const registrations = []
  const dictionaries = []
  const effects = []
  const ctx = {
    locale: {
      register: (ns, dictionary) => { dictionaries.push([ns, dictionary]) },
      bind: () => (key) => key,
    },
    slots: {
      inject: (slot, register) => {
        assert.equal(slot, 'plugins.item')
        register()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect: (callback) => { effects.push(callback()) },
  }
  client.apply(ctx)
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0][0], 'settings.sshTunnel')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'plugins.item')
  assert.equal(registrations[0].options.id, 'ssh-tunnel')
  assert.equal(registrations[0].options.order, 60)
  assert.equal(registrations[0].options.label(), 'title')
  const injected = registrations[0].options.inject()
  assert.equal(injected.t('title'), 'title')
})
