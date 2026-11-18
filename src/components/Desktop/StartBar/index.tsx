import type { PropsWithChildren } from 'react'
import css from './index.module.css'

export default function StartBar({ children }: PropsWithChildren) {
  return (
    <div className={css.StartBar}>
      {
        // renderHiddenWindowButtons(HiddenWindowButton)
        children
      }
    </div>
  )
}
