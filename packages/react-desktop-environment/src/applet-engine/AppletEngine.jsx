import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import AppletEnvironment from './AppletEnvironment.jsx'
import Deck from './Deck.jsx'
import {
  AppletApplicationContext,
  AppletStateStoreContext,
  createAppletStateStore,
  immutableJson,
  useAppletState,
} from './AppletState.js'
import presentedSurface, { isDeckSurface, surfacePlacementOwnerId } from './presentedSurface.js'
import createSurfaceTransfer from './surfaceTransfer.js'

const AppletEngineContext = createContext(null)
const AppletEngineOwnershipContext = createContext(false)
const applicationNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
function freezeRecord(entries) {
  const record = Object.create(null)
  entries.forEach(([key, value]) => { record[key] = value })
  return Object.freeze(record)
}

function cloneJson(value, label) {
  return immutableJson(value, label)
}

function requireApplicationSegment(value, label) {
  if (typeof value !== 'string' || !applicationNamePattern.test(value)) {
    throw new TypeError(
      `${label} must be a lowercase kebab-case application name segment`,
    )
  }
  return value
}

function createRuntimeIdFactory() {
  return (kind = 'record') => {
    const id = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
    return `${kind}:${id}`
  }
}

function collectApplicationRegistry(rootApplet) {
  const applicationRegistry = Object.create(null)
  const ancestors = new Set()

  const visit = (Applet, localName, parentPath = null) => {
    if (typeof Applet !== 'function') {
      throw new TypeError(`Invalid Applet definition: ${localName}`)
    }
    requireApplicationSegment(localName, 'Applet registry key')
    const metadataName = requireApplicationSegment(
      Applet.meta?.applicationName,
      `Applet ${localName} meta.applicationName`,
    )
    if (metadataName !== localName) {
      throw new Error(
        `Applet registry key ${localName} does not match meta.applicationName ${metadataName}`,
      )
    }
    const applicationName = parentPath
      ? `${parentPath}/${localName}`
      : localName
    if (ancestors.has(Applet)) {
      throw new Error(`Cyclic Applet definition: ${applicationName}`)
    }
    if (Object.hasOwn(applicationRegistry, applicationName)) {
      throw new Error(`Duplicate Applet definition: ${applicationName}`)
    }

    const childApplets = Applet.applets ?? {}
    if (
      typeof childApplets !== 'object'
      || childApplets === null
      || Array.isArray(childApplets)
      || ![
        null,
        Object.prototype,
      ].includes(Object.getPrototypeOf(childApplets))
    ) {
      throw new TypeError(
        `Applet ${applicationName} applets must be a plain object`,
      )
    }
    const children = Object.entries(childApplets).map(
      ([childLocalName, ChildApplet]) => {
        requireApplicationSegment(
          childLocalName,
          `Applet ${applicationName} child registry key`,
        )
        if (typeof ChildApplet !== 'function') {
          throw new TypeError(
            `Invalid Applet definition: ${applicationName}/${childLocalName}`,
          )
        }
        const childMetadataName = requireApplicationSegment(
          ChildApplet.meta?.applicationName,
          `Applet ${applicationName}/${childLocalName} meta.applicationName`,
        )
        if (childMetadataName !== childLocalName) {
          throw new Error(
            `Applet registry key ${childLocalName} does not match meta.applicationName ${childMetadataName}`,
          )
        }
        return [childLocalName, `${applicationName}/${childLocalName}`]
      },
    )
    const settingsApplet = Applet.Settings
    if (
      settingsApplet !== undefined
      && (
        typeof settingsApplet !== 'function'
        || childApplets.settings !== settingsApplet
      )
    ) {
      throw new Error(
        `Applet ${applicationName} Settings must publish its registered settings child`,
      )
    }
    applicationRegistry[applicationName] = {
      Applet,
      applicationName,
      children: freezeRecord(children),
      localName,
      parentApplicationName: parentPath,
      path: applicationName,
      settingsApplicationName: settingsApplet
        ? `${applicationName}/settings`
        : null,
    }
    ancestors.add(Applet)
    Object.entries(childApplets).forEach(([childLocalName, ChildApplet]) => {
      visit(ChildApplet, childLocalName, applicationName)
    })
    ancestors.delete(Applet)
  }

  const rootApplicationName = rootApplet?.meta?.applicationName
  if (!rootApplicationName) {
    throw new Error('The root Applet requires meta.applicationName')
  }
  visit(rootApplet, rootApplicationName)
  visit(Deck, 'deck')

  const recipesByWorkspace = new Map()
  const resolveRecipePath = (owner, value, label) => {
    if (typeof value !== 'string' || !value.length) {
      throw new TypeError(`${label} must be a relative Applet registry path`)
    }
    value.split('/').forEach((segment) => {
      requireApplicationSegment(segment, label)
    })
    const path = `${owner.applicationName}/${value}`
    if (!applicationRegistry[path]) {
      throw new Error(`Unknown recipe Applet: ${path}`)
    }
    return path
  }
  Object.values(applicationRegistry).forEach((owner) => {
    const recipes = owner.Applet.recipes ?? []
    if (!Array.isArray(recipes)) {
      throw new TypeError(`Applet ${owner.applicationName} recipes must be an array`)
    }
    recipes.forEach((source) => {
      if (
        source === null
        || typeof source !== 'object'
        || Array.isArray(source)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(source))
        || !Object.isFrozen(source)
      ) {
        throw new TypeError(`Applet ${owner.applicationName} recipes must be frozen plain objects`)
      }
      const recipe = cloneJson(source, `Applet ${owner.applicationName} recipe`)
      const name = requireApplicationSegment(recipe.name, 'Recipe name')
      if (recipe.addable !== undefined && typeof recipe.addable !== 'boolean') {
        throw new TypeError(`Recipe ${name} addable must be a boolean`)
      }
      const workspace = recipe.workspace === undefined
        ? owner.applicationName
        : resolveRecipePath(owner, recipe.workspace, 'Recipe workspace')
      const hasResidents = Object.hasOwn(recipe, 'residents')
      const hasSettings = Object.hasOwn(recipe, 'settingsOf')
      if (hasResidents === hasSettings) {
        throw new TypeError(`Recipe ${name} requires either residents or settingsOf`)
      }
      if (!Array.isArray(hasResidents ? recipe.residents : recipe.settingsOf)) {
        throw new TypeError(`Recipe ${name} ${hasResidents ? 'residents' : 'settingsOf'} must be an array`)
      }
      const residents = hasResidents
        ? recipe.residents.map((resident) => {
            if (
              resident === null
              || typeof resident !== 'object'
              || Array.isArray(resident)
            ) throw new TypeError(`Recipe ${name} residents must be plain objects`)
            if (
              resident.state !== undefined
              && (
                resident.state === null
                || typeof resident.state !== 'object'
                || Array.isArray(resident.state)
              )
            ) throw new TypeError(`Recipe ${name} resident state must be a plain object`)
            return {
              applet: resolveRecipePath(owner, resident.applet, `Recipe ${name} resident`),
              ...(resident.state === undefined ? {} : { state: resident.state }),
            }
          })
        : collectSettingsContributions(applicationRegistry, recipe.settingsOf.map(
            (container) => resolveRecipePath(owner, container, `Recipe ${name} settingsOf`),
          )).map(({ applicationName }) => ({ applet: applicationName }))
      if (new Set(residents.map(({ applet }) => applet)).size !== residents.length) {
        throw new Error(`Recipe ${name} must name each resident once`)
      }
      const workspaceRecipes = recipesByWorkspace.get(workspace) ?? []
      if (workspaceRecipes.some(({ recipe }) => recipe.name === name)) {
        throw new Error(`Duplicate recipe ${name} for Workspace ${workspace}`)
      }
      workspaceRecipes.push({
        owner: owner.applicationName,
        recipe: cloneJson({ name, residents, ...(recipe.addable === undefined ? {} : { addable: recipe.addable }) }, `Recipe ${name}`),
      })
      recipesByWorkspace.set(workspace, workspaceRecipes)
    })
  })
  Object.values(applicationRegistry).forEach((node) => {
    node.recipes = Object.freeze((recipesByWorkspace.get(node.applicationName) ?? [])
      .sort((first, second) => second.owner.split('/').length - first.owner.split('/').length)
      .map(({ recipe }) => recipe))
    Object.freeze(node)
  })
  return Object.freeze(applicationRegistry)
}

