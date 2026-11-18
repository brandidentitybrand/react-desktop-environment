import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

const isArrayIndex = (key, length) => {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length
}

const nonEmptyString = (value) => (
  typeof value === 'string' && value.length > 0
)

export function immutableJson(value, label = 'Persistent value') {
  const ancestors = new Set()

  const detach = (candidate, path) => {
    if (
      candidate === null
      || typeof candidate === 'boolean'
      || typeof candidate === 'string'
    ) return candidate
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new TypeError(`${path} must contain only JSON numbers`)
      }
      return candidate
    }
    if (typeof candidate !== 'object') {
      throw new TypeError(`${path} must contain only JSON values`)
    }
    if (ancestors.has(candidate)) {
      throw new TypeError(`${path} must not contain a cycle`)
    }

    const isArray = Array.isArray(candidate)
    const prototype = Object.getPrototypeOf(candidate)
    if (
      (isArray && prototype !== Array.prototype)
      || (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new TypeError(`${path} must contain only plain JSON containers`)
    }

    const ownKeys = Reflect.ownKeys(candidate)
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new TypeError(`${path} must not contain symbol keys`)
    }
    const stringKeys = isArray
      ? ownKeys.filter((key) => key !== 'length')
      : ownKeys
    if (
      isArray
      && (
        stringKeys.length !== candidate.length
        || stringKeys.some((key) => !isArrayIndex(key, candidate.length))
      )
    ) {
      throw new TypeError(`${path} must be a dense JSON array`)
    }

    ancestors.add(candidate)
    const result = isArray ? [] : Object.create(null)
    const keys = isArray
      ? Array.from({ length: candidate.length }, (_, index) => String(index))
      : stringKeys.sort()
    keys.forEach((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        ancestors.delete(candidate)
        throw new TypeError(`${path}.${key} must be a JSON data property`)
      }
      if (!isArray && !descriptor.enumerable) {
        ancestors.delete(candidate)
        throw new TypeError(`${path}.${key} must be enumerable`)
      }
      const detached = detach(descriptor.value, `${path}.${key}`)
      if (isArray) result.push(detached)
      else result[key] = detached
    })
    ancestors.delete(candidate)
    return Object.freeze(result)
  }

  return detach(value, label)
}

function sameLocalStateValue(current, next, ancestors = new Set()) {
  if (Object.is(current, next)) return true
  if (!current || !next || typeof current !== 'object' || typeof next !== 'object') return false
  if (Object.getPrototypeOf(current) !== Object.getPrototypeOf(next)) return false
  if (!Array.isArray(current) && ![null, Object.prototype].includes(Object.getPrototypeOf(current))) return false
  if (ancestors.has(current)) return false
  ancestors.add(current)
  const keys = Object.keys(current)
  const equal = keys.length === Object.keys(next).length && keys.every(key => {
    const left = Object.getOwnPropertyDescriptor(current, key)
    const right = Object.getOwnPropertyDescriptor(next, key)
    return right && Object.hasOwn(left, 'value') && Object.hasOwn(right, 'value')
      && typeof left.value !== 'function' && sameLocalStateValue(left.value, right.value, ancestors)
  })
  ancestors.delete(current)
  return equal
}

export const AppletApplicationContext = createContext(null)
export const AppletStateStoreContext = createContext(null)

const requireStateName = (stateName) => {
  if (!nonEmptyString(stateName)) {
    throw new TypeError('useAppletState requires a non-empty stateName')
  }
  return stateName
}

