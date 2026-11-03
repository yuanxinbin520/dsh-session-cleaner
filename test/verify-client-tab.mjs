/**
 * Tab-registration guard for the client bundle.
 *
 * 0.2.1 renders the settings page for the Plugins section from
 * `settings.plugins.tab` contributions (the section owns the navigation entry
 * and the tab chrome). The switch page used to be a card in the 0.1.x
 * `settings.plugin.item` slot, which no longer renders, so this test pins the
 * bundle to the slot that actually exists:
 *
 *   - exactly one `settings.plugins.tab` registration,
 *   - keyed by a stable id and ordered after the shipped inventory (10),
 *   - labelled for the 内置插件 tab bar,
 *   - and the original session-menu / overlay registrations untouched.
 *
 * It executes the real bundle inside a `vm` context with a `__ModuleLoader__`
 * shim, so a broken factory (bad require, missing export) fails here instead of
 * after a desktop restart.
 *
 *   node test/verify-client-tab.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let failed = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  — ${detail}`}`)
  if (!ok) failed += 1
}

// --- minimal platform module faces the bundle touches at module scope -------
const reactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useSyncExternalStore: () => null,
  Fragment: 'Fragment'
}
const primitivesStub = { MenuItemButton: () => null }

let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: registration => { loaded = registration }
    }
  },
  fetch: () => Promise.reject(new Error('no network in this test')),
  console
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

check('bundle registers itself with __ModuleLoader__', loaded !== null)
check('bundle id is the package name', loaded?.id === pkg.name, `id=${JSON.stringify(loaded?.id)}`)

const exported = loaded.factory(specifier => {
  if (specifier === 'react') return reactStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
})

check('factory exports apply()', typeof exported.apply === 'function')
check('factory declares client services', Array.isArray(exported.inject) && exported.inject.includes('slots'))

// --- drive apply() against a slot registry double ---------------------------
const registrations = []
const ctx = {
  slots: {
    inject: (name, callback) => {
      // DSH calls the injected callback once the slot is declared; run it now.
      const result = callback()
      return () => { try { result?.() } catch { /* ignore */ } }
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    }
  },
  sessions: { refresh: () => {} },
  workspaces: { refresh: () => {} }
}
exported.apply(ctx)

const of = name => registrations.filter(entry => entry.options.name === name)
const tabs = of('settings.plugins.tab')

check('registers exactly one settings.plugins.tab page', tabs.length === 1, `found ${tabs.length}`)
check('page id is stable ("config-switches")', tabs[0]?.options.id === 'config-switches', `id=${JSON.stringify(tabs[0]?.options.id)}`)
check('page sorts after the shipped inventory (order >= 10)', tabs[0]?.options.order >= 10, `order=${tabs[0]?.options.order}`)

const label = tabs[0]?.options.label
const text = typeof label === 'function' ? label() : label
check('tab label is the localized page name', text === '配置开关', `label=${JSON.stringify(text)}`)
check('page renders a component', typeof tabs[0]?.component === 'function')

check('session menu rows still registered', of('sidebar.workspaces.session.menu.item').length === 2,
  `found ${of('sidebar.workspaces.session.menu.item').length}`)
check('confirmation dialog still registered', of('shell.overlay').length === 1)
check('no stale 0.1.x settings card registration', of('settings.plugin.item').length === 0)

console.log(failed === 0 ? '\nclient tab registration OK' : `\n${failed} check(s) failed`)
if (failed > 0) process.exit(1)