function resolveRegistryNode(applicationRegistry, nodeOrApplicationName) {
  if (typeof nodeOrApplicationName === 'function') {
    return Object.values(applicationRegistry).find(
      ({ Applet }) => Applet === nodeOrApplicationName,
    )
  }
  const applicationName = typeof nodeOrApplicationName === 'string'
    ? nodeOrApplicationName
    : nodeOrApplicationName?.applicationName
      ?? nodeOrApplicationName?.meta?.applicationName
      ?? nodeOrApplicationName?.path
  return typeof applicationName === 'string'
    ? applicationRegistry[applicationName]
    : undefined
}

function collectSettingsContributions(applicationRegistry, ownerNodes) {
  if (!Array.isArray(ownerNodes)) {
    throw new TypeError('Settings contribution owners must be an array')
  }
  const contributions = []
  const settingsApplicationNames = new Set()

  ownerNodes.forEach((ownerNode) => {
    const containerNode = resolveRegistryNode(applicationRegistry, ownerNode)
    if (!containerNode) {
      throw new Error('Unknown Settings contribution owner')
    }
    Object.values(containerNode.children).forEach((applicationName) => {
      const publisherNode = applicationRegistry[applicationName]
      const settingsApplicationName = publisherNode?.settingsApplicationName
      if (
        !settingsApplicationName
        || settingsApplicationNames.has(settingsApplicationName)
      ) return
      const settingsNode = applicationRegistry[settingsApplicationName]
      if (!settingsNode) {
        throw new Error(
          `Missing registered Settings contribution: ${settingsApplicationName}`,
        )
      }
      settingsApplicationNames.add(settingsApplicationName)
      contributions.push(settingsNode)
    })
  })

  return Object.freeze(contributions)
}

function resolveRootApplet(rootApplet, fallbackApplet) {
  const resolved = rootApplet ?? fallbackApplet
  if (typeof resolved !== 'function') throw new TypeError('RootApplet must be an Applet function')
  return resolved
}

function ReferenceSurface({ children }) {
  return children
}

