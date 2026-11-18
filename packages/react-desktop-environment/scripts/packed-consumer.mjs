import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import * as desktop from 'react-desktop-environment'
import * as compositor from 'react-desktop-environment/compositor'
import * as windowManager from 'react-desktop-environment/window-manager'
import * as windowReact from 'react-desktop-environment/window-manager/react'
import * as ui from 'react-desktop-environment/ui'
import { AppletPresentation, DEFAULT_APPLET_THEME, resolveAppletTheme, useAppletTheme } from 'react-desktop-environment/ui/applet'
import {
  AppletEngine,
  AppletStateStoreContext,
  createAppletEngine,
  createAppletStateStore,
} from 'react-desktop-environment/applet-engine'

const installed = fileURLToPath(import.meta.resolve('react-desktop-environment/applet-engine'))
assert.match(installed, /node_modules\/react-desktop-environment\/dist\/applet-engine\.js$/)
assert.equal(realpathSync(installed), installed)
assert.equal(typeof windowManager.createWindowManager, 'function')
assert.equal(typeof compositor.createCompositor, 'function')
assert.ok(Object.keys(desktop).length && Object.keys(windowReact).length && Object.keys(ui).length)
const dom = new JSDOM('<!doctype html><div id="root"></div>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const environment = { compositor, windowManager, ui: { Window: ({ children }) => children } }
const h = React.createElement
const observations = {}

function Note({ application }) {
  const [value, setValue] = AppletEngine.useState('original', 'text')
  observations.noteApplication = application
  observations.edit = setValue
  observations.observedTheme = useAppletTheme()
  return h('output', null, value)
}
Note.meta = Object.freeze({ applicationName: 'note' })
Note.applets = Object.freeze({})
function Notebook() { return null }
Notebook.meta = Object.freeze({
  applicationName: 'notebook',
  theme: Object.freeze({
    ...DEFAULT_APPLET_THEME,
    backgroundColor: 'navy',
    reconcile: (identity, scheme) => ({ ...identity, canvasColor: scheme === 'night' ? 'black' : 'white' }),
  }),
})
Notebook.applets = Object.freeze({ note: Note })
Notebook.recipes = Object.freeze([Object.freeze({ name: 'notes', addable: true, residents: [{ applet: 'note' }] })])
Notebook.desktopEnvironment = environment
const BoundEngine = createAppletEngine(Notebook)
assert.equal(BoundEngine.Runtime, AppletEngine)
const root = createRoot(document.getElementById('root'))
await act(async () => {
  root.render(h(BoundEngine, { onEngine: (engine) => { observations.currentEngine = engine } }, h(AppletPresentation, { scheme: 'day' })))
})
assert.equal(document.querySelector('output').textContent, 'original')
assert.equal(observations.observedTheme.backgroundColor, 'navy')
const originalEngine = observations.currentEngine
const originalApplicationId = observations.noteApplication.applicationId
const originalSurface = Object.values(observations.currentEngine.compositor.getSnapshot().surfaces)
  .find(({ applicationId }) => applicationId === originalApplicationId)
assert.equal(observations.observedTheme.canvasColor, 'white')
assert.equal(resolveAppletTheme(observations.observedTheme), observations.observedTheme)
await act(async () => {
  root.render(h(BoundEngine, { onEngine: (engine) => { observations.currentEngine = engine } }, h(AppletPresentation, { scheme: 'night' })))
})
assert.equal(observations.currentEngine, originalEngine)
assert.equal(observations.observedTheme.canvasColor, 'black')
const [deck] = observations.currentEngine.compositor.surface.readChildren({ surfaceId: observations.currentEngine.rootSurfaceId })
assert.equal(deck.props.addable, true)
const deckMenu = Array.from(document.querySelectorAll('button'))
  .find((button) => button.textContent === 'Deck menu')
await act(async () => { deckMenu.click() })
assert.equal(observations.currentEngine.appletState.read({ applicationId: deck.applicationId, stateName: 'menuOpen' }), true)
assert.equal(deckMenu.getAttribute('aria-expanded'), 'true')
await act(async () => { deckMenu.click() })
assert.equal(observations.currentEngine.appletState.read({ applicationId: deck.applicationId, stateName: 'menuOpen' }), false)
await act(async () => { observations.edit('retained') })
await act(async () => {
  observations.currentEngine.compositor.surface.update({ surfaceId: originalSurface.surfaceId, hidden: true })
  observations.currentEngine.compositor.surface.update({ surfaceId: originalSurface.surfaceId, hidden: false })
})
assert.equal(observations.noteApplication.applicationId, originalApplicationId)
assert.equal(document.querySelector('output').textContent, 'retained')
const saved = observations.currentEngine.getState()
assert.equal(saved.appletState[originalApplicationId].text, 'retained')
await act(async () => { root.unmount() })
const restored = AppletEngine.create({ applet: Notebook, desktopEnvironment: environment, options: { initialState: saved } })
assert.equal(restored.rootSurfaceId, originalEngine.rootSurfaceId)
assert.equal(restored.compositor.surface.read({ surfaceId: originalSurface.surfaceId }).applicationId, originalApplicationId)
const restoredRoot = createRoot(document.getElementById('root'))
await act(async () => { restoredRoot.render(h(BoundEngine, { engine: restored }, h(AppletPresentation))) })
assert.equal(document.querySelector('output').textContent, 'retained')
assert.equal(restored.getState(), saved)
const columnState = { applicationId: originalApplicationId, stateName: 'columns' }
restored.appletState.ensure({ ...columnState, initialValue: ['product'] })
restored.appletState.ensure({
  ...columnState,
  initialValue: ['mixed'],
  adopt: (value) => value.every((column) => column === 'mixed') ? value : undefined,
  deferNotifications: true,
})
const adopted = restored.getState()
assert.equal(JSON.stringify(adopted.appletState[originalApplicationId].columns), JSON.stringify(['mixed']))
await act(async () => { restoredRoot.unmount() })
restored.destroy()

const selectionStore = createAppletStateStore({ applications: { note: observations.noteApplication } })
function Selection({ catalogue }) {
  const [columns] = AppletEngine.useState(catalogue, 'selectedColumns', {
    adopt: (value) => value.every((column) => catalogue.includes(column)) ? value : undefined,
  })
  return h('output', null, columns.join(','))
}
const selection = (catalogue) => h(AppletStateStoreContext.Provider, { value: selectionStore },
  h(AppletEngine.Application, { application: observations.noteApplication },
    h(Selection, { catalogue, key: catalogue.join(',') }),
  ),
)
const selectionRoot = createRoot(document.getElementById('root'))
const errors = []
const originalError = console.error
console.error = (...args) => errors.push(args)
try {
  await act(async () => { selectionRoot.render(selection(['product'])) })
  await act(async () => { selectionRoot.render(selection(['mixed'])) })
  assert.equal(document.querySelector('output').textContent, 'mixed')
  assert.equal(JSON.stringify(selectionStore.snapshot(observations.noteApplication.applicationId)), JSON.stringify({ selectedColumns: ['mixed'] }))
  assert.deepEqual(errors, [])
} finally {
  await act(async () => { selectionRoot.unmount() })
  console.error = originalError
}
dom.window.close()
console.log('Packed ESM entries, stock Applet UI, independent Applet tree, shared React/context, identity, state, replacement adoption, raw state restoration, live consumer scheme material passed.')
