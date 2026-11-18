import assert from 'node:assert/strict'
import test from 'node:test'

/** Minimal React stand-in: the bundle only builds elements, never renders here. */
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
}

/** Capture the one registration the bundle submits. */
let registration
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => { registration = value },
  },
}

await import('../client.js')

const requireStub = (specifier) => {
  if (specifier === 'react') return react
  throw new Error(`unexpected module ${specifier}`)
}

test('the bundle registers under the package id with a factory', () => {
  assert.equal(registration.id, 'dsh-smart-compact')
  const exports = registration.factory(requireStub)
  assert.equal(exports.name, 'smart-compact')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers the locale table and both slots', () => {
  const exports = registration.factory(requireStub)
  const locales = []
  const slots = []
  const ctx = {
    effect: (factory) => { const dispose = factory(); return dispose },
    locale: {
      register: (ns, table) => { locales.push([ns, table]); return () => {} },
      resolveText: (text) => text.en,
    },
    slots: {
      inject: (name, factory) => {
        const dispose = factory()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register: (options, component) => {
        slots.push([options.name, options, component])
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.equal(locales[0][0], 'smart-compact')
  assert.equal(typeof locales[0][1].en['row.label'], 'string')
  assert.equal(typeof locales[0][1].zh['row.label'], 'string')
  assert.deepEqual(slots.map(entry => entry[0]), [
    'conversation.input.model.options',
    'plugins.bundle.config',
  ])

  const row = slots[0][1]
  assert.equal(row.id, 'smart-compact')
  assert.equal(row.order, 40)
  assert.equal(row.locale, 'smart-compact')
  assert.equal(typeof slots[0][2], 'function')

  const page = slots[1][1]
  assert.equal(page.key, 'dsh-smart-compact')
  assert.equal(typeof slots[1][2], 'function')
})