function constructAppletRuntime({
  applet,
  desktopEnvironment,
  options = {},
  resetRootApplet,
  rootApplet,
}) {
  const createWindowManager = desktopEnvironment?.windowManager
    ?.createWindowManager
  const createCompositor = desktopEnvironment?.compositor?.createCompositor

  if (typeof createWindowManager !== 'function') {
    throw new TypeError('The desktop environment requires createWindowManager')
  }
  if (typeof createCompositor !== 'function') {
    throw new TypeError('The desktop environment requires createCompositor')
  }
  if (
    options.beforeResetRootApplet !== undefined
    && typeof options.beforeResetRootApplet !== 'function'
  ) {
    throw new TypeError('options.beforeResetRootApplet must be a function')
  }

  const RootApplet = resolveRootApplet(rootApplet, applet)
  if (Object.hasOwn(options, 'applicationRegistry')) {
    throw new Error(
      'options.applicationRegistry is not supported; register children through Applet.applets',
    )
  }
  const applicationRegistry = collectApplicationRegistry(applet)
  const initialState = options.initialState
  const state = initialState ?? {}
  const lifecycle = { destroyed: false, emptyDecksScheduled: false, reconcilingResidence: false }
  const reservedIds = new Set([
    ...Object.keys(state.compositor?.applications ?? {}),
    ...Object.keys(state.compositor?.surfaces ?? {}),
    ...Object.keys(state.windowManager?.windows ?? {}),
  ])
  const suppliedCreateId = options.createId ?? createRuntimeIdFactory()
  const createId = kind => {
    const id = suppliedCreateId(kind)
    if (reservedIds.has(id)) return createId(kind)
    reservedIds.add(id)
    return id
  }
  const fieldSupplies = new Map()
  const ownerKey = (supply) => {
    if (!supply || Object.keys(supply).length !== 1
      || !(supply.applicationId || supply.surfaceId)) {
      throw new TypeError('Supply requires exactly one Application or Surface identity')
    }
    const key = supply.applicationId ? 'applicationId' : 'surfaceId'
    if (typeof supply[key] !== 'string' || !supply[key].length) {
      throw new TypeError('Supply requires a nonempty owner identity')
    }
    return `${key}:${supply[key]}`
  }
  const equalValue = (first, second) => {
    if (Object.is(first, second)) return true
    if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false
    if (Array.isArray(first) !== Array.isArray(second)) return false
    return Object.keys(first).every(key => equalValue(first[key], second[key]))
      && Object.keys(second).every(key => Object.hasOwn(first, key) || second[key] === undefined)
  }
  const fieldPath = (field) => Array.isArray(field) ? field : [field]
  const fieldKey = (surfaceId, field) => JSON.stringify([surfaceId, ...fieldPath(field)])
  const readField = (record, field) => fieldPath(field).reduce(
    (value, key) => value?.[key], record,
  )
  const eligibleField = (surfaceId, field, current, supply, missing = current == null) => {
    const key = fieldKey(surfaceId, field)
    if (!supply) {
      fieldSupplies.delete(key)
      return true
    }
    const owner = ownerKey(supply)
    const previous = fieldSupplies.get(key)
    return missing || (previous?.owner === owner && equalValue(previous.value, current))
  }
  const suppliedField = (surfaceId, field, value, supply) => {
    if (!supply) return
    fieldSupplies.set(fieldKey(surfaceId, field), {
      surfaceId, field: fieldPath(field),
      owner: ownerKey(supply), supply: Object.freeze({ ...supply }), value,
    })

  }
  const rootApplicationName = applet.meta?.applicationName
  const windowManagerOptions = options.windowManager ?? {}
  const compositorOptions = options.compositor ?? {}

  const applicationComponentRegistry = freezeRecord(
    Object.values(applicationRegistry).map((node) => [
      node.applicationName,
      node.Applet,
    ]),
  )
  const surfaceComponentRegistry = Object.freeze({ window: ReferenceSurface, reference: ReferenceSurface })
  const defaultSurfaceComponentName = 'window'

  const windowManager = createWindowManager({
    ...windowManagerOptions,
    createId: windowManagerOptions.createId ?? createId,
    initialSnapshot: initialState?.windowManager ?? windowManagerOptions.initialSnapshot,
  })
  state.activeWorkspaceSurfaceId ??= null
  const suppliedConfigureSurfaceControls = compositorOptions
    .configureSurfaceControls
  const compositor = createCompositor({
    ...compositorOptions,
    initialSnapshot: initialState?.compositor ?? compositorOptions.initialSnapshot,
    applicationRegistry: applicationComponentRegistry,
    createId: compositorOptions.createId ?? createId,
    defaultSurfaceComponentName,
    retainUnreferencedApplications:
      compositorOptions.retainUnreferencedApplications ?? true,
    surfaceComponentRegistry,
    windowManager,
    configureSurfaceControls({ controls, surfaceId }) {
      const activate = () => {
        const current = compositor.surface.read({ surfaceId })
        if (!current) throw new Error(`Unknown Surface: ${surfaceId}`)
        const parentWindowId = current.window?.parentWindowId
        const parentSurface = Object.values(
          compositor.getSnapshot().surfaces,
        ).find(({ windowId }) => windowId === parentWindowId)
        if (!parentSurface) return controls.show()
        fieldSupplies.delete(fieldKey(parentSurface.surfaceId, 'selectedChildSurfaceId'))
        return compositor.surface.activateChild({
          childSurfaceId: surfaceId,
          surfaceId: parentSurface.surfaceId,
        })
      }
      const reparent = (parentSurfaceId) => {
        const current = compositor.surface.read({ surfaceId })
        const parent = compositor.surface.read({ surfaceId: parentSurfaceId })
        if (!current) throw new Error(`Unknown Surface: ${surfaceId}`)
        if (!parent) throw new Error(`Unknown parent Surface: ${parentSurfaceId}`)
        windowManager.window.move({
          parentWindowId: parent.windowId,
          windowId: current.windowId,
        })
        compositor.surface.update({
          surfaceId,
          props: {
            ...current.props,
            ownerSurfaceId: parentSurfaceId,
          },
        })
        return compositor.surface.read({ surfaceId })
      }
      const fullscreen = (geometry) => {
        controls.fullscreen(geometry)
        const fullscreenSurface = compositor.surface.read({ surfaceId })
        const ownerSurfaceId = fullscreenSurface?.props?.ownerSurfaceId
        if (!ownerSurfaceId) return fullscreenSurface
        fieldSupplies.delete(fieldKey(ownerSurfaceId, 'selectedChildSurfaceId'))
        return compositor.surface.activateChild({
          childSurfaceId: surfaceId,
          surfaceId: ownerSurfaceId,
        })
      }
      const resize = (geometry, { supply } = {}) => {
        const current = compositor.surface.read({ surfaceId })
        const fields = ['size', 'position'].filter((field) => (
          geometry?.[field] !== undefined
          && eligibleField(surfaceId, field, current?.[field], supply)
        ))
        if (!fields.length) return current
        const result = controls.resize({
          position: current.position,
          size: current.size,
          ...Object.fromEntries(fields.map((field) => [field, geometry[field]])),
        })
        const resized = compositor.surface.read({ surfaceId })
        fields.forEach((field) => { suppliedField(surfaceId, field, resized[field], supply) })

        return result
      }
      const selectChild = (childSurfaceId) => runtime.selectChild({ surfaceId, childSurfaceId })
      const move = (...args) => {
        fieldSupplies.delete(fieldKey(surfaceId, 'position'))
        return controls.move(...args)
      }
      const extendedControls = Object.freeze({
        ...controls,
        activate,
        fullscreen,
        reparent,
        resize,
        selectChild,
        move,
      })
      return {
        activate,
        fullscreen,
        reparent,
        focus: controls.focus,
        hide: controls.hide,
        show: controls.show,
        move,
        resize,
        exitFullscreen: controls.exitFullscreen,
        selectChild,
        ...(suppliedConfigureSurfaceControls?.({
          controls: extendedControls,
          surfaceId,
        }) ?? {}),
      }
    },
  })
  const applicationInstances = Object.create(null)
  if (initialState) {
    Object.entries(initialState.applicationIds).forEach(([name, applicationId]) => {
      applicationInstances[name] = compositor.application.read({ applicationId })
    })
  } else {
    const rootWindow = windowManager.window.add({
      window: windowManager.window.create({
        ...options.rootWindow,
        windowId: options.rootWindow?.windowId ?? createId('window'),
      }),
    })
    const rootApplication = compositor.application.add({
      application: compositor.application.create({
        applicationId: createId('application'),
        applicationName: rootApplicationName,
        props: options.rootApplicationProps,
      }),
    })
    const rootSurface = compositor.surface.add({
      surface: compositor.surface.create({
        surfaceId: createId('surface'),
        applicationId: rootApplication.applicationId,
        props: {},
        surfaceComponentName: defaultSurfaceComponentName,
        windowId: rootWindow.windowId,
        workspaceId: options.rootWorkspaceId ?? rootApplicationName,
      }),
    })
    state.rootSurfaceId = rootSurface.surfaceId
    state.rootWindowId = rootWindow.windowId
    applicationInstances[rootApplicationName] = rootApplication
    Object.keys(applicationRegistry).forEach((applicationName) => {
      if (applicationName === rootApplicationName) return
      applicationInstances[applicationName] = compositor.application.add({
        application: compositor.application.create({
          applicationId: createId('application'),
          applicationName,
        }),
      })
    })
  }
  const { rootSurfaceId, rootWindowId } = state
  state.appletState ??= {}
  const appletState = createAppletStateStore({ applications: compositor.getSnapshot().applications, initialState: state.appletState })
  const applicationIds = initialState?.applicationIds ?? Object.freeze(Object.fromEntries(
    Object.entries(applicationInstances).map(([name, application]) => [name, application.applicationId]),
  ))
  state.applicationIds = applicationIds
  const connectApplicationChildren = (parent, children) => {
    if (!Object.keys(children).length) return parent
    return compositor.application.update({ applicationId: parent.applicationId, props: {
      ...parent.props,
      childApplicationIds: { ...children, ...parent.props.childApplicationIds },
    } })
  }
  if (!initialState) {
    Object.entries(applicationRegistry).forEach(([name, node]) => {
      applicationInstances[name] = connectApplicationChildren(applicationInstances[name],
        Object.fromEntries(Object.entries(node.children).map(([key, child]) => [key, applicationIds[child]])))
    })
  }
  const createApplicationBranch = (applicationName, {
    props,
    savedState,
    supplied = false,
  } = {}) => {
    const node = applicationRegistry[applicationName]
    if (!node) throw new Error(`Unknown Applet application: ${applicationName}`)
    const application = compositor.application.add({
      application: compositor.application.create({
        applicationName,
        props,
        ...(supplied ? { applicationId: createId('application') } : {}),
      }),
    })
    appletState.addApplication(application, {
      savedState,
      ...(supplied && savedState ? { supply: { applicationId: application.applicationId } } : {}),
    })
    const children = Object.fromEntries(Object.entries(node.children).map(([name, childName]) => [
      name, props?.childApplicationIds?.[name] ?? createApplicationBranch(childName, {
        supplied,
      }).applicationId,
    ]))
    const parent = connectApplicationChildren(application, children)
    return parent
  }
  const anchorSurfaces = new Map()
  const resolveApplicationNode = (applicationOrName) => (
    resolveRegistryNode(applicationRegistry, applicationOrName)
  )

  const supplyOccurrence = (surfaceId, supply) => {
    ownerKey(supply)
    const surface = compositor.surface.read({ surfaceId })
    const fields = ['position', 'size', 'selectedChildSurfaceId', 'fullscreen', ['props', 'order']]
    fields.forEach((field) => {
      const value = readField(surface, field)
      if (value != null) suppliedField(surfaceId, field, value, supply)
    })

  }
  const retainedDecks = new Map()
  const emptyDecks = new Set()
  const queryEngine = () => ({ compositor, runtime })
  const readChildStack = ({ surfaceId, fullscreen } = {}) => {
    if (!compositor.surface.read({ surfaceId })) return []
    const selected = compositor.surface.read({ surfaceId }).selectedChildSurfaceId
    return compositor.surface.readChildren({ surfaceId })
      .filter((surface) => fullscreen === undefined || surface.fullscreen === fullscreen)
      .toSorted((first, second) => (
        first.surfaceId === selected ? -1 : second.surfaceId === selected ? 1 : second.zIndex - first.zIndex
      ))
  }
  const readSelectedChild = ({ surfaceId, fullscreen } = {}) => {
    const owner = compositor.surface.read({ surfaceId })
    if (!owner) return null
    const held = [...(retainedDecks.get(surfaceId) ?? [])]
      .find(({ selectedSurfaceId }) => selectedSurfaceId)
    const resident = held && compositor.surface.read({ surfaceId: held.selectedSurfaceId })
    if (resident?.props?.resident?.containerSurfaceId === surfaceId) return resident
    const selected = compositor.surface.readSelectedChild({ surfaceId })
    if (selected && (fullscreen === undefined || selected.fullscreen === fullscreen)) return selected
    return readChildStack({ surfaceId, fullscreen })[0] ?? null
  }
  const reconcileSelections = (previous) => {
    Object.values(compositor.getSnapshot().surfaces).forEach((owner) => {
      const oldOwner = previous?.surfaces[owner.surfaceId]
      const oldSelection = previous?.surfaces[oldOwner?.selectedChildSurfaceId]
      const oldChild = oldSelection && compositor.surface.read({ surfaceId: oldSelection.surfaceId })
      const departed = oldSelection && (
        !oldChild || oldChild.window.parentWindowId !== owner.windowId
        || (oldSelection.fullscreen && !oldChild.fullscreen)
      )
      const arrived = compositor.surface.readChildren({ surfaceId: owner.surfaceId }).some((child) => (
        previous?.surfaces[child.surfaceId]?.window.parentWindowId !== owner.windowId
      ))
      if (!departed && (owner.selectedChildSurfaceId != null || !arrived)) return
      const mountedDeparture = departed && oldSelection.fullscreen
      const selected = readSelectedChild({
        surfaceId: owner.surfaceId,
        ...(mountedDeparture ? { fullscreen: true } : {}),
      })
      if (selected && selected.window.parentWindowId !== owner.windowId) return
      const childSurfaceId = selected?.surfaceId ?? null
      if (childSurfaceId === owner.selectedChildSurfaceId) return
      compositor.surface.selectChild({ surfaceId: owner.surfaceId, childSurfaceId })
      if (departed || retainedDecks.has(owner.surfaceId)) fieldSupplies.delete(fieldKey(owner.surfaceId, 'selectedChildSurfaceId'))
      else suppliedField(owner.surfaceId, 'selectedChildSurfaceId', childSurfaceId, { surfaceId: owner.surfaceId })
    })
  }
  const flushEmptyDecks = () => {
    lifecycle.emptyDecksScheduled = false
    if (lifecycle.destroyed) return
    emptyDecks.forEach((surfaceId) => {
      if (retainedDecks.get(surfaceId)?.size) return
      emptyDecks.delete(surfaceId)
      const surface = compositor.surface.read({ surfaceId })
      if (!surface || !isDeckSurface({ engine: queryEngine(), surface })
        || Array.isArray(surface.props?.recipe?.residents)
        || compositor.surface.readChildren({ surfaceId }).length) return
      compositor.surface.readControls({ surfaceId }).close()
    })
  }
  const scheduleEmptyDecks = () => {
    if (lifecycle.emptyDecksScheduled || lifecycle.destroyed) return
    lifecycle.emptyDecksScheduled = true
    queueMicrotask(flushEmptyDecks)
  }
  const retainDeck = (surfaceId, { selectedSurfaceId } = {}) => {
    const holds = retainedDecks.get(surfaceId) ?? new Set()
    const hold = { selectedSurfaceId }
    holds.add(hold)
    retainedDecks.set(surfaceId, holds)
    return () => {
      if (!holds.delete(hold)) return
      if (!holds.size) retainedDecks.delete(surfaceId)
      reconcileResidence()
      scheduleEmptyDecks()
    }
  }
  const runtime = Object.freeze({
    readChildStack,
    readSelectedChild,
    presentedSurface({ surfaceId }) {
      return presentedSurface({ engine: queryEngine(), surface: compositor.surface.read({ surfaceId }) })
    },
    isDeckSurface({ surfaceId }) {
      return isDeckSurface({ engine: queryEngine(), surface: compositor.surface.read({ surfaceId }) })
    },
    surfacePlacementOwnerId({ surfaceId }) {
      return surfacePlacementOwnerId({ engine: queryEngine(), surface: compositor.surface.read({ surfaceId }) })
    },
    beginPeel(options) {
      return surfaceTransfer.beginPeel(options)
    },
    mergeDeck(options) {
      return surfaceTransfer.mergeDeck(options)
    },
    activeWorkspaceSurface() {
      return state.activeWorkspaceSurfaceId
        ? compositor.surface.read({ surfaceId: state.activeWorkspaceSurfaceId })
          ?? null
        : null
    },
    activateWorkspaceSurface({ surfaceId, supply }) {
      const surface = compositor.surface.read({ surfaceId })
      if (!surface) throw new Error(`Unknown Workspace Surface: ${surfaceId}`)
      if (!eligibleField(rootSurfaceId, 'activeWorkspace', state.activeWorkspaceSurfaceId,
        supply, !compositor.surface.read({ surfaceId: state.activeWorkspaceSurfaceId }))) return surface
      state.activeWorkspaceSurfaceId = surfaceId
      if (supply) {
        fieldSupplies.set(fieldKey(rootSurfaceId, 'activeWorkspace'), {
          surfaceId: rootSurfaceId, field: ['activeWorkspace'],
          owner: ownerKey(supply), supply: Object.freeze({ ...supply }), value: surfaceId,
        })
      }

      return surface
    },
    selectChild({ surfaceId, childSurfaceId, supply }) {
      const surface = compositor.surface.read({ surfaceId })
      const selected = compositor.surface.read({ surfaceId: surface?.selectedChildSurfaceId })
      if (!eligibleField(surfaceId, 'selectedChildSurfaceId', surface?.selectedChildSurfaceId,
        supply, !selected || selected.window.parentWindowId !== surface.windowId)) return surface
      const alreadyVisible = selected && !selected.hidden && !compositor.surface.readChildren({ surfaceId })
        .some((child) => child.fullscreen === selected.fullscreen && child.zIndex > selected.zIndex)
      if (!supply && surface.selectedChildSurfaceId === childSurfaceId
        && (childSurfaceId == null || alreadyVisible)) return surface
      if (supply || childSurfaceId == null) {
        compositor.surface.selectChild({ surfaceId, childSurfaceId })
      } else {
        compositor.surface.activateChild({ surfaceId, childSurfaceId })
      }
      suppliedField(surfaceId, 'selectedChildSurfaceId', childSurfaceId, supply)

      return compositor.surface.read({ surfaceId })
    },
    selectionSupply({ surfaceId }) {
      const current = compositor.surface.read({ surfaceId })?.selectedChildSurfaceId
      const supplied = fieldSupplies.get(fieldKey(surfaceId, 'selectedChildSurfaceId'))
      return supplied && supplied.value === current ? supplied.supply : undefined
    },
    applicationForNode(nodeOrApplicationName) {
      const node = resolveApplicationNode(nodeOrApplicationName)
      return node ? applicationInstances[node.applicationName] : undefined
    },
    childApplication(parentApplication, localName) {
      if (!parentApplication?.applicationId) {
        throw new TypeError('childApplication requires a parent application')
      }
      requireApplicationSegment(localName, 'Child application localName')
      const parentNode = resolveApplicationNode(parentApplication)
      if (!parentNode) {
        throw new Error(
          `Unknown registered application: ${parentApplication.applicationName}`,
        )
      }
      const childApplicationName = parentNode.children[localName]
      if (!childApplicationName) {
        throw new Error(
          `Unknown child application ${localName} of ${parentNode.applicationName}`,
        )
      }
      const childApplicationId = compositor.application.read(parentApplication)?.props.childApplicationIds?.[localName]
      if (!childApplicationId) {
        throw new Error(
          `Missing child application ${localName} of ${parentApplication.applicationId}`,
        )
      }
      return compositor.application.read({ applicationId: childApplicationId })
    },
    createApplicationInstance({
      applicationId,
      applicationName,
      cloneState = false,
      props,
    } = {}) {
      const source = applicationId
        ? compositor.application.read({ applicationId })
        : null
      const application = createApplicationBranch(
        applicationName ?? source?.applicationName,
        {
          props,
          savedState: source && cloneState
            ? appletState.snapshot(source.applicationId)
            : undefined,
        },
      )

      return application
    },
    retainApplicationInstance({ applicationId }) {
      return compositor.application.read({ applicationId })
    },
    ensureAnchorSurface({
      applicationId,
      key,
      workspaceId,
    }) {
      const existing = anchorSurfaces.get(key) ?? Object.values(
        compositor.getSnapshot().surfaces,
      ).find((surface) => (
        surface.applicationId === applicationId
        && surface.workspaceId === workspaceId
        && surface.window?.parentWindowId === null
        && surface.surfaceId !== rootSurfaceId
      ))
      if (existing && compositor.surface.read({
        surfaceId: existing.surfaceId,
      })) {
        anchorSurfaces.set(key, existing)
        reconcileResidence()
        return compositor.surface.read({ surfaceId: existing.surfaceId })
      }

      const window = windowManager.window.add({
        window: windowManager.window.create({
          windowId: createId('window'), parentWindowId: null,
        }),
      })
      const surface = compositor.surface.add({
        surface: compositor.surface.create({
          surfaceId: createId('surface'),
          applicationId,
          props: {},
          surfaceComponentName: 'reference',
          windowId: window.windowId,
          workspaceId,
        }),
      })
      anchorSurfaces.set(key, surface)
      supplyOccurrence(surface.surfaceId, { applicationId: applicationIds[rootApplicationName] })
      reconcileResidence()

      return compositor.surface.read({ surfaceId: surface.surfaceId })
    },
    createReferenceSurface({
      applicationId,
      hidden = false,
      ownerSurfaceId,
      position,
      size,
      surfaceProps,
      supply,
      workspaceId,
    }) {
      if (supply) ownerKey(supply)
      const ownerSurface = compositor.surface.read({
        surfaceId: ownerSurfaceId,
      })
      if (!ownerSurface) {
        throw new Error(`Unknown reference-surface owner: ${ownerSurfaceId}`)
      }
      if (supply) ownerKey(supply)
      const window = windowManager.window.add({
        window: windowManager.window.create({
          ...(supply ? { windowId: createId('window') } : {}),
          parentWindowId: ownerSurface.windowId,
        }),
      })
      try {
        const surface = compositor.surface.add({
          surface: compositor.surface.create({
            ...(supply ? { surfaceId: createId('surface') } : {}),
            applicationId,
            hidden,
            position,
            props: {
              ...surfaceProps,
              ownerSurfaceId,
            },
            size,
            surfaceComponentName: 'reference',
            windowId: window.windowId,
            workspaceId: workspaceId ?? ownerSurface.workspaceId,
          }),
        })
        if (supply) supplyOccurrence(surface.surfaceId, supply)
        reconcileResidence()
        return compositor.surface.read({ surfaceId: surface.surfaceId })
      } catch (error) {
        windowManager.window.remove({ windowId: window.windowId })
        throw error
      }
    },
    writeSurfaceProps({ surfaceId, props, supply }) {
      const current = compositor.surface.read({ surfaceId })
      if (!current) throw new Error(`Unknown Surface: ${surfaceId}`)
      const entries = Object.entries(props).filter(([key]) => eligibleField(
        surfaceId, ['props', key], current.props[key], supply, !Object.hasOwn(current.props, key),
      ))
      if (!entries.length) return current
      const nextProps = { ...current.props, ...Object.fromEntries(entries) }
      const updated = compositor.surface.update({ surfaceId, props: nextProps })
      entries.forEach(([key, value]) => {
        suppliedField(surfaceId, ['props', key], value, supply)
      })
      return updated
    },
    resolveApplicationNode,

  })

  const surfaceTransfer = createSurfaceTransfer({
    compositor,
    runtime,
    retainDeck,
    restoreSelection({ surfaceId, childSurfaceId }) {
      fieldSupplies.delete(fieldKey(surfaceId, 'selectedChildSurfaceId'))
      return compositor.surface.selectChild({ surfaceId, childSurfaceId })
    },
  })

  const restoredResidence = new Set(Object.keys(initialState?.compositor.surfaces ?? {}))
  function reconcileResidence() {
    if (lifecycle.reconcilingResidence) return
    lifecycle.reconcilingResidence = true
    try {
      const pending = new Set(Object.keys(compositor.getSnapshot().surfaces))
      pending.forEach(containerSurfaceId => {
        const container = compositor.surface.read({ surfaceId: containerSurfaceId })
        if (!container) return
        const node = applicationRegistry[container.application.applicationName]
        const deck = node.Applet === Deck
        const recipeResidents = deck && Array.isArray(container.props?.recipe?.residents)
          ? container.props.recipe.residents
          : null
        if (deck && recipeResidents === null) return
        const requests = deck
          ? recipeResidents.filter((resident) => applicationRegistry[resident.applet])
            .map((resident, order) => ({
              applicationName: resident.applet,
              key: resident.applet,
              order,
              savedState: resident.state,
              surfaceProps: {},
            }))
          : node.recipes.map((recipe, order) => ({
              applicationName: 'deck',
              key: recipe.name,
              order,
              surfaceProps: { recipe, addable: recipe.addable ?? false, unmountable: false },
            }))
        if (!deck && !requests.length) return
        const desiredKeys = new Set(requests.map(({ key }) => key))
        Object.values(compositor.getSnapshot().surfaces).forEach((resident) => {
          if (
            resident.props?.resident?.containerSurfaceId !== containerSurfaceId
            || desiredKeys.has(resident.props.resident.key)
          ) return
          compositor.surface.readControls({ surfaceId: resident.surfaceId }).close()
        })
        requests.forEach((request) => {
          if (!compositor.surface.read({ surfaceId: containerSurfaceId })) return
          const resident = Object.values(compositor.getSnapshot().surfaces).find(
            ({ props }) => props?.resident?.containerSurfaceId === containerSurfaceId
              && props.resident.key === request.key,
          )
          if (resident) {
            const supply = { surfaceId: containerSurfaceId }
            const adoptingOrder = restoredResidence.delete(resident.surfaceId)
            const suppliesOrder = adoptingOrder || eligibleField(
              resident.surfaceId, ['props', 'order'], resident.props.order, supply,
            )
            if (resident.props.order !== request.order && suppliesOrder) {
              compositor.surface.update({
                surfaceId: resident.surfaceId,
                props: { ...resident.props, order: request.order },
              })
              suppliedField(resident.surfaceId, ['props', 'order'], request.order, supply)
            } else if (adoptingOrder) {
              suppliedField(resident.surfaceId, ['props', 'order'], request.order, supply)
            }
            return
          }
          const application = createApplicationBranch(request.applicationName, {
            savedState: request.savedState,
            supplied: true,
          })
          const supplied = runtime.createReferenceSurface({
            applicationId: application.applicationId,
            ownerSurfaceId: containerSurfaceId,
            supply: { surfaceId: containerSurfaceId },
            surfaceProps: {
              ...request.surfaceProps,
              resident: { containerSurfaceId, key: request.key },
              order: request.order,
            },
          })
          if (!deck) {
            compositor.surface.update({ surfaceId: supplied.surfaceId, fullscreen: true })
            suppliedField(supplied.surfaceId, 'fullscreen', true, { surfaceId: containerSurfaceId })
          }
          const selectedId = compositor.surface.read({ surfaceId: containerSurfaceId })
            ?.selectedChildSurfaceId
          const selected = selectedId
            ? compositor.surface.read({ surfaceId: selectedId })
            : null
          if (!selected) {
            runtime.selectChild({
              surfaceId: containerSurfaceId,
              childSurfaceId: supplied.surfaceId,
              supply: { surfaceId: containerSurfaceId },
            })
          }
          pending.add(supplied.surfaceId)
        })
      })
    } finally {
      lifecycle.reconcilingResidence = false
    }
  }
  reconcileResidence()

  state.compositor = compositor.getSnapshot()
  state.windowManager = windowManager.getSnapshot()
  const unsubscribeWindows = windowManager.subscribe(() => {
    state.windowManager = windowManager.getSnapshot()
  })
  const composition = { previous: compositor.getSnapshot(), reconciling: false, pending: false }

  const unsubscribeCompositor = compositor.subscribe(() => {
    state.compositor = compositor.getSnapshot()
    if (composition.reconciling) {
      composition.pending = true

      return
    }
    composition.reconciling = true
    try {
      const reconcile = () => {
        composition.pending = false
        const current = compositor.getSnapshot()
        const previous = composition.previous
        composition.previous = current
        const surfaces = Object.values(current.surfaces)
        const previousSurfaces = Object.values(previous.surfaces)
        const removed = previousSurfaces.filter(({ surfaceId }) => !current.surfaces[surfaceId])
        Object.keys(previous.applications).forEach((applicationId) => {
          if (!current.applications[applicationId]) appletState.removeApplication({ applicationId })
        })
        Object.values(current.applications).forEach((application) => {
          if (!previous.applications[application.applicationId]) appletState.addApplication(application)
        })
        previousSurfaces.forEach((previousChild) => {
          const child = current.surfaces[previousChild.surfaceId]
          if (child?.window.parentWindowId === previousChild.window.parentWindowId) return
          const parent = surfaces.find(({ windowId }) => windowId === previousChild.window.parentWindowId)
          if (parent && isDeckSurface({ engine: queryEngine(), surface: parent })
            && !compositor.surface.readChildren({ surfaceId: parent.surfaceId }).length) {
            emptyDecks.add(parent.surfaceId)
          }
        })
        fieldSupplies.forEach((declaration, key) => {
          const { field, surfaceId } = declaration
          const surface = current.surfaces[surfaceId]
          const ownerAlive = declaration.supply.surfaceId
            ? current.surfaces[declaration.supply.surfaceId]
            : current.applications[declaration.supply.applicationId]
          const value = field.length === 1 && field[0] === 'activeWorkspace' ? state.activeWorkspaceSurfaceId : readField(surface, field)
          if (!surface || !ownerAlive || !equalValue(value, declaration.value)) fieldSupplies.delete(key)
        })
        const removedWindows = new Set(removed.map(({ windowId }) => windowId))
        const pendingWindows = removedWindows
        pendingWindows.forEach(parentWindowId => {
          previousSurfaces.forEach((child) => {
            if (child.window.parentWindowId !== parentWindowId || removedWindows.has(child.windowId)) return
            removedWindows.add(child.windowId)
            if (compositor.surface.read({ surfaceId: child.surfaceId })) {
              compositor.surface.readControls({ surfaceId: child.surfaceId }).close()
            }
          })
        })
        reconcileResidence()
        reconcileSelections(previous)
        if (emptyDecks.size) scheduleEmptyDecks()
        if (composition.pending) reconcile()
      }
      reconcile()
    } finally {
      composition.reconciling = false

    }
  })

  return Object.freeze({
    destroy() {
      if (lifecycle.destroyed) return
      surfaceTransfer.destroy()
      lifecycle.destroyed = true

      unsubscribeWindows()
      unsubscribeCompositor()


      retainedDecks.clear()
      emptyDecks.clear()
      compositor.destroy()
    },
    appletState,
    applicationInstances: Object.freeze(applicationInstances),
    applicationRegistry,
    compositor,
    desktopEnvironment,
    rootApplicationId: applicationIds[rootApplicationName],
    rootApplet: RootApplet,
    rootSurfaceId,
    rootWindowId,
    surfaceComponentRegistry,
    getState: () => state,
    ...(resetRootApplet && { reset: () => resetRootApplet({ beforeResetRootApplet: options.beforeResetRootApplet }) }),
    runtime,
    windowManager,
  })
}

