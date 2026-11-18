const EMPTY_TABLE = Object.freeze({})
const EMPTY_SNAPSHOT = Object.freeze({
  applications: EMPTY_TABLE,
  surfaces: EMPTY_TABLE,
})

const resolveCreateId = (createId) => {
  if (createId !== undefined) {
    if (typeof createId !== 'function') throw new TypeError('createId must be a function')
    return createId
  }
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('createCompositor requires crypto.randomUUID or an explicit createId')
  }
  return (kind) => `${kind}:${globalThis.crypto.randomUUID()}`
}

const sameRecords = (previous, next) =>
  previous.length === next.length &&
  previous.every((record, index) => record === next[index])

export default function createCompositor(options = {}) {
  const { windowManager } = options
  if (!windowManager?.window || typeof windowManager.subscribe !== 'function') {
    throw new TypeError('createCompositor requires a window manager')
  }

  const applicationRegistry = Object.freeze({ ...(options.applicationRegistry ?? {}) })
  const surfaceComponentRegistry = Object.freeze({
    ...(options.surfaceComponentRegistry ?? {}),
  })
  const createId = resolveCreateId(options.createId)
  const defaultWorkspaceId = options.defaultWorkspaceId ?? 'default'
  const defaultSurfaceComponentName = options.defaultSurfaceComponentName
  const baseZIndex = options.baseZIndex ?? 1
  const retainUnreferencedApplications =
    options.retainUnreferencedApplications ?? false
  if (!Number.isFinite(baseZIndex)) throw new TypeError('baseZIndex must be finite')
  const configureSurfaceControls = options.configureSurfaceControls
  if (
    configureSurfaceControls !== undefined &&
    typeof configureSurfaceControls !== 'function'
  ) {
    throw new TypeError('configureSurfaceControls must be a function')
  }

  const listeners = new Set()
  const childCache = new Map()
  const surfaceControlsCache = new Map()

  const notify = () => listeners.forEach((listener) => listener())
  const commit = ({ applications = compositor.state.applications, surfaces = compositor.state.surfaces }) => {
    compositor.state = Object.freeze({
      applications: Object.freeze(applications),
      surfaces: Object.freeze(surfaces),
    })
    notify()
    return compositor.state
  }
  const requireApplication = (applicationId) => {
    const record = compositor.state.applications[applicationId]
    if (!record) throw new Error(`Unknown compositor application: ${applicationId}`)
    return record
  }
  const requireSurface = (surfaceId) => {
    const record = compositor.state.surfaces[surfaceId]
    if (!record) throw new Error(`Unknown compositor surface: ${surfaceId}`)
    return record
  }
  const requireWindow = (windowId) => {
    const record = windowManager.window.read({ windowId })
    if (!record) throw new Error(`Unknown window-manager window: ${windowId}`)
    return record
  }
  const requireApplicationComponent = (applicationName) => {
    const Component = applicationRegistry[applicationName]
    if (!Component) throw new Error(`Unknown registered application: ${applicationName}`)
    return Component
  }
  const requireSurfaceComponent = (surfaceComponentName) => {
    const Component = surfaceComponentRegistry[surfaceComponentName]
    if (!Component) {
      throw new Error(`Unknown registered surface component: ${surfaceComponentName}`)
    }
    return Component
  }
  const validateSurfaceState = ({
    surfaceId,
    selectedChildSurfaceId,
    zIndex,
    hidden,
    workspaceId,
  }) => {
    if (!surfaceId) throw new Error('surfaceId is required')
    if (!workspaceId) throw new Error('surface workspaceId is required')
    if (!Number.isFinite(zIndex)) throw new TypeError('surface zIndex must be finite')
    if (typeof hidden !== 'boolean') throw new TypeError('surface hidden must be boolean')
    if (
      selectedChildSurfaceId !== null
      && selectedChildSurfaceId !== undefined
      && typeof selectedChildSurfaceId !== 'string'
    ) {
      throw new TypeError('surface selectedChildSurfaceId must be a string or null')
    }
  }
  const isImmediateChildSurface = (parentSurface, childSurface) => (
    childSurface && windowManager.window.read(childSurface)?.parentWindowId === parentSurface.windowId
  )
  const reconcileSurfaceSelections = (surfaces) => {
    const invalid = Object.values(surfaces).filter(parent => parent.selectedChildSurfaceId != null
      && !isImmediateChildSurface(parent, surfaces[parent.selectedChildSurfaceId]))
    if (!invalid.length) return surfaces
    return { ...surfaces, ...Object.fromEntries(invalid.map(parent => [
      parent.surfaceId, Object.freeze({ ...parent, selectedChildSurfaceId: null }),
    ])) }
  }
  const nextZIndex = () =>
    Math.max(
      baseZIndex - 1,
      ...Object.values(compositor.state.surfaces).map(({ zIndex }) => zIndex),
    ) + 1

  const application = Object.freeze({
    create({ applicationId = createId('application'), applicationName, props = {} } = {}) {
      if (!applicationId) throw new Error('applicationId is required')
      requireApplicationComponent(applicationName)
      return Object.freeze({ applicationId, applicationName, props })
    },
    add({ application: record } = {}) {
      if (!record) throw new Error('application.add requires an application object')
      if (!record.applicationId) throw new Error('applicationId is required')
      if (compositor.state.applications[record.applicationId]) {
        throw new Error(`Duplicate compositor application: ${record.applicationId}`)
      }
      requireApplicationComponent(record.applicationName)
      const added = Object.freeze({
        applicationId: record.applicationId,
        applicationName: record.applicationName,
        props: record.props ?? {},
      })
      commit({
        applications: { ...compositor.state.applications, [added.applicationId]: added },
      })
      return added
    },
    read({ applicationId } = {}) {
      return compositor.state.applications[applicationId]
    },
    update({ applicationId, ...changes } = {}) {
      const current = requireApplication(applicationId)
      const applicationName = changes.applicationName ?? current.applicationName
      requireApplicationComponent(applicationName)
      const updated = Object.freeze({ ...current, ...changes, applicationName })
      const surfaces = { ...compositor.state.surfaces }
      Object.entries(surfaces).forEach(([surfaceId, surface]) => {
        if (surface.applicationId === applicationId) {
          surfaces[surfaceId] = Object.freeze({ ...surface, application: updated })
        }
      })
      commit({
        applications: { ...compositor.state.applications, [applicationId]: updated },
        surfaces,
      })
      return updated
    },
    remove({ applicationId } = {}) {
      requireApplication(applicationId)
      if (
        Object.values(compositor.state.surfaces).some(
          (surface) => surface.applicationId === applicationId,
        )
      ) {
        throw new Error(`Cannot remove application ${applicationId} while surfaces reference it`)
      }
      const applications = { ...compositor.state.applications }
      delete applications[applicationId]
      commit({ applications })
      return applicationId
    },
    getComponent({ applicationId } = {}) {
      return requireApplicationComponent(requireApplication(applicationId).applicationName)
    },
  })

  const surface = Object.freeze({
    create({
      surfaceId = createId('surface'),
      windowId,
      applicationId,
      surfaceComponentName = defaultSurfaceComponentName,
      workspaceId = defaultWorkspaceId,
      zIndex = nextZIndex(),
      hidden = false,
      fullscreen = false,
      selectedChildSurfaceId = null,
      position,
      size,
      props = {},
    } = {}) {
      validateSurfaceState({ surfaceId, workspaceId, zIndex, hidden })
      requireSurfaceComponent(surfaceComponentName)
      return Object.freeze({
        surfaceId,
        windowId,
        window: requireWindow(windowId),
        applicationId,
        application: requireApplication(applicationId),
        surfaceComponentName,
        workspaceId,
        zIndex,
        hidden,
        fullscreen,
        selectedChildSurfaceId,
        ...(position === undefined ? {} : { position }),
        ...(size === undefined ? {} : { size }),
        props,
      })
    },
    add({ surface: record } = {}) {
      if (!record) throw new Error('surface.add requires a surface object')
      validateSurfaceState(record)
      if (compositor.state.surfaces[record.surfaceId]) {
        throw new Error(`Duplicate compositor surface: ${record.surfaceId}`)
      }
      const window = requireWindow(record.windowId)
      const linkedApplication = requireApplication(record.applicationId)
      requireSurfaceComponent(record.surfaceComponentName)
      if (record.window !== window || record.application !== linkedApplication) {
        throw new Error('surface.add requires current window and application references')
      }
      const added = Object.freeze({ ...record, window, application: linkedApplication })
      commit({ surfaces: { ...compositor.state.surfaces, [added.surfaceId]: added } })
      return added
    },
    read({ surfaceId } = {}) {
      return compositor.state.surfaces[surfaceId]
    },
    readChildren({ surfaceId } = {}) {
      const parentSurface = requireSurface(surfaceId)
      const managerSnapshot = windowManager.getSnapshot()
      const previous = childCache.get(surfaceId)
      if (
        previous?.compositorSnapshot === compositor.state &&
        previous?.managerSnapshot === managerSnapshot
      ) {
        return previous.value
      }

      const childWindowIds = new Set(
        windowManager.window
          .readChildren({ windowId: parentSurface.windowId })
          .map((window) => window.windowId),
      )
      const next = Object.freeze(
        Object.values(compositor.state.surfaces).filter((candidate) =>
          childWindowIds.has(candidate.windowId),
        ),
      )
      const value = previous && sameRecords(previous.value, next) ? previous.value : next
      childCache.set(surfaceId, {
        compositorSnapshot: compositor.state,
        managerSnapshot,
        value,
      })
      return value
    },
    readSelectedChild({ surfaceId } = {}) {
      const parentSurface = requireSurface(surfaceId)
      if (parentSurface.selectedChildSurfaceId == null) return undefined
      const childSurface = compositor.state.surfaces[parentSurface.selectedChildSurfaceId]
      return isImmediateChildSurface(parentSurface, childSurface)
        ? childSurface
        : undefined
    },
    selectChild({ surfaceId, childSurfaceId } = {}) {
      const parentSurface = requireSurface(surfaceId)
      if (childSurfaceId == null) {
        return surface.update({ surfaceId, selectedChildSurfaceId: null })
      }
      const childSurface = requireSurface(childSurfaceId)
      if (!isImmediateChildSurface(parentSurface, childSurface)) {
        throw new Error(
          `Surface ${childSurfaceId} is not an immediate child of ${surfaceId}`,
        )
      }
      return surface.update({ surfaceId, selectedChildSurfaceId: childSurfaceId })
    },
    activateChild({ surfaceId, childSurfaceId } = {}) {
      const parentSurface = requireSurface(surfaceId)
      const childSurface = requireSurface(childSurfaceId)
      if (!isImmediateChildSurface(parentSurface, childSurface)) {
        throw new Error(
          `Surface ${childSurfaceId} is not an immediate child of ${surfaceId}`,
        )
      }

      const activatedChild = Object.freeze({
        ...childSurface,
        hidden: false,
        zIndex: nextZIndex(),
        attentionRevision: (childSurface.attentionRevision ?? 0) + 1,
      })
      const selectedParent = Object.freeze({
        ...parentSurface,
        selectedChildSurfaceId: childSurfaceId,
      })
      commit({
        surfaces: {
          ...compositor.state.surfaces,
          [surfaceId]: selectedParent,
          [childSurfaceId]: activatedChild,
        },
      })
      return activatedChild
    },
    raiseChild({ surfaceId, childSurfaceId } = {}) {
      const parentSurface = requireSurface(surfaceId)
      const childSurface = requireSurface(childSurfaceId)
      if (!isImmediateChildSurface(parentSurface, childSurface)) {
        throw new Error(
          `Surface ${childSurfaceId} is not an immediate child of ${surfaceId}`,
        )
      }

      const raisedChild = Object.freeze({
        ...childSurface,
        zIndex: nextZIndex(),
        attentionRevision: (childSurface.attentionRevision ?? 0) + 1,
      })
      const selectedParent = Object.freeze({
        ...parentSurface,
        selectedChildSurfaceId: childSurfaceId,
      })
      commit({
        surfaces: {
          ...compositor.state.surfaces,
          [surfaceId]: selectedParent,
          [childSurfaceId]: raisedChild,
        },
      })
      return raisedChild
    },
    update({ surfaceId, window: suppliedWindow, application: suppliedApplication, ...changes } = {}) {
      if (suppliedWindow !== undefined || suppliedApplication !== undefined) {
        throw new Error('surface.update resolves window and application references itself')
      }
      const current = requireSurface(surfaceId)
      const windowId = changes.windowId ?? current.windowId
      const applicationId = changes.applicationId ?? current.applicationId
      const surfaceComponentName =
        changes.surfaceComponentName ?? current.surfaceComponentName
      requireSurfaceComponent(surfaceComponentName)
      const updated = Object.freeze({
        ...current,
        ...changes,
        surfaceId,
        windowId,
        window: requireWindow(windowId),
        applicationId,
        application: requireApplication(applicationId),
        surfaceComponentName,
      })
      validateSurfaceState(updated)
      commit({ surfaces: { ...compositor.state.surfaces, [surfaceId]: updated } })
      return updated
    },
    raise({ surfaceId } = {}) {
      const current = requireSurface(surfaceId)
      const updated = Object.freeze({
        ...current,
        zIndex: nextZIndex(),
      })
      commit({ surfaces: { ...compositor.state.surfaces, [surfaceId]: updated } })
      return updated
    },
    readControls({ surfaceId } = {}) {
      requireSurface(surfaceId)
      const cached = surfaceControlsCache.get(surfaceId)
      if (cached) return cached

      const controls = Object.freeze({
        focus() {
          return surface.raise({ surfaceId })
        },
        hide() {
          return surface.update({ surfaceId, hidden: true })
        },
        show() {
          surface.update({ surfaceId, hidden: false })
          return surface.raise({ surfaceId })
        },
        move({ position } = {}) {
          return surface.update({ surfaceId, position })
        },
        resize({ position, size } = {}) {
          return surface.update({ surfaceId, position, size })
        },
        fullscreen({ position, size } = {}) {
          const current = requireSurface(surfaceId)
          if (current.fullscreen) return current
          return surface.update({
            surfaceId,
            fullscreen: true,
            position,
            size,
            restoreGeometry: {
              position: current.position,
              size: current.size,
            },
          })
        },
        exitFullscreen() {
          const current = requireSurface(surfaceId)
          if (!current.fullscreen) return current
          return surface.update({
            surfaceId,
            fullscreen: false,
            position: current.restoreGeometry?.position,
            size: current.restoreGeometry?.size,
            restoreGeometry: undefined,
          })
        },
        selectChild(childSurfaceId) {
          return surface.selectChild({ surfaceId, childSurfaceId })
        },
        close() {
          const current = requireSurface(surfaceId)
          const removedWindowIds = windowManager.window.remove({
            windowId: current.windowId,
          })
          return Object.freeze({
            surfaceId,
            removedWindowIds,
            ...cleanup(),
          })
        },
      })
      const overrides = configureSurfaceControls?.({ controls, surfaceId })
      if (
        overrides !== undefined &&
        (overrides === null || typeof overrides !== 'object')
      ) {
        throw new TypeError('configureSurfaceControls must return an object or undefined')
      }
      const configuredControls = Object.freeze({
        ...controls,
        ...(overrides ?? {}),
      })
      surfaceControlsCache.set(surfaceId, configuredControls)
      return configuredControls
    },
    remove({ surfaceId } = {}) {
      requireSurface(surfaceId)
      const surfaces = { ...compositor.state.surfaces }
      delete surfaces[surfaceId]
      surfaceControlsCache.delete(surfaceId)
      commit({ surfaces: reconcileSurfaceSelections(surfaces) })
      return surfaceId
    },
    getComponent({ surfaceId } = {}) {
      return requireSurfaceComponent(requireSurface(surfaceId).surfaceComponentName)
    },
  })

  const reconcileWindows = previous => {
    const surfaces = {}
    Object.entries(compositor.state.surfaces).forEach(([surfaceId, current]) => {
      const window = windowManager.window.read({ windowId: current.windowId })
      if (!window) {
        surfaceControlsCache.delete(surfaceId)
        return
      }
      if (window !== (previous?.windows?.[current.windowId] ?? current.window)) {
        surfaces[surfaceId] = Object.freeze({ ...current, window })
      } else {
        surfaces[surfaceId] = current
      }
    })
    if (Object.keys(surfaces).length !== Object.keys(compositor.state.surfaces).length
      || Object.values(surfaces).some(surface => surface !== compositor.state.surfaces[surface.surfaceId])) commit({ surfaces: reconcileSurfaceSelections(surfaces) })
  }
  const unsubscribeWindowManager = windowManager.subscribe(reconcileWindows)

  const cleanup = () => {
    const removedSurfaceIds = []
    const surfaces = {}
    Object.entries(compositor.state.surfaces).forEach(([surfaceId, record]) => {
      if (
        !windowManager.window.read({ windowId: record.windowId }) ||
        !compositor.state.applications[record.applicationId]
      ) {
        removedSurfaceIds.push(surfaceId)
        surfaceControlsCache.delete(surfaceId)
      } else {
        surfaces[surfaceId] = record
      }
    })
    const referencedApplicationIds = new Set(
      Object.values(surfaces).map(({ applicationId }) => applicationId),
    )
    const removedApplicationIds = retainUnreferencedApplications
      ? []
      : Object.keys(compositor.state.applications).filter(
          (applicationId) => !referencedApplicationIds.has(applicationId),
        )
    if (removedSurfaceIds.length || removedApplicationIds.length) {
      const removed = new Set(removedApplicationIds)
      commit({
        surfaces: reconcileSurfaceSelections(surfaces),
        applications: Object.fromEntries(
          Object.entries(compositor.state.applications).filter(
            ([applicationId]) => !removed.has(applicationId),
          ),
        ),
      })
    }
    return Object.freeze({
      removedSurfaceIds: Object.freeze(removedSurfaceIds),
      removedApplicationIds: Object.freeze(removedApplicationIds),
    })
  }

  const compositor = {
    state: options.initialSnapshot ?? EMPTY_SNAPSHOT,
    application,
    surface,
    applicationRegistry,
    surfaceComponentRegistry,
    windowManager,
    getSnapshot: () => compositor.state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    cleanup,
    destroy: unsubscribeWindowManager,
  }
  Object.values(compositor.state.applications).forEach(record => requireApplicationComponent(record.applicationName))
  return compositor
}