export function createAppletStateStore({ applications = {}, initialState } = {}) {
  const state = initialState ?? {}
  const records = new Map()
  const requireRecord = id => {
    const record = records.get(id)
    if (!record) throw new Error(`Unknown Applet application: ${id}`)
    return record
  }
  const ownerOf = supply => {
    if (supply === undefined) return null
    const keys = Object.keys(supply)
    if (keys.length !== 1 || !['surfaceId', 'applicationId'].includes(keys[0]) || !nonEmptyString(supply[keys[0]])) {
      throw new TypeError('Supply requires exactly one owner identity')
    }
    return `${keys[0]}:${supply[keys[0]]}`
  }
  const addApplication = (application, { savedState, supply } = {}) => {
    const id = application.applicationId
    if (!records.has(id)) records.set(id, {
      application, declarations: new Map(), owners: new Map(),
      setters: new Map(), listeners: new Map(),
    })
    if (savedState !== undefined) {
      Object.entries(savedState).forEach(([name, value]) => {
        const table = state[id] ??= Object.create(null)
        table[name] = value
        records.get(id).owners.set(name, ownerOf(supply))
      })
    }
    return application
  }
  Object.values(applications).forEach(application => {
    addApplication(application)
    records.get(application.applicationId).restored = initialState !== undefined
  })
  const read = ({ applicationId, stateName }) => {
    requireStateName(stateName)
    const declaration = requireRecord(applicationId).declarations.get(stateName)
    const saved = state[applicationId]?.[stateName]
    return declaration && (!declaration.persistent || Object.is(declaration.source, saved))
      ? declaration.value : saved
  }
  const notify = (record, name) => record.listeners.get(name)?.forEach(listener => listener())
  const write = ({ applicationId, stateName, value, supply }) => {
    const current = read({ applicationId, stateName })
    const record = requireRecord(applicationId)
    const owner = ownerOf(supply)
    const declaration = record.declarations.get(stateName)
    const saved = state[applicationId]
    if (owner && (record.owners.has(stateName) || saved && Object.hasOwn(saved, stateName))
      && record.owners.get(stateName) !== owner) return current
    record.owners.set(stateName, owner)
    if (declaration?.persistent !== false) {
      const table = saved ?? (state[applicationId] = Object.create(null))
      table[stateName] = value
    }
    if (declaration) {
      declaration.value = value
      declaration.source = value
    }
    if (!Object.is(current, value)) notify(record, stateName)
    return value
  }
  const endApplicationState = ({ applicationId }) => {
    const record = requireRecord(applicationId)
    delete state[applicationId]
    record.restored = false
    record.declarations.clear()
    record.owners.clear()
    record.setters.clear()
    record.listeners.forEach(listeners => listeners.forEach(listener => listener()))
  }
  return {
    addApplication,
    getSnapshot: () => state,
    snapshot: id => state[id],
    isRestored: ({ applicationId }) => records.get(applicationId)?.restored === true,
    read, write, endApplicationState,
    ensure({ applicationId, stateName, initialValue, persistent = true, adopt, deferNotifications }) {
      requireStateName(stateName)
      const record = requireRecord(applicationId)
      const previous = record.declarations.get(stateName)
      if (previous && previous.persistent !== persistent) throw new Error(`Applet state ${stateName} changed persistence for ${applicationId}`)
      if (adopt !== undefined && typeof adopt !== 'function') throw new TypeError('Applet state adopt must be a function')
      if (previous && previous.adopt === adopt) return read({ applicationId, stateName })
      const candidate = previous || persistent ? read({ applicationId, stateName }) : undefined
      const recognized = candidate !== undefined && adopt ? adopt(candidate) : candidate
      const next = recognized === undefined
        ? typeof initialValue === 'function' ? initialValue() : initialValue
        : recognized
      const same = persistent ? sameLocalStateValue(candidate, next) : Object.is(candidate, next)
      const value = same ? candidate : next
      if (persistent && !record.restored) {
        const table = state[applicationId] ?? (state[applicationId] = Object.create(null))
        table[stateName] = value
      }
      record.declarations.set(stateName, { persistent, adopt, source: state[applicationId]?.[stateName], value })
      if (recognized === undefined) record.owners.set(stateName, `applicationId:${applicationId}`)
      if (previous && !same) {
        if (deferNotifications) queueMicrotask(() => notify(record, stateName))
        else notify(record, stateName)
      }
      return value
    },
    getSetter({ applicationId, stateName }) {
      const record = requireRecord(applicationId)
      if (!record.setters.has(stateName)) {
        const setter = (next, { supply } = {}) => {
          if (records.get(applicationId) !== record || record.setters.get(stateName) !== setter) return undefined
          const value = typeof next === 'function' ? next(read({ applicationId, stateName })) : next
          return write({ applicationId, stateName, value, supply })
        }
        record.setters.set(stateName, setter)
      }
      return record.setters.get(stateName)
    },
    removeApplication({ applicationId }) {
      const { application } = requireRecord(applicationId)
      records.delete(applicationId)
      delete state[applicationId]
      return application
    },
    subscribe({ applicationId, stateName }, listener) {
      const record = requireRecord(applicationId)
      if (!record.listeners.has(stateName)) record.listeners.set(stateName, new Set())
      const listeners = record.listeners.get(stateName)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useAppletState(initialValue, stateName, options = {}) {
  const application = useContext(AppletApplicationContext)
  const appletState = useContext(AppletStateStoreContext)
  const persistent = application !== null && appletState !== null
  const [localState, setLocalState] = useState(() => ({
    value: persistent
      ? undefined
      : typeof initialValue === 'function' ? initialValue() : initialValue,
  }))
  const committedLocalState = useRef({ adopt: options.adopt, state: localState })
  useLayoutEffect(() => {
    committedLocalState.current = { adopt: options.adopt, state: localState }
  }, [localState, options.adopt])
  const readLocalValue = () => {
    const localValue = localState.value
    if (
      !persistent
      && committedLocalState.current.adopt !== options.adopt
      && (
        localState === committedLocalState.current.state
        || localState.adopt !== options.adopt
      )
    ) {
      const recognized = options.adopt ? options.adopt(localValue) : localValue
      const nextValue = recognized === undefined
        ? typeof initialValue === 'function' ? initialValue() : initialValue
        : recognized
      if (!sameLocalStateValue(localValue, nextValue)) {
        setLocalState({ adopt: options.adopt, value: nextValue })
        return nextValue
      }
    }
    return localValue
  }
  const localValue = readLocalValue()
  const setLocalValue = useCallback((nextValue) => {
    setLocalState((current) => ({
      value: typeof nextValue === 'function' ? nextValue(current.value) : nextValue,
    }))
  }, [])
  if ((application === null) !== (appletState === null)) {
    throw new Error('useAppletState received an incomplete Applet runtime')
  }
  requireStateName(stateName)
  const applicationId = application?.applicationId
  if (persistent) {
    appletState.ensure({
      applicationId,
      initialValue,
      persistent: options.persistent ?? true,
      stateName,
      adopt: options.adopt,
      // Adoption is synchronous; subscribers must not update other React
      // consumers during render. Delivery also survives an abandoned render.
      deferNotifications: true,
    })
  }

  const subscribe = useCallback(
    (listener) => persistent
      ? appletState.subscribe({ applicationId, stateName }, listener)
      : () => {},
    [appletState, applicationId, persistent, stateName],
  )
  const read = useCallback(
    () => persistent
      ? appletState.read({ applicationId, stateName })
      : localValue,
    [appletState, applicationId, localValue, persistent, stateName],
  )
  const value = useSyncExternalStore(subscribe, read, read)
  return [
    value,
    persistent
      ? appletState.getSetter({ applicationId, stateName })
      : setLocalValue,
  ]
}