function createAppletEngine({ applet, desktopEnvironment = applet.desktopEnvironment, options, resetRootApplet, rootApplet }) {
  return constructAppletRuntime({ applet, desktopEnvironment, options, resetRootApplet, rootApplet })
}

export default function AppletEngine({
  RootApplet,
  applet,
  children,
  desktopEnvironment: suppliedDesktopEnvironment,
  engine: suppliedEngine,
  onEngine,
  options,
}) {
  const inheritedEngine = useContext(AppletEngineContext)?.engine ?? null
  const inheritedDesktopEnvironment = AppletEnvironment.use()
  const desktopEnvironment = suppliedDesktopEnvironment
    ?? suppliedEngine?.desktopEnvironment ?? inheritedEngine?.desktopEnvironment
    ?? inheritedDesktopEnvironment ?? applet?.desktopEnvironment
  if (!desktopEnvironment) throw new TypeError('AppletEngine requires a desktop environment')
  const ownsEngine = !suppliedEngine && !inheritedEngine
  const hostsRuntime = !inheritedEngine || Boolean(suppliedEngine && suppliedEngine !== inheritedEngine)
  const [runtimeRevision, setRuntimeRevision] = useState(0)
  const activeRuntimeRevision = useRef(runtimeRevision)
  const resetOperation = useRef(null)
  activeRuntimeRevision.current = runtimeRevision
  const resetRootApplet = useCallback(({ beforeResetRootApplet } = {}) => {
    if (activeRuntimeRevision.current !== runtimeRevision) return Promise.resolve(false)
    if (resetOperation.current?.runtimeRevision === runtimeRevision) {
      return resetOperation.current.promise
    }
    const operation = (async () => {
      try {
        await beforeResetRootApplet?.()
        if (activeRuntimeRevision.current !== runtimeRevision) return false
        activeRuntimeRevision.current = runtimeRevision + 1
        setRuntimeRevision((current) => current === runtimeRevision ? current + 1 : current)
        return true
      } finally {
        if (resetOperation.current?.promise === operation) resetOperation.current = null
      }
    })()
    resetOperation.current = { promise: operation, runtimeRevision }
    return operation
  }, [runtimeRevision])
  const ownedRuntime = useMemo(() => {
    if (!ownsEngine) return null
    const runtimeOptions = runtimeRevision === 0
      ? options
      : { ...(options ?? {}), initialState: null }
    const engine = createAppletEngine({
      applet,
      desktopEnvironment,
      options: runtimeOptions,
      resetRootApplet,
      rootApplet: RootApplet,
    })
    return { engine, mountedEffects: 0, destroyed: false }
  }, [ownsEngine, runtimeRevision])
  const engine = suppliedEngine ?? inheritedEngine ?? ownedRuntime.engine
  useEffect(() => {
    if (engine) onEngine?.(engine)
  }, [engine, onEngine])
  useEffect(() => {
    if (!ownedRuntime) return undefined
    ownedRuntime.mountedEffects += 1
    return () => {
      ownedRuntime.mountedEffects -= 1
      queueMicrotask(() => {
        if (ownedRuntime.mountedEffects === 0 && !ownedRuntime.destroyed) {
          ownedRuntime.destroyed = true
          ownedRuntime.engine.destroy()
        }
      })
    }
  }, [ownedRuntime])
  const engineContext = useMemo(() => ({ engine }), [engine])
  const presentation = useRef({ engine, revision: 0 })
  if (presentation.current.engine !== engine) {
    presentation.current = { engine, revision: presentation.current.revision + 1 }
  }
  const content = hostsRuntime ? (
    <AppletStateStoreContext.Provider value={engine.appletState}>
      <AppletApplicationContext.Provider value={engine.compositor.application.read({ applicationId: engine.rootApplicationId })}>
        {children}
      </AppletApplicationContext.Provider>
    </AppletStateStoreContext.Provider>
  ) : children
  return (
    <AppletEngineContext.Provider key={presentation.current.revision} value={engineContext}>
      <AppletEngineOwnershipContext.Provider value={ownsEngine}>
        {content}
      </AppletEngineOwnershipContext.Provider>
    </AppletEngineContext.Provider>
  )
}

