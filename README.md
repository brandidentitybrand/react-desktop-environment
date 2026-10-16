# react-desktop-environment

Desktop-style windowing for React. It provides:

- `Window`: a draggable, resizable window with a title bar and minimise,
  collapse and fullscreen controls
- `Desktop.StartBar` and `Desktop.HiddenWindowButton`: a bar for restoring
  minimised windows
- `WindowManagerRegistryProvider`, `useWindowManager` and
  `useWindowManagerRegistry`: a window manager that tracks nested windows and
  their active, hidden and closed state
- `Button`: a basic styled button

The package ships ES modules with TypeScript declarations. Component styles are
imported automatically, so you don't need a separate CSS import.

> Status: pre-1.0. Under 0.x, minor versions may contain breaking changes.

## Installation

`react` and `react-dom` are peer dependencies. Versions 18.3 and 19 are
supported.

```sh
npm install react-desktop-environment react react-dom
```

## Usage

### A single window

```tsx
import { Window } from 'react-desktop-environment'

export default function App() {
  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <Window
        title='Notes'
        windowType='fullscreen'
        windowBorderWidth={5}
        initialPosition={{ top: 40, left: 40 }}
        initialSize={{ width: 400, height: 300 }}
      >
        <p>Hello from a window.</p>
      </Window>
    </div>
  )
}
```

`Window` props:

| Prop                    | Type                              | Description                                              |
| ----------------------- | --------------------------------- | -------------------------------------------------------- |
| `title`                 | `string`                          | Text shown in the title bar                              |
| `windowType`            | `'collapse' \| 'fullscreen'`      | Which extra control the title bar shows (default `collapse`) |
| `windowBorderWidth`     | `number`                          | Width of the resize border in px                         |
| `initialPosition`       | `{ top: number; left: number }`   | Position on first render                                 |
| `initialSize`           | `{ width: number \| 'max'; height: number \| 'max' }` | Size on first render                 |
| `draggable`             | `boolean`                         | Whether the window can be dragged                        |
| `onClick_minimise`      | `() => void`                      | Called when the minimise button is clicked               |
| `controllerSideEffects` | `object`                          | Callbacks fired when position, size or draggable changes |

### Nested windows with the window manager

Describe your windows in a `sessionWindowSpecs` object, register the components
they use, and render each window with `useWindowManager`:

```tsx
import {
  Desktop,
  Window,
  WindowManagerRegistryProvider,
  useWindowManager,
} from 'react-desktop-environment'

function AppWindow(props: any) {
  const { windowId, windowController, ...windowProps } = props
  const {
    renderChildrenWindows,
    renderHiddenWindowButtons,
    childrenWindowController,
  } = useWindowManager(windowId)

  return (
    <Window
      {...windowProps}
      onMouseDown={() => windowController?.moveWindowToTop(windowId)}
      onClick_minimise={() => windowController?.hideWindow(windowId)}
    >
      {renderChildrenWindows(childrenWindowController)}
      <Desktop.StartBar>
        {renderHiddenWindowButtons(Desktop.HiddenWindowButton)}
      </Desktop.StartBar>
    </Window>
  )
}

const sessionWindowSpecs = {
  root: {
    componentName: 'AppWindow',
    props: { title: 'Desktop', initialSize: { width: 800, height: 600 } },
    windows: { active: ['notes'], hidden: [], closed: [] },
    registeredIn: [],
  },
  notes: {
    componentName: 'AppWindow',
    props: {
      title: 'Notes',
      initialPosition: { top: 50, left: 50 },
      initialSize: { width: 300, height: 200 },
    },
    windows: { active: [], hidden: [], closed: [] },
    registeredIn: ['root'],
  },
}

export default function App() {
  return (
    <WindowManagerRegistryProvider
      sessionWindowSpecs={sessionWindowSpecs}
      components={{ AppWindow }}
    >
      <AppWindow windowId='root' />
    </WindowManagerRegistryProvider>
  )
}
```

The window controls use the Material Symbols icon font, which the package
loads from Google Fonts.
