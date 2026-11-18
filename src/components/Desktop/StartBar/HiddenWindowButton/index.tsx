import type { MouseEventHandler, ReactNode } from 'react'
import type { WindowId } from '../../../../react-window-manager/hooks/useWindowManagerRegistry'
import css from './index.module.css'

interface HiddenWindowButtonProps {
  title?: ReactNode
  windowId?: WindowId
  onClick_unhide?: MouseEventHandler<HTMLButtonElement>
}

export default function HiddenWindowButton({ title, onClick_unhide }: HiddenWindowButtonProps) {
  return (
    <button
      className={css.HiddenWindowButton}
      type={'button'}
      onClick={onClick_unhide}
    >
      {title}
    </button>
  )
}