export function useWhichApplet({ applet, application: suppliedApplication, enabled = true, engine: suppliedEngine, surface: suppliedSurface }) {
  const inheritedEngine = useContext(AppletEngineContext)?.engine ?? null
  const engine = enabled ? suppliedEngine ?? inheritedEngine : null
  const inheritedApplication = useContext(AppletApplicationContext)
  const inheritedDefinition = engine && engine === inheritedEngine && !suppliedApplication && !suppliedSurface && inheritedApplication
    ? engine.runtime.resolveApplicationNode(inheritedApplication)
    : null
  const inheritedOccurrence = inheritedDefinition?.Applet === applet ? inheritedApplication : null
  const suppliedOccurrence = suppliedApplication && suppliedSurface
  const recordedSurface = engine && suppliedSurface && !suppliedOccurrence
    ? engine.compositor.surface.read({ surfaceId: suppliedSurface.surfaceId })
    : null
  const surfaceApplication = !suppliedApplication && recordedSurface
    ? engine.compositor.application.read({ applicationId: recordedSurface.applicationId })
    : null
  const application = engine ? suppliedApplication ?? surfaceApplication
    ?? inheritedOccurrence ?? engine.runtime.applicationForNode(applet) : null
  const [anchorSurfaceId, setAnchorSurfaceId] = useState(null)
  const rootApplication = Boolean(application && application.applicationId === engine?.rootApplicationId)
  const rootSurfaceId = rootApplication ? engine.rootSurfaceId : null
  const surfaceId = engine ? suppliedSurface?.surfaceId ?? rootSurfaceId ?? anchorSurfaceId : null
  const currentSurface = suppliedOccurrence ? suppliedSurface
    : surfaceId ? engine.compositor.surface.read({ surfaceId }) : null
  const surface = engine && currentSurface?.applicationId === application?.applicationId ? currentSurface : null
  useLayoutEffect(() => {
    if (!engine || !application || suppliedSurface || rootApplication) return
    const anchor = engine.runtime.ensureAnchorSurface({
      applicationId: application.applicationId,
      key: `resident:${application.applicationId}`,
      workspaceId: applet.meta.applicationName,
    })
    setAnchorSurfaceId(anchor.surfaceId)
  }, [application?.applicationId, applet, engine, rootApplication, suppliedSurface])
  return { application, engine, surface }
}

