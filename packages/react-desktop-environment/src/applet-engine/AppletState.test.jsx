/* @vitest-environment jsdom */

import React from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  AppletApplicationContext,
  AppletStateStoreContext,
  createAppletStateStore,
  immutableJson,
  useAppletState,
} from './AppletState.js'

const application = Object.freeze({
  applicationId: 'application:notes',
  applicationName: 'root/notes',
})

function Toggle({ store }) {
  const [open, setOpen] = useAppletState(false, 'open')
  return (
    <AppletStateStoreContext.Provider value={store}>
      <button onClick={() => setOpen((current) => !current)}>
        {String(open)}
      </button>
    </AppletStateStoreContext.Provider>
  )
}

function ApplicationToggle({ store }) {
  return (
    <AppletStateStoreContext.Provider value={store}>
      <AppletApplicationContext.Provider value={application}>
        <Toggle store={store} />
      </AppletApplicationContext.Provider>
    </AppletStateStoreContext.Provider>
  )
}

describe('Surface state', () => {
  it('detaches and freezes JSON without normalizing invalid values', () => {
    const source = { nested: [1, { ready: true }] }
    const detached = immutableJson(source)
    expect(detached).toEqual(source)
    expect(detached).not.toBe(source)
    expect(Object.isFrozen(detached.nested[1])).toBe(true)
    expect(() => immutableJson({ callback() {} })).toThrow(/JSON values/)
    expect(() => immutableJson({ value: Number.NaN })).toThrow(/JSON numbers/)
  })

})

