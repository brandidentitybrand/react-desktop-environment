import { resolveDeckProps } from './deckProps.js'

function retainedProps(props = {}) {
  const { resident, order, peelProvisional, ...retained } = props
  if (retained.presentationMode !== 'preview') return retained
  const { presentationMode, ...ordinary } = retained
  return ordinary
}

/** Occurrence transactions; pointer input, confirmation and paint stay with UI. */
export default function createSurfaceTransfer({ compositor, runtime, retainDeck, restoreSelection }) {
  const pending = new Set()
  const read = (surfaceId) => surfaceId
    ? compositor.surface.read({ surfaceId }) : null
  const controls = (surfaceId) => compositor.surface.readControls({ surfaceId })
  const close = (surfaceId) => {
    if (read(surfaceId)) controls(surfaceId).close()
  }
  const parentOf = (surface) => Object.values(compositor.getSnapshot().surfaces)
    .find(({ windowId }) => windowId === surface?.window.parentWindowId)

  function beginPeel({
    surfaceId, applicationId, applicationProps, surfaceProps,
    ownerSurfaceId, deckApplicationId,
  }) {
    const original = read(surfaceId)
    if (surfaceId && !original) return null
    if (!read(ownerSurfaceId)) return null
    const parent = parentOf(original)
    const parentWindowId = original?.window.parentWindowId
    const selectedSurfaceId = parent?.selectedChildSurfaceId ?? null
    const presentedSurfaceId = parent
      ? runtime.readSelectedChild({ surfaceId: parent.surfaceId })?.surfaceId : null
    const selectedResident = original?.props.resident?.containerSurfaceId === parent?.surfaceId
      && presentedSurfaceId === original?.surfaceId
    const release = retainDeck(parent?.surfaceId, {
      selectedSurfaceId: selectedResident ? presentedSurfaceId : undefined,
    })
    const captured = original && {
      fullscreen: original.fullscreen,
      hidden: original.hidden,
      zIndex: original.zIndex,
      attentionRevision: original.attentionRevision,
      workspaceId: original.workspaceId,
      position: original.position,
      size: original.size,
      restoreGeometry: original.restoreGeometry,
      props: original.props,
    }
    const allocated = []
    const createApplication = options => {
      const before = compositor.getSnapshot().applications
      const application = runtime.createApplicationInstance(options)
      Object.keys(compositor.getSnapshot().applications).forEach((id) => {
        if (!Object.hasOwn(before, id)) allocated.push(id)
      })
      return application
    }
    const discardApplications = () => {
      const { applications, surfaces } = compositor.getSnapshot()
      allocated.forEach((applicationId) => {
        if (applications[applicationId] && !Object.values(surfaces).some(surface => surface.applicationId === applicationId)) {
          compositor.application.remove({ applicationId })
        }
      })
    }
    const transfer = { movingSurfaceId: original?.surfaceId }

    const finish = () => {
      transfer.settled = true
      transfer.stopObservation?.()
      pending.delete(cancel)
    }
    const restoreCapturedSelection = () => {
      const owner = read(parent?.surfaceId)
      const child = read(selectedSurfaceId)
      if (!owner) return
      if (selectedSurfaceId && child?.window.parentWindowId !== owner.windowId) return
      if (selectedSurfaceId === original?.surfaceId && captured.fullscreen && !child.fullscreen) return
      restoreSelection({ surfaceId: owner.surfaceId, childSurfaceId: selectedSurfaceId })
    }
    const selectReplacement = () => {
      if (!selectedResident || !read(parent.surfaceId)) return
      const replacement = compositor.surface.readChildren({ surfaceId: parent.surfaceId })
        .find(({ props }) => props.resident?.key === original.props.resident.key)
      if (replacement) runtime.selectChild({
        surfaceId: parent.surfaceId, childSurfaceId: replacement.surfaceId,
      })
    }
    const retainObject = id => {
      const surface = read(id)
      compositor.surface.update({ surfaceId: id, props: retainedProps(surface.props) })
    }
    const cancel = () => {
      if (transfer.settled) return false
      finish()
      try {
        const originalParentExists = parentWindowId === null
          || compositor.windowManager.window.read({ windowId: parentWindowId })
        if (original && read(transfer.movingSurfaceId) && originalParentExists) {
          compositor.windowManager.window.move({ windowId: original.windowId, parentWindowId })
          compositor.surface.update({ surfaceId: transfer.movingSurfaceId, ...captured })
        }
        if (!original) close(transfer.movingSurfaceId)
        close(transfer.provisionalDeckId)
        discardApplications()
        restoreCapturedSelection()
      } finally {
        release()
      }
      return true
    }
    const retain = ({ geometry } = {}) => {
      if (transfer.settled) return false
      if (!read(transfer.movingSurfaceId) || !read(transfer.frameSurfaceId)) {
        cancel()
        return false
      }
      compositor.surface.update({ surfaceId: transfer.frameSurfaceId, ...geometry, hidden: false })
      retainObject(transfer.movingSurfaceId)
      if (transfer.provisionalDeckId) retainObject(transfer.provisionalDeckId)
      finish()
      release()
      selectReplacement()
      return true
    }
    const remove = () => {
      if (transfer.settled) return false
      finish()
      try {
        close(transfer.movingSurfaceId)
        close(transfer.provisionalDeckId)
        discardApplications()
      } finally {
        release()
      }
      selectReplacement()
      return true
    }

    try {
      if (original?.fullscreen) controls(surfaceId).exitFullscreen()
      if (deckApplicationId && !runtime.isDeckSurface({ surfaceId })) {
        const application = createApplication({
          applicationId: deckApplicationId,
        })
        const deck = runtime.createReferenceSurface({
          applicationId: application.applicationId, ownerSurfaceId,
          surfaceProps: { peelProvisional: true },
        })
        transfer.provisionalDeckId = deck.surfaceId
      }
      const destinationId = transfer.provisionalDeckId ?? ownerSurfaceId
      if (original) {
        controls(surfaceId).reparent(destinationId)
        compositor.surface.update({ surfaceId, hidden: false })
      } else {
        const application = createApplication({
          applicationId, props: applicationProps, cloneState: true,
        })
        const surface = runtime.createReferenceSurface({
          applicationId: application.applicationId, ownerSurfaceId: destinationId,
          surfaceProps: { ...surfaceProps, peelProvisional: true },
        })
        transfer.movingSurfaceId = surface.surfaceId
      }
      if (transfer.provisionalDeckId) runtime.selectChild({
        surfaceId: transfer.provisionalDeckId, childSurfaceId: transfer.movingSurfaceId,
      })
      restoreCapturedSelection()
      transfer.frameSurfaceId = transfer.provisionalDeckId ?? transfer.movingSurfaceId
      controls(transfer.frameSurfaceId).focus()
      transfer.stopObservation = compositor.subscribe(() => {
        if (read(transfer.movingSurfaceId) && read(transfer.frameSurfaceId)) return
        transfer.stopObservation()
        queueMicrotask(cancel)
      })
      pending.add(cancel)
      return Object.freeze({ movingSurfaceId: transfer.movingSurfaceId, frameSurfaceId: transfer.frameSurfaceId, cancel, retain, remove })
    } catch (error) {
      cancel()
      throw error
    }
  }

  function mergeDeck({ surfaceId, targetSurfaceId }) {
    const source = read(surfaceId)
    const target = read(targetSurfaceId)
    if (!source || !target || surfaceId === targetSurfaceId) return false
    const windows = compositor.windowManager.getSnapshot().windows
    const hasSourceAncestor = window => window && (window.windowId === source.windowId || hasSourceAncestor(windows[window.parentWindowId]))
    if (hasSourceAncestor(target.window)) return false
    if (!runtime.isDeckSurface({ surfaceId: targetSurfaceId })) return false
    if (!resolveDeckProps(target.props).addable) return false
    const sourceIsDeck = runtime.isDeckSurface({ surfaceId })
    const children = sourceIsDeck
      ? compositor.surface.readChildren({ surfaceId }) : [source]
    const selected = sourceIsDeck
      ? runtime.readSelectedChild({ surfaceId })?.surfaceId : surfaceId
    const release = retainDeck(surfaceId)
    try {
      children.forEach((child) => { controls(child.surfaceId).reparent(targetSurfaceId) })
      if (sourceIsDeck) close(surfaceId)
      children.forEach((child) => {
        const current = read(child.surfaceId)
        compositor.surface.update({ surfaceId: child.surfaceId, props: retainedProps(current.props) })
      })
      if (selected) runtime.selectChild({ surfaceId: targetSurfaceId, childSurfaceId: selected })
    } finally {
      release()
    }
    return true
  }

  return {
    beginPeel,
    mergeDeck,
    destroy() {
      pending.forEach((cancel) => { cancel() })
    },
  }
}