AppletEngine.collectApplicationRegistry = collectApplicationRegistry
AppletEngine.collectSettingsContributions = collectSettingsContributions
AppletEngine.create = createAppletEngine
AppletEngine.resolveRootApplet = resolveRootApplet
AppletEngine.Application = function AppletEngineApplication({
  application,
  children,
}) {
  return (
    <AppletApplicationContext.Provider value={application ?? null}>
      {children}
    </AppletApplicationContext.Provider>
  )
}
AppletEngine.use = function useAppletEngine() {
  const engine = useContext(AppletEngineContext)?.engine ?? null
  if (!engine) throw new Error('AppletEngine.use must be called inside an Applet')
  return engine
}
AppletEngine.useOptional = function useOptionalAppletEngine() {
  return useContext(AppletEngineContext)?.engine ?? null
}
AppletEngine.useRootApplet = function useRootApplet(
  suppliedRootApplet,
  fallbackApplet,
) {
  const engine = useContext(AppletEngineContext)?.engine ?? null
  return resolveRootApplet(
    suppliedRootApplet ?? engine?.rootApplet,
    fallbackApplet,
    )
}
AppletEngine.useOwnership = function useAppletEngineOwnership() {
  return useContext(AppletEngineOwnershipContext)
}
AppletEngine.useApplication = function useAppletApplication() {
  return useContext(AppletApplicationContext)
}
AppletEngine.useState = useAppletState
AppletEngine.useWhichApplet = useWhichApplet

export { useAppletState }
