const EMPTY_SNAPSHOT = Object.freeze({ windows: Object.freeze({}) })

const resolveCreateId = (createId) => {
  if (createId !== undefined) {
    if (typeof createId !== 'function') throw new TypeError('createId must be a function')
    return createId
  }
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('createWindowManager requires crypto.randomUUID or an explicit createId')
  }
  return () => `window:${globalThis.crypto.randomUUID()}`
}

const validateSnapshot = snapshot => {

  Object.entries(snapshot.windows).forEach(([windowId, window]) => {
    if (!windowId || window.windowId !== windowId) {
      throw new Error(`Invalid window record: ${window.windowId ?? 'missing windowId'}`)
    }
    if (
      window.parentWindowId !== null &&
      !snapshot.windows[window.parentWindowId]
    ) {
      throw new Error(`Window ${windowId} refers to an unknown parent`)
    }
  })

  Object.keys(snapshot.windows).forEach((windowId) => {
    const visited = new Set([windowId])
    const visit = parentWindowId => {
      if (parentWindowId === null) return
      if (visited.has(parentWindowId)) throw new Error(`Window cycle detected at ${parentWindowId}`)
      visited.add(parentWindowId)
      visit(snapshot.windows[parentWindowId].parentWindowId)
    }
    visit(snapshot.windows[windowId].parentWindowId)
  })

  return snapshot
}

const sameRecords = (previous, next) =>
  previous.length === next.length &&
  previous.every((record, index) => record === next[index])

export default function createWindowManager(options = {}) {
  const createId = resolveCreateId(options.createId)
  const listeners = new Set()
  const childCache = new Map()

  const commit = (windows) => {
    const previous = manager.state
    manager.state = validateSnapshot(Object.freeze({ windows: Object.freeze(windows) }))
    listeners.forEach(listener => listener(previous))
    return manager.state
  }
  const requireWindow = (windowId) => {
    const record = manager.state.windows[windowId]
    if (!record) throw new Error(`Unknown window: ${windowId}`)
    return record
  }
  const requireParent = (parentWindowId) => {
    if (parentWindowId !== null) requireWindow(parentWindowId)
  }
  const collectTree = (rootWindowId) => {
    const collected = new Set([rootWindowId])
    collected.forEach(id => Object.values(manager.state.windows).forEach(record => {
      if (record.parentWindowId === id) collected.add(record.windowId)
    }))
    return [...collected]
  }
  const readChildren = ({ windowId = null } = {}) => {
    if (windowId !== null) requireWindow(windowId)
    const previous = childCache.get(windowId)
    if (previous?.savedSnapshot === manager.state) return previous.value

    const next = Object.freeze(
      Object.values(manager.state.windows).filter(
        (record) => record.parentWindowId === windowId,
      ),
    )
    const value = previous && sameRecords(previous.value, next) ? previous.value : next
    childCache.set(windowId, { savedSnapshot: manager.state, value })
    return value
  }

  const window = Object.freeze({
    create({ windowId = createId('window'), parentWindowId = null } = {}) {
      if (!windowId) throw new Error('windowId is required')
      return Object.freeze({ windowId, parentWindowId })
    },
    add({ window: record } = {}) {
      if (!record) throw new Error('window.add requires a window object')
      const { windowId, parentWindowId = null } = record
      if (!windowId) throw new Error('windowId is required')
      if (manager.state.windows[windowId]) throw new Error(`Duplicate window: ${windowId}`)
      requireParent(parentWindowId)
      const added = Object.freeze({ windowId, parentWindowId })
      commit({ ...manager.state.windows, [windowId]: added })
      return added
    },
    read({ windowId } = {}) {
      return manager.state.windows[windowId]
    },
    readChildren,
    move({ windowId, parentWindowId = null } = {}) {
      const current = requireWindow(windowId)
      requireParent(parentWindowId)
      if (parentWindowId !== null && collectTree(windowId).includes(parentWindowId)) {
        throw new Error(`Moving ${windowId} would create a window cycle`)
      }
      if (current.parentWindowId === parentWindowId) return current
      const moved = Object.freeze({ ...current, parentWindowId })
      commit({ ...manager.state.windows, [windowId]: moved })
      return moved
    },
    remove({ windowId } = {}) {
      requireWindow(windowId)
      const removedWindowIds = Object.freeze(collectTree(windowId))
      const removed = new Set(removedWindowIds)
      commit(
        Object.fromEntries(
          Object.entries(manager.state.windows).filter(([id]) => !removed.has(id)),
        ),
      )
      return removedWindowIds
    },
  })

  const manager = {
    state: validateSnapshot(options.initialSnapshot ?? EMPTY_SNAPSHOT),
    window,
    getSnapshot: () => manager.state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return manager
}