describe('Applet state', () => {
  const applicationId = application.applicationId
  const supply = { applicationId }
  const withState = (live = {}) => createAppletStateStore({
    applications: { notes: application }, initialState: { [applicationId]: live },
  })

  it('adopts live and global candidates independently and retains later declarations', () => {
    const store = withState(
      { open: true, title: 'recovered edit', obsolete: 'old' },
      { open: false, title: 'saved title', obsolete: 'old' },
    )
    store.ensure({ applicationId, stateName: 'open', initialValue: false })
    store.ensure({ applicationId, stateName: 'title', initialValue: 'untitled' })
    expect(store.snapshot(applicationId)).toEqual({
      open: true, title: 'recovered edit', obsolete: 'old',
    })
  })

  it('adopts each recognized saved value and supplies a rejected candidate', () => {
    const store = withState(
      { columns: ['name'] },
      { columns: ['removed'] },
    )
    const adopt = (value) => Array.isArray(value)
      && value.every((key) => key === 'name') ? value : undefined
    store.ensure({
      applicationId, stateName: 'columns', initialValue: [], adopt,
    })
    expect(store.snapshot(applicationId)).toEqual({ columns: ['name'] })
  })

  it('resolves one default for independently missing or rejected values', () => {
    const store = withState({ request: 'obsolete' })
    const initialValue = vi.fn(() => ({ requestId: crypto.randomUUID() }))
    const value = store.ensure({
      applicationId,
      stateName: 'request',
      initialValue,
      adopt: (candidate) => typeof candidate === 'object' ? candidate : undefined,
    })
    expect(initialValue).toHaveBeenCalledOnce()
    expect(value).toBe(initialValue.mock.results[0].value)
  })

  it('reapplies recognition to both values when the owner catalogue changes', () => {
    const store = withState(
      { columns: [] },
      { columns: ['removed'] },
    )
    store.ensure({
      applicationId,
      stateName: 'columns',
      initialValue: ['removed'],
      adopt: (value) => value,
    })
    store.ensure({
      applicationId,
      stateName: 'columns',
      initialValue: ['current'],
      adopt: (value) => value.every((key) => key === 'current') ? value : undefined,
    })
    expect(store.snapshot(applicationId)).toEqual({ columns: [] })
  })

  it('keeps lifetime supply local to its target and operation', () => {
    const store = withState()
    store.ensure({ applicationId, stateName: 'document', initialValue: null })
    store.ensure({ applicationId, stateName: 'open', initialValue: false })
    const setDocument = store.getSetter({ applicationId, stateName: 'document' })
    const setOpen = store.getSetter({ applicationId, stateName: 'open' })
    setOpen(true)
    setDocument('supplied document', { supply })
    expect(store.snapshot(applicationId)).toEqual({
      document: 'supplied document', open: true,
    })
    setDocument('ordinary document')
    setDocument('late default result', { supply })
    expect(store.read({ applicationId, stateName: 'document' }))
      .toBe('ordinary document')
  })

  it('ends supply eligibility when an ordinary invocation writes the same value', () => {
    const store = withState()
    store.ensure({ applicationId, stateName: 'open', initialValue: false })
    const setOpen = store.getSetter({ applicationId, stateName: 'open' })
    setOpen(false)
    setOpen(true, { supply })
    expect(store.snapshot(applicationId)).toEqual({ open: false })
  })

  it('allows only the same supplier to replace its current default', () => {
    const store = withState()
    store.write({ applicationId, stateName: 'size', value: 10, supply: { surfaceId: 'owner' } })
    store.write({ applicationId, stateName: 'size', value: 20, supply: { surfaceId: 'other' } })
    expect(store.snapshot(applicationId)).toEqual({ size: 10 })
    store.write({ applicationId, stateName: 'size', value: 30, supply: { surfaceId: 'owner' } })
    expect(() => store.write({
      applicationId,
      stateName: 'size',
      value: 40,
      supply: { applicationId, surfaceId: 'owner' },
    })).toThrow(/exactly one owner/)
  })

  it('retains a recipe starting value as that occurrence owner supplied state', () => {
    const store = createAppletStateStore()
    store.addApplication(application, { savedState: { document: 'recipe' }, supply })
    store.ensure({ applicationId, stateName: 'document', initialValue: null })
    expect(store.snapshot(applicationId)).toEqual({ document: 'recipe' })
    store.write({ applicationId, stateName: 'document', value: 'completed', supply })
    expect(store.snapshot(applicationId)).toEqual({ document: 'completed' })
  })

  it('ends saved candidates, supplied values, and setters with their occurrence', () => {
    const store = withState({ open: true }, { open: true })
    store.ensure({ applicationId, stateName: 'open', initialValue: false })
    const oldSetter = store.getSetter({ applicationId, stateName: 'open' })
    store.endApplicationState({ applicationId })
    store.ensure({ applicationId, stateName: 'open', initialValue: false })
    oldSetter(true)
    expect(store.snapshot(applicationId)).toEqual({ open: false })
    store.removeApplication({ applicationId })
    expect(() => oldSetter(true)).not.toThrow()
    store.addApplication(application)
    store.ensure({ applicationId, stateName: 'open', initialValue: 'fresh' })
    expect(store.snapshot(applicationId)).toEqual({ open: 'fresh' })
  })

  it('keeps nonpersistent live values and supply out of durable state', () => {
    const store = withState()
    const initialValue = () => ({ callback() {} })
    store.ensure({ applicationId, stateName: 'menu', initialValue, persistent: false })
    store.getSetter({ applicationId, stateName: 'menu' })(true, { supply })
    expect(store.read({ applicationId, stateName: 'menu' })).toBe(true)
    expect(store.snapshot(applicationId)).toEqual({})
  })

  it('adapts recognition and ordinary setters through a standalone hook', () => {
    const observations = {}
    function Columns({ adopt, initialValue }) {
      const [columns, setColumns] = useAppletState(initialValue, 'columns', { adopt })
      observations.setter = setColumns
      return <span>{columns.join(',')}</span>
    }
    const view = render(<Columns initialValue={['old']} adopt={(value) => value} />)
    act(() => observations.setter(['old', 'other'], { supply }))
    expect(view.container.textContent).toBe('old,other')
    view.rerender(<Columns
      initialValue={['new']}
      adopt={(value) => value.every((key) => key === 'new') ? value : undefined}
    />)
    expect(view.container.textContent).toBe('new')
    act(() => observations.setter([]))
    expect(view.container.textContent).toBe('')
  })

  it('ends all state while keeping the Application registered for fresh defaults', () => {
    const applicationId = application.applicationId
    const store = createAppletStateStore({
      applications: { notes: application },
      initialState: { [applicationId]: { open: true, unseen: 'old' } },
    })
    store.ensure({ applicationId, stateName: 'open', initialValue: false })
    store.ensure({
      applicationId, stateName: 'menu', initialValue: true, persistent: false,
    })
    const listener = vi.fn()
    store.subscribe({ applicationId, stateName: 'open' }, listener)

    store.endApplicationState({ applicationId })

    expect(store.snapshot(applicationId)).toBeUndefined()
    expect(store.read({ applicationId, stateName: 'menu' })).toBeUndefined()
    expect(listener).toHaveBeenCalledOnce()
    expect(store.ensure({ applicationId, stateName: 'open', initialValue: false }))
      .toBe(false)
    expect(store.ensure({ applicationId, stateName: 'unseen', initialValue: 'new' }))
      .toBe('new')
    expect(store.ensure({ applicationId, stateName: 'menu', initialValue: 'fresh' }))
      .toBe('fresh')
  })

  it('adopts only registered saved values and supplies current defaults', () => {
    const listener = vi.fn()
    const store = createAppletStateStore({
      applications: { notes: application },
      initialState: {
        [application.applicationId]: {
          obsolete: 'undeclared',
          open: true,
        },
      },
    })

    expect(store.ensure({
      applicationId: application.applicationId,
      initialValue: false,
      stateName: 'open',
    })).toBe(true)
    expect(store.ensure({
      applicationId: application.applicationId,
      initialValue: 'current default',
      stateName: 'missing',
    })).toBe('current default')
    expect(store.snapshot(application.applicationId)).toEqual({
      obsolete: 'undeclared',
      missing: 'current default',
      open: true,
    })
  })

  it('keeps nonpersistent state out of durable state', () => {
    const store = createAppletStateStore({ applications: { notes: application } })
    store.ensure({
      applicationId: application.applicationId,
      initialValue: false,
      persistent: false,
      stateName: 'hovered',
    })
    expect(store.read({
      applicationId: application.applicationId,
      stateName: 'hovered',
    })).toBe(false)
    expect(store.snapshot(application.applicationId)).toBeUndefined()
  })

  it('subscribes a hook to its Application segment', () => {
    const store = createAppletStateStore({ applications: { notes: application } })
    const { getByRole } = render(<ApplicationToggle store={store} />)
    const button = getByRole('button')
    expect(button.textContent).toBe('false')
    fireEvent.click(button)
    expect(button.textContent).toBe('true')
    expect(store.snapshot(application.applicationId)).toEqual({ open: true })
  })

  it('adopts replacement declarations without notifying a previous React consumer during render', async () => {
    const store = createAppletStateStore({ applications: { notes: application } })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Columns({ catalogue }) {
      const [columns] = useAppletState(catalogue, 'columns', {
        adopt: (value) => value.every((column) => catalogue.includes(column)) ? value : undefined,
      })
      return <output>{columns.join(',')}</output>
    }
    const scene = (catalogue) => (
      <AppletStateStoreContext.Provider value={store}>
        <AppletApplicationContext.Provider value={application}>
          <Columns catalogue={catalogue} key={catalogue.join(',')} />
        </AppletApplicationContext.Provider>
      </AppletStateStoreContext.Provider>
    )
    const view = render(scene(['product']))
    try {
      view.rerender(scene(['mixed']))
      expect(view.container.textContent).toBe('mixed')
      expect(store.snapshot(application.applicationId)).toEqual({ columns: ['mixed'] })
      await act(async () => {})
      expect(errors.mock.calls.filter(([message]) => String(message).includes('Cannot update a component'))).toEqual([])
    } finally {
      view.unmount()
      errors.mockRestore()
    }
  })

  it('delivers adopted values to retained consumers when the declaring render suspends', async () => {
    const store = createAppletStateStore({ applications: { notes: application } })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pending = new Promise(() => {})
    const adopt = (value) => value.every((column) => column === 'mixed') ? value : undefined
    function Observer() {
      const [columns] = useAppletState(['product'], 'columns')
      return <output>{columns.join(',')}</output>
    }
    function SuspendedDeclaration() {
      useAppletState(['mixed'], 'columns', { adopt })
      throw pending
    }
    const scene = (suspended) => (
      <AppletStateStoreContext.Provider value={store}>
        <AppletApplicationContext.Provider value={application}>
          <Observer />
          <React.Suspense fallback={<span>Suspended</span>}>
            {suspended ? <SuspendedDeclaration /> : null}
          </React.Suspense>
        </AppletApplicationContext.Provider>
      </AppletStateStoreContext.Provider>
    )
    const view = render(scene(false))
    try {
      await act(async () => { view.rerender(scene(true)) })
      expect(view.container.querySelector('output').textContent).toBe('mixed')
      expect(view.getByText('Suspended')).not.toBeNull()
      expect(store.snapshot(application.applicationId)).toEqual({ columns: ['mixed'] })
      expect(errors.mock.calls.filter(([message]) => String(message).includes('Cannot update a component'))).toEqual([])
    } finally {
      view.unmount()
      errors.mockRestore()
    }
  })
})

