import type { PropsWithChildren } from 'react'
import type { WindowId } from '../../react-window-manager/hooks/useWindowManagerRegistry'
import useWindowManager from '../../react-window-manager/hooks/useWindowManager'

export default function Desktop({ windowId, children }: PropsWithChildren<{ windowId: WindowId }>) {
  // const s= useContext( WindowManagerContext);

  const { renderChildrenWindows, childrenWindowController } = useWindowManager(windowId)

  return (
    <>
      {children}
      {renderChildrenWindows(childrenWindowController)}
    </>
  )
}
