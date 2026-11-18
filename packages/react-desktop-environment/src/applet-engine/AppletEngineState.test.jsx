/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'
import * as compositor from '../compositor/index.js'
import * as ui from '../ui/index.js'
import * as windowManager from '../window-manager/index.js'
import AppletEngine from './AppletEngine.jsx'
import { DEFAULT_APPLET_THEME } from '../ui/applet/AppletTheme.jsx'

const desktopEnvironment = Object.freeze({ compositor, ui, windowManager })

function RootApplet() {}
RootApplet.meta = Object.freeze({ applicationName: 'root' })
function ChildApplet() {}
ChildApplet.meta = Object.freeze({ applicationName: 'child' })
ChildApplet.applets = Object.freeze({})
RootApplet.applets = Object.freeze({ child: ChildApplet })

function idFactory(prefix) {
  const observations = { sequence: 0 }
  return (kind) => `${kind}:${prefix}-${++observations.sequence}`
}

function createEngine(options = {}) {
  return AppletEngine.create({
    applet: RootApplet,
    desktopEnvironment,
    options: {
      createId: idFactory('test'),
      ...options,
    },
  })
}

describe('native Applet state', () => {
  it('dumps the native stores and restores headless state with no Surface present', () => {
    const source = createEngine()
    const parent = source.runtime.createApplicationInstance({ applicationName: 'root' })
    const child = source.runtime.childApplication(parent, 'child')
    const subject = { applicationId: child.applicationId, stateName: 'answer' }
    source.appletState.write({ ...subject, value: 42 })
    source.compositor.surface.readControls({ surfaceId: source.rootSurfaceId }).close()
    const window = source.windowManager.window.add({ window: source.windowManager.window.create({}) })
    const saved = source.getState()
    expect(saved.compositor).toBe(source.compositor.getSnapshot())
    expect(saved.windowManager).toBe(source.windowManager.getSnapshot())
    expect(saved.appletState).toBe(source.appletState.getSnapshot())
    expect(saved.compositor.surfaces).toEqual({})

    const input = JSON.parse(JSON.stringify(saved))
    const { compositor, windowManager, appletState } = input
    const restored = createEngine({ initialState: input })
    expect(restored.getState()).toBe(input)
    expect(restored.compositor.getSnapshot()).toBe(compositor)
    expect(restored.windowManager.getSnapshot()).toBe(windowManager)
    expect(restored.appletState.getSnapshot()).toBe(appletState)
    const restoredParent = restored.compositor.application.read(parent)
    expect(restored.runtime.childApplication(restoredParent, 'child').applicationId).toBe(child.applicationId)
    expect(restored.appletState.read(subject)).toBe(42)
    expect(restored.windowManager.window.read(window)).toEqual(window)
    expect(restored.getState()).toEqual(saved)
    const value = { answer: 43 }
    restored.appletState.write({ ...subject, value })
    expect(input.appletState[child.applicationId].answer).toBe(value)
    restored.windowManager.window.remove(window)
    expect(input.windowManager.windows[window.windowId]).toBeUndefined()
    restored.destroy()
    source.destroy()
  })

  it('restores an occurrence root after movement into another theme root', () => {
    function Origin() {}
    Origin.meta = Object.freeze({
      applicationName: 'origin',
      theme: Object.freeze({
        ...DEFAULT_APPLET_THEME,
        backgroundColor: 'red',
        reconcile: (identity, scheme) => ({ ...identity, canvasColor: scheme }),
      }),
    })
    function Destination() {}
    Destination.meta = Object.freeze({
      applicationName: 'destination',
      theme: Object.freeze({ ...DEFAULT_APPLET_THEME, backgroundColor: 'blue' }),
    })
    function Root() {}
    Root.meta = Object.freeze({ applicationName: 'root' })
    Root.applets = Object.freeze({
      child: ChildApplet,
      origin: Origin,
      destination: Destination,
    })
    const create = (options = {}, scheme = 'day') => AppletEngine.create({
      applet: Root,
      desktopEnvironment,
      options,
      scheme,
    })
    const source = create()
    const observations = {}
    try {
      const open = (applicationName, ownerSurfaceId) => {
        const application = source.runtime.createApplicationInstance({ applicationName })
        return source.runtime.createReferenceSurface({
          applicationId: application.applicationId,
          ownerSurfaceId,
        })
      }
      const origin = open('root/origin', source.rootSurfaceId)
      const destination = open('root/destination', source.rootSurfaceId)
      const child = open('root/child', origin.surfaceId)
      source.runtime.writeSurfaceProps({ surfaceId: child.surfaceId, props: { themeRoot: 'root/origin' } })
      source.compositor.surface.readControls({ surfaceId: child.surfaceId })
        .reparent(destination.surfaceId)
      const initialState = source.getState()
      expect(initialState.compositor.surfaces[child.surfaceId].props.themeRoot)
        .toBe('root/origin')

      observations.restored = create({ initialState }, 'night')
      const occurrence = observations.restored.compositor.surface.read({ surfaceId: child.surfaceId })
      expect(occurrence.window.parentWindowId).toBe(destination.windowId)
      expect(occurrence.props.themeRoot).toBe('root/origin')
      expect(observations.restored.getState()).toEqual(initialState)
    } finally {
      observations.restored?.compositor.destroy()
      source.compositor.destroy()
    }
  })

  it('keeps a permanent Application state when its last Surface closes', () => {
    const engine = createEngine()
    const application = engine.runtime.childApplication(
      engine.applicationInstances.root, 'child',
    )
    const open = () => engine.runtime.createReferenceSurface({
      applicationId: application.applicationId,
      ownerSurfaceId: engine.rootSurfaceId,
    })
    const first = open()
    const state = { applicationId: application.applicationId, stateName: 'title' }
    engine.appletState.write({ ...state, value: 'kept' })

    engine.compositor.surface.readControls({ surfaceId: first.surfaceId }).close()

    expect(engine.appletState.snapshot(application.applicationId)).toEqual({ title: 'kept' })
    expect(engine.getState().compositor.applications[application.applicationId]).toEqual(application)
    open()
    expect(engine.appletState.ensure({ ...state, initialValue: 'fresh' })).toBe('kept')
  })

  it('keeps a dynamic child state when its Surface closes', () => {
    const engine = createEngine()
    const parent = engine.runtime.createApplicationInstance({ applicationName: 'root' })
    const parentSurface = engine.runtime.createReferenceSurface({
      applicationId: parent.applicationId, ownerSurfaceId: engine.rootSurfaceId,
    })
    const child = engine.runtime.childApplication(parent, 'child')
    const childSurface = engine.runtime.createReferenceSurface({
      applicationId: child.applicationId, ownerSurfaceId: parentSurface.surfaceId,
    })
    ;[parent, child].forEach((application) => {
      engine.appletState.write({
        applicationId: application.applicationId, stateName: 'title', value: 'saved',
      })
    })

    engine.compositor.surface.readControls({ surfaceId: childSurface.surfaceId }).close()

    expect(engine.appletState.snapshot(child.applicationId)).toEqual({ title: 'saved' })
    expect(engine.appletState.snapshot(parent.applicationId)).toEqual({ title: 'saved' })
    expect(engine.runtime.childApplication(parent, 'child').applicationId)
      .toBe(child.applicationId)
  })

  it('keeps state through reparenting and until the last Surface closes', () => {
    const engine = createEngine()
    const application = engine.runtime.childApplication(engine.applicationInstances.root, 'child')
    const first = engine.runtime.createReferenceSurface({
      applicationId: application.applicationId, ownerSurfaceId: engine.rootSurfaceId,
    })
    const second = engine.runtime.createReferenceSurface({
      applicationId: application.applicationId, ownerSurfaceId: engine.rootSurfaceId,
    })
    engine.appletState.write({
      applicationId: application.applicationId, stateName: 'title', value: 'saved',
    })
    engine.compositor.surface.readControls({ surfaceId: first.surfaceId })
      .reparent(second.surfaceId)
    expect(engine.appletState.snapshot(application.applicationId)).toEqual({ title: 'saved' })
    engine.compositor.surface.readControls({ surfaceId: first.surfaceId }).close()
    expect(engine.appletState.snapshot(application.applicationId)).toEqual({ title: 'saved' })
  })

  it('dumps the root Surface and its linked records', () => {
    const engine = createEngine()
    engine.appletState.write({
      applicationId: engine.rootApplicationId,
      stateName: 'selection',
      value: 'saved',
    })

    const state = engine.getState()
    expect(state.compositor.surfaces[state.rootSurfaceId].applicationId).toBe(engine.rootApplicationId)
    expect(state.windowManager.windows[state.rootWindowId].parentWindowId).toBeNull()
    expect(state.appletState[engine.rootApplicationId]).toEqual({ selection: 'saved' })
  })

  it('orders multiple Surfaces of the Root Application consistently through save and adoption', () => {
    const source = createEngine()
    const observations = {}
    try {
      source.runtime.createReferenceSurface({
        applicationId: source.rootApplicationId,
        ownerSurfaceId: source.rootSurfaceId,
      })
      const submitted = source.getState()
      observations.restored = createEngine({ initialState: submitted })
      expect(observations.restored.getState()).toEqual(submitted)
    } finally {
      observations.restored?.compositor.destroy()
      source.compositor.destroy()
    }
  })

  it('restores recognized named state and lets owners default missing state', () => {
    const source = createEngine()
    source.appletState.write({
      applicationId: source.rootApplicationId,
      stateName: 'selection',
      value: 'saved',
    })
    const initialState = source.getState()
    const restored = createEngine({ initialState })

    expect(restored.appletState.ensure({
      applicationId: restored.rootApplicationId,
      initialValue: 'default',
      stateName: 'selection',
    })).toBe('saved')
    expect(restored.appletState.ensure({
      applicationId: restored.rootApplicationId,
      initialValue: 'default',
      stateName: 'newChoice',
    })).toBe('default')
    expect(restored.getState().appletState[restored.rootApplicationId]).toEqual({
      selection: 'saved',
    })
  })

  it('lets the compositor resolve saved Application names against the supplied registry', () => {
    const saved = createEngine().getState()
    const applications = { ...saved.compositor.applications, obsolete: { applicationId: 'obsolete', applicationName: 'unregistered' } }
    expect(() => createEngine({ initialState: { ...saved, compositor: { ...saved.compositor, applications } } }))
      .toThrow('Unknown registered application')
  })

  it('reads live Application props directly', () => {
    const engine = createEngine()
    const onActivate = vi.fn()
    const application = engine.runtime.createApplicationInstance({
      applicationName: 'root',
      props: { onActivate },
    })
    engine.runtime.createReferenceSurface({
      applicationId: application.applicationId,
      ownerSurfaceId: engine.rootSurfaceId,
      workspaceId: 'root',
    })

    expect(engine.getState().compositor.applications[application.applicationId].props.onActivate).toBe(onActivate)
  })

})