describe.each(['standalone', 'runtime'])('%s owner recognition', (adapter) => {
  function renderConsumer(consumer) {
    const store = createAppletStateStore({ applications: { notes: application } })
    function Owner({ children }) {
      return (
        <React.StrictMode>
          {adapter === 'runtime' ? (
            <AppletStateStoreContext.Provider value={store}>
              <AppletApplicationContext.Provider value={application}>
                {children}
              </AppletApplicationContext.Provider>
            </AppletStateStoreContext.Provider>
          ) : children}
        </React.StrictMode>
      )
    }
    return render(consumer, { wrapper: Owner })
  }

  it.each(['original', 'copy'])('retains inline %s recognition through edits and catalogue changes', (result) => {
    const observations = {}
    function Columns({ catalogue, recognize = true }) {
      const [columns, setValue] = useAppletState(['name'], 'columns', {
        adopt: recognize ? (value) => (
          value.every((key) => catalogue.includes(key))
            ? result === 'copy' ? [...value] : value
            : undefined
        ) : undefined,
      })
      observations.setColumns = setValue
      observations.currentColumns = columns
      return <span>{columns.join(',')}</span>
    }
    const view = renderConsumer(<Columns catalogue={['name', 'code']} />)
    const initialColumns = observations.currentColumns
    view.rerender(<Columns catalogue={['name', 'code']} />)
    expect(observations.currentColumns).toBe(initialColumns)

    act(() => observations.setColumns(['code']))
    expect(view.container.textContent).toBe('code')
    act(() => observations.setColumns((current) => [...current, 'name']))
    expect(view.container.textContent).toBe('code,name')
    view.rerender(<Columns catalogue={['name', 'code', 'other']} />)
    expect(view.container.textContent).toBe('code,name')

    view.rerender(<Columns catalogue={['name', 'other']} />)
    expect(view.container.textContent).toBe('name')
    act(() => observations.setColumns((current) => [...current, 'other']))
    expect(view.container.textContent).toBe('name,other')
    view.rerender(<Columns catalogue={[]} recognize={false} />)
    expect(view.container.textContent).toBe('name,other')
    act(() => observations.setColumns(['unlisted']))
    expect(view.container.textContent).toBe('unlisted')
  })

  it('recognizes equivalent inline objects without replacing their current value', () => {
    const observations = {}
    function Choice() {
      const [choice, setValue] = useAppletState({ order: ['name'], open: false }, 'choice', {
        adopt: (value) => ({ open: value.open, order: [...value.order] }),
      })
      observations.setChoice = setValue
      observations.currentChoice = choice
      return <span>{JSON.stringify(choice)}</span>
    }
    const view = renderConsumer(<Choice />)
    const initialChoice = observations.currentChoice
    view.rerender(<Choice />)
    expect(observations.currentChoice).toBe(initialChoice)
    act(() => observations.setChoice((current) => ({ ...current, open: true })))
    expect(observations.currentChoice).toEqual({ order: ['name'], open: true })
  })

  it('retains a stable replacement adopter without reinterpreting ordinary writes', () => {
    const observations = {}
    function Columns({ adopt }) {
      const [columns, setValue] = useAppletState(['name'], 'columns', { adopt })
      observations.setColumns = setValue
      return <span>{columns.join(',')}</span>
    }
    const original = (value) => value
    const replacement = (value) => value.filter((key) => key === 'name')
    const view = renderConsumer(<Columns adopt={original} />)
    view.rerender(<Columns adopt={replacement} />)
    expect(view.container.textContent).toBe('name')
    act(() => observations.setColumns(['code']))
    expect(view.container.textContent).toBe('code')
    view.rerender(<Columns />)
    expect(view.container.textContent).toBe('code')
  })

  it('keeps identity-preserving live recognition outside persistent JSON', () => {
    const first = { callback() {}, stream: new Map([['name', true]]) }
    const next = { callback() {}, stream: new Map([['code', true]]) }
    const observations = {}
    function Live() {
      const [live, setValue] = useAppletState(first, 'live', {
        adopt: (value) => value,
        persistent: false,
      })
      observations.setLive = setValue
      observations.currentLive = live
      return <span>{[...live.stream.keys()].join(',')}</span>
    }
    const view = renderConsumer(<Live />)
    view.rerender(<Live />)
    expect(observations.currentLive).toBe(first)
    act(() => observations.setLive(next))
    expect(observations.currentLive).toBe(next)
    expect(view.container.textContent).toBe('code')
    act(() => observations.setLive((current) => current))
    expect(observations.currentLive).toBe(next)
  })

  it('applies stable live-value recognizers again after ordinary writes and callback returns', () => {
    const initial = { name: 'current', callback() {} }
    const observations = {}
    function Live({ adopt }) {
      const [live, setValue] = useAppletState(initial, 'live', {
        adopt,
        persistent: false,
      })
      observations.setLive = setValue
      observations.currentLive = live
      return <span>{live.name}</span>
    }
    const original = (value) => ({ ...value, name: value.name.toUpperCase() })
    const replacement = (value) => ({ ...value })
    const view = renderConsumer(<Live adopt={original} />)

    view.rerender(<Live adopt={replacement} />)
    expect(observations.currentLive).toEqual(initial)
    expect(observations.currentLive).not.toBe(initial)
    expect(observations.currentLive.callback).toBe(initial.callback)

    act(() => observations.setLive((current) => ({ ...current, name: 'edited' })))
    expect(view.container.textContent).toBe('edited')
    view.rerender(<Live adopt={original} />)
    expect(view.container.textContent).toBe('EDITED')
    expect(observations.currentLive.callback).toBe(initial.callback)

    view.rerender(<Live adopt={replacement} />)
    act(() => observations.setLive({ name: 'another', callback: initial.callback }))
    view.rerender(<Live adopt={original} />)
    expect(view.container.textContent).toBe('ANOTHER')
    expect(observations.currentLive.callback).toBe(initial.callback)

    const retained = observations.currentLive
    const identity = (value) => value
    view.rerender(<Live adopt={identity} />)
    expect(observations.currentLive).toBe(retained)
    view.rerender(<Live adopt={original} />)
    expect(observations.currentLive).toEqual(retained)
    expect(observations.currentLive).not.toBe(retained)
  })
})
