import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DraggableResizable from '.'

function dragEvent(element: Element, type: string, clientX: number, clientY: number) {
  const event = new MouseEvent(type.toLowerCase(), { bubbles: true, clientX, clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { setDragImage: vi.fn() } })
  fireEvent(element, event)
}

describe('DraggableResizable', () => {
  it.each([
    ['top-left corner', 0, 15, 27, 95, 73],
    ['top-right corner', 1, 10, 27, 105, 73],
    ['bottom-left corner', 2, 15, 20, 95, 87],
    ['bottom-right corner', 3, 10, 20, 105, 87],
    ['top edge', 4, 10, 27, 100, 73],
    ['bottom edge', 5, 10, 20, 100, 87],
    ['left edge', 6, 15, 20, 95, 80],
    ['right edge', 7, 10, 20, 105, 80],
    ['top-left edge end', 8, 15, 27, 95, 73],
    ['top-right edge end', 9, 10, 27, 105, 73],
    ['bottom-left edge end', 10, 15, 20, 95, 87],
    ['bottom-right edge end', 11, 10, 20, 105, 87],
    ['left-top edge end', 12, 15, 27, 95, 73],
    ['left-bottom edge end', 13, 15, 20, 95, 87],
    ['right-top edge end', 14, 10, 27, 105, 73],
    ['right-bottom edge end', 15, 10, 20, 105, 87],
  ] as const)('resizes from the %s', (_, index, left, top, width, height) => {
    const { container } = render(
      <DraggableResizable
        initialPosition={{ left: 10, top: 20 }}
        initialSize={{ width: 100, height: 80 }}
      />
    )
    const handle = container.querySelectorAll('[draggable="true"]')[index]
    dragEvent(handle, 'dragStart', 30, 40)
    dragEvent(handle, 'drag', 35, 47)
    expect(container.firstElementChild).toHaveStyle({
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    })
    dragEvent(handle, 'dragEnd', 35, 47)
    dragEvent(handle, 'drag', 50, 60)
    expect(container.firstElementChild).toHaveStyle({ width: `${width}px`, height: `${height}px` })
  })

  it('ignores drag events before a drag starts and moves from the saved position', () => {
    const { container } = render(
      <DraggableResizable
        initialPosition={{ left: 10, top: 20 }}
        render={({ draggableProps }) => <div {...draggableProps}>Title</div>}
      />
    )
    const title = screen.getByText('Title')
    dragEvent(title, 'drag', 35, 47)
    expect(container.firstElementChild).toHaveStyle({ left: '10px', top: '20px' })
    dragEvent(title, 'dragStart', 30, 40)
    dragEvent(title, 'drag', 35, 47)
    expect(container.firstElementChild).toHaveStyle({ left: '15px', top: '27px' })
  })

  it('ignores resize arithmetic for maximised dimensions', () => {
    const { container } = render(
      <DraggableResizable initialSize={{ width: 'max', height: 'max' }} />
    )
    const handle = container.querySelector('[draggable="true"]')!
    dragEvent(handle, 'dragStart', 30, 40)
    dragEvent(handle, 'drag', 35, 47)
    expect(container.firstElementChild).toHaveStyle({ width: '100%', height: '100%' })
  })

  it('restores saved bounds and ignores restore without a saved state', () => {
    const { container } = render(
      <DraggableResizable
        initialPosition={{ left: 10, top: 20 }}
        initialSize={{ width: 100, height: 80 }}
        render={({ controllers }) => (
          <>
            <button onClick={controllers.maximise}>Maximise</button>
            <button onClick={controllers.unmaximise}>Restore</button>
          </>
        )}
      />
    )
    const bounds = { left: '10px', top: '20px', width: '100px', height: '80px' }
    fireEvent.click(screen.getByText('Restore'))
    expect(container.firstElementChild).toHaveStyle(bounds)
    fireEvent.click(screen.getByText('Maximise'))
    expect(container.firstElementChild).toHaveStyle({
      left: '0px',
      top: '0px',
      width: '100%',
      height: '100%',
    })
    fireEvent.click(screen.getByText('Restore'))
    expect(container.firstElementChild).toHaveStyle(bounds)
    fireEvent.click(screen.getByText('Restore'))
    expect(container.firstElementChild).toHaveStyle(bounds)
  })
})
