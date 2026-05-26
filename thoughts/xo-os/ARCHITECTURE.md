# xo-os Architecture

The marketing surface for XO, rendered as a desktop-style website. Clean-room implementation of PostHog.com's published OS-aesthetic pattern. No PostHog source is reused.

This document describes the current state of the `xo-os` repo only. For where xo-os sits in the larger XO product (Coworker, Swarm, cowork-api, swarm-api, docs, room, internal), see `../CLAUDE.md`.

## 1. Stack at a glance

| Layer | Choice | Version (per [package.json](package.json)) | Why |
|---|---|---|---|
| Framework | Gatsby | 5.13.7 | Static SSG, file-system routing, MDX, plugin ecosystem |
| UI runtime | React | 18.3.1 | Stable hooks, no Server Components needed (Gatsby is SSG) |
| Language | TypeScript | 5.5.3 | Strict mode, path aliases via `tsconfig.json` |
| Styling | Tailwind CSS | 3.4.4 | Utility-first; brand tokens in [tailwind.config.ts](tailwind.config.ts) |
| Animation / drag | Framer Motion | 11.5.4 | `useDragControls`, `dragConstraints`, spring transitions |
| Images | gatsby-plugin-image + sharp | 3.13.1 / 0.32.6 | Static asset pipeline |
| Content | gatsby-plugin-mdx | 5.13.1 | MDX handbook (wired, empty for now) |
| Meta tags | gatsby-plugin-react-helmet | 6.13.1 | Per-page `<Head>` (deprecated by Gatsby's built-in Head API; warning shown in dev) |
| Build scripts | pnpm + native rebuilds | pnpm 10 | `sharp`, `lmdb`, `gatsby-cli` listed under `pnpm.onlyBuiltDependencies` |
| Node | >= 20 | per `.nvmrc` | |

Dev server: `gatsby develop` on port 8001 (configured in [.claude/launch.json](.claude/launch.json)).

## 2. File map

```
xo-os/
├── gatsby-browser.tsx       wrapPageElement on the client
├── gatsby-ssr.tsx           identical wrap for SSR (hydration parity)
├── gatsby-config.ts         plugins + siteMetadata
├── tailwind.config.ts       XO brand tokens (lime, ink, chrome)
├── postcss.config.js        Tailwind / autoprefixer pipeline
├── tsconfig.json            strict, path aliases under src/
├── .claude/launch.json      dev server config consumed by preview_start
├── .xo/                     watcher-owned activity log; do not edit
│
├── content/handbook/        MDX content source (currently empty)
│
└── src/
    ├── context/
    │   └── AppContext.tsx   THE windowing system: state, routing, shortcuts
    │
    ├── components/
    │   ├── Wrapper.tsx          top-level layout, experience branch
    │   ├── TaskBar.tsx          top menu bar (logo, nav, CTA)
    │   ├── Desktop.tsx          wallpaper + two icon columns
    │   ├── DesktopIcon.tsx      single icon, opens window or external URL
    │   ├── AppWindow.tsx        chrome + drag + resize for one window
    │   ├── BoringFallback.tsx   <1024px fallback (static stacked page)
    │   └── apps/
    │       ├── EditorApp.tsx        chrome for "/"
    │       ├── ReaderApp.tsx        chrome for long-form (pricing, docs)
    │       └── PresentationApp.tsx  chrome for product pages
    │
    ├── data/
    │   ├── appSettings.ts       per-route window config (size, appType)
    │   └── desktopIcons.ts      desktop icon list (16 entries; 5 live routes)
    │
    ├── pages/                   Gatsby file routes (1 file = 1 route = 1 window)
    │   ├── index.tsx               /
    │   ├── coworker.tsx            /coworker
    │   ├── swarm.tsx               /swarm
    │   ├── pricing.tsx             /pricing
    │   └── trash.tsx               /trash
    │
    ├── styles/global.css        tokens, wallpaper, touch-safe rules
    └── types/index.ts           AppSettings, WindowState, DesktopIconDef
```

## 3. Component tree

```
Browser tab
  └─ Gatsby wrapPageElement  ── identical in gatsby-browser.tsx + gatsby-ssr.tsx
       │
       └─ <AppProvider element={pageElement} location={location}>
            │  ┌─────────────────────────────────────────┐
            │  │ owns: windows[], focusedKey, experience │
            │  │ refs: constraintsRef, zCounter          │
            │  │ actions: open/close/focus/minimize/...  │
            │  │ effects: route -> window, key shortcuts │
            │  └─────────────────────────────────────────┘
            │
            └─ <Wrapper>
                 │
                 ├── if experience === "boring"
                 │      └─ <BoringFallback />          (single static page)
                 │
                 └── else  (>= 1024px viewport)
                      ├─ <TaskBar />                  (top menu)
                      └─ <div ref={constraintsRef}>   (desktop area, drag bounds)
                           ├─ <Desktop>
                           │    ├─ left column:  <DesktopIcon /> x N
                           │    └─ right column: <DesktopIcon /> x N
                           │
                           └─ <AnimatePresence>
                                <AppWindow window={w} /> x N    (one per open route)
                                  ├─ title bar
                                  │   ├─ close / minimize / maximize chips
                                  │   └─ drag handle (pointer down on title bar)
                                  ├─ body: switch on appSettings.appType
                                  │     editor       -> <EditorApp>{element}</EditorApp>
                                  │     reader       -> <ReaderApp title={...}>{element}</ReaderApp>
                                  │     presentation -> <PresentationApp>{element}</PresentationApp>
                                  │     explorer/video/form -> falls back to ReaderApp
                                  │   where {element} is the Gatsby page (HomePage, CoworkerPage, ...)
                                  └─ resize handle (bottom-right corner)
```

## 4. Core abstraction: the windowing system

[AppContext.tsx](src/context/AppContext.tsx) is the heart. Every page goes through it; pages themselves are dumb bodies.

State shape:

```ts
WindowState {
  key: string          // stable identity (usually the pathname)
  path: string         // route this window represents
  element: ReactNode   // the Gatsby page body
  position: { x, y }
  size: { width, height }
  zIndex: number
  minimized: boolean
  appSettings: AppSettings   // resolved from appSettings.ts
  title: string
}
```

Three actions to know:

| Action | When | Effect |
|---|---|---|
| `spawnWindow(path, opts)` | First time a path opens | Pushes a new `WindowState` with resolved settings, centers it, focuses it |
| `bringToFront(key)` | Click an existing window, or reopen a route already open | Bumps `zIndex`, un-minimizes, sets `focusedKey` |
| `updateWindow(key, patch)` | Drag end, resize move, route element refresh | Merges patch into the window |

The route effect at [AppContext.tsx:172](src/context/AppContext.tsx#L172) is the only place that ties Gatsby routing to the window model. Pseudocode:

```
on location.pathname or element change:
  path = location.pathname (normalized)
  if lastSyncedPath === path AND a window already exists for path:
    skip
  remember lastSyncedPath = path
  existing = windows.find(w => w.path === path)
  if existing AND not state.newWindow:
    bringToFront(existing.key)
    updateWindow(existing.key, { element })   // refresh body with latest Gatsby element
  else:
    spawnWindow(path, { element })
```

## 5. User journeys

### 5.1 First page load at `/`

```
User -> http://localhost:8001/
   │
   ▼
[Gatsby SSG output for /]
   gatsby-ssr.tsx wraps <HomePage /> in <AppProvider element=<HomePage/> ...>
   HTML streams to the browser, head set via gatsby-plugin-react-helmet
   │
   ▼
[Hydration on the client]
   gatsby-browser.tsx mounts the same tree
   │
   ▼
[AppProvider initial render]
   useState: windows=[], focusedKey=null, experience="xo"
   constraintsRef attached to Wrapper's desktop div
   │
   ▼
[Effect: responsive gate]
   decide() reads window.innerWidth
     >= 1024 -> setExperience("xo")
     <  1024 -> setExperience("boring")   (Wrapper short-circuits to BoringFallback)
   │
   ▼
[Effect: route -> window]
   location.pathname = "/"
   no existing window -> spawnWindow("/", { element: <HomePage/> })
     resolveAppSettings("/") -> { appType: "editor", size: 960x720, center: true }
     getDesktopCenter(...) -> { x, y }
     windows = [ WindowState(key:"/", element:<HomePage/>, ...) ]
   │
   ▼
[Wrapper renders]
   <TaskBar />
   <Desktop>  (icons from desktopIcons.ts)
   <AppWindow window={w} />
     -> EditorApp
          -> <HomePage />            <-- user sees this
```

### 5.2 Click "Workspaces" in the TaskBar

```
User clicks TaskBar button (path="/coworker")
   │
   ▼
TaskBar.nav("/coworker")
   ├─ openWindow("/coworker")
   │     │
   │     existing? -> No
   │     spawnWindow("/coworker", { element: null })
   │       resolveAppSettings("/coworker") -> { appType: "presentation", 1100x800 }
   │       windows.push(new window, element: null)
   │
   └─ navigate("/coworker")                       (Gatsby client-side)
        │
        ▼
   [location.pathname changes to "/coworker"]
        │
        ▼
   [AppProvider route effect re-runs]
        existing? -> YES (just spawned)
        not state.newWindow -> bringToFront(key)
        updateWindow(key, { element: <CoworkerPage/> })   <-- real element lands here
        │
        ▼
   React re-renders that AppWindow
     PresentationApp receives the element
       -> <CoworkerPage /> visible inside the window chrome
```

Why two steps (spawn with null, then update with element)? Because `openWindow` is a synchronous imperative call from a click handler, but the page element only arrives after Gatsby's router has run. The split keeps the window appearing instantly while the body fills in on the next tick.

### 5.3 Double-click a desktop icon

```
DesktopIcon.onActivate (also bound to onClick so single-tap works on touch)
   ├─ icon.href set? -> window.open(href, "_blank")              [external link]
   └─ else -> openWindow(icon.path) ; navigate(icon.path)        [same flow as 5.2]
```

### 5.4 Drag a window

```
pointerdown on title bar
   │
   ▼
AppWindow.onTitleBarPointerDown
   ├─ target.closest("[data-window-control]") ? return  (don't drag when clicking chip buttons)
   ├─ bringToFront(w.key)
   │     ├─ zCounter += 1
   │     ├─ windows = windows.map(set zIndex on w.key, minimized: false)
   │     └─ setFocusedKey(w.key)
   └─ dragControls.start(e)            (framer-motion takes over)
   │
   ▼  (user drags)
   motion.div.transform updates within constraintsRef bounds
   │
   ▼  (pointerup)
onDragEnd(info)
   updateWindow(w.key, {
     position: { x: w.position.x + info.offset.x,
                 y: w.position.y + info.offset.y }
   })
```

### 5.5 Resize a window

```
pointerdown on bottom-right resize handle
   │
   ▼
inline pointermove + pointerup listeners on window
   on every move:
     dw = clientX - startX,  dh = clientY - startY
     clamp(min/max from appSettings.size)
     updateWindow(key, { size: { width: clamped, height: clamped } })
   on up:
     remove listeners
```

The resize handle is plain pointer events (not framer-motion). `touch-action: none` in [global.css](src/styles/global.css) prevents iOS Safari from scrolling instead of resizing. `@media (pointer: coarse)` enlarges the handle's hit area to 24x24 px.

### 5.6 Minimize, maximize, close

```
title bar buttons (data-window-control set so they don't trigger drag)

  red chip    -> closeWindow(key)
                   windows = windows.filter(w !== key)
                   focusedKey = null if was focused

  yellow chip -> minimizeWindow(key, true)
                   sets minimized: true
                   AppWindow animates: opacity 0, scale 0.9, pointerEvents: none

  lime chip   -> updateWindow(key, { size: 1400x900, position: {40,20} })
                   "maximize" is just a big preset, not a true fullscreen
```

### 5.7 Keyboard shortcuts

```
keydown listener on window (skipped if target is INPUT or TEXTAREA)
   Shift+W -> closeWindow(focusedKey)
   Shift+X -> closeAllWindows()
```

### 5.8 Below the OS breakpoint

```
window resize event
   decide() recomputes
     viewport.w < 1024 -> experience = "boring"
       Wrapper short-circuits before reaching TaskBar / Desktop / AppWindow
       <BoringFallback /> renders: a static page with logo, headline, CTA
       no windowing, no drag, no chrome
```

## 6. Data sources

```
[ src/data/appSettings.ts ]   per-route window config
        │
        ▼  resolveAppSettings(path)                consulted on every spawnWindow
        ▼
[ AppContext.spawnWindow ]


[ src/data/desktopIcons.ts ]  static array of 16 icons (left and right columns)
        │
        ▼  Desktop.tsx filters by column           rendered as DesktopIcon[]
        ▼
[ <Desktop /> ]


[ src/pages/*.tsx ]           one file per route, exports default + Head
        │
        ▼  Gatsby file-system routing              becomes page element
        ▼
[ wrapPageElement ] -> [ AppProvider.element ] -> window body
```

## 7. Styling and brand

Brand tokens live in two places that must stay in sync:

- [tailwind.config.ts](tailwind.config.ts): `lime.400 = #83d63a` (brand), `ink.900 = #08090A` (canvas), `chrome.dark = #16181a` (window).
- [src/styles/global.css](src/styles/global.css): CSS custom properties (`--color-lime`, `--color-ink`, `--window-bg`) and the radial-gradient wallpaper.

Touch-safety rules in `global.css`:

- `min-height: 100dvh` on body so iOS Safari's address bar shrinking doesn't break layout.
- `touch-action: none` on `.window-titlebar` and `.window-resize-handle` to stop the page from scrolling when the user drags a window on iPad.
- `@media (pointer: coarse)` enlarges the resize handle hit area.

## 8. What is wired but not done

These are loose ends visible from the code, not bugs in what is built:

- **MDX pipeline is empty.** [gatsby-config.ts](gatsby-config.ts#L25-L37) sources `content/handbook/` and `gatsby-plugin-mdx` is registered, but the directory has no files. No `/handbook` route exists yet to render any.
- **Typography plugin missing.** [ReaderApp.tsx:37](src/components/apps/ReaderApp.tsx#L37) uses `prose prose-invert`, but `@tailwindcss/typography` is not in [package.json](package.json). Long-form pages (Pricing, Trash) render unstyled inside Reader chrome.
- **11 of 16 desktop icons 404.** Only `/`, `/coworker`, `/swarm`, `/pricing`, `/trash` have page files. Clicking the others (`/customers`, `/demo`, `/docs`, `/ask`, `/about`, `/changelog`, `/handbook`, `/store`, `/careers`, `/talk-to-a-human`, `/community` from TaskBar) hits Gatsby's 404 page.
- **No persistence.** Window positions, open set, focus order reset on reload. Plan, week 4, ties this to Clerk + xo-cowork-api state.
- **Helmet is deprecated.** Gatsby 5 logs a warning to migrate to the built-in Head API. The pages already export `Head: HeadFC`, so `gatsby-plugin-react-helmet` can probably be removed.
- **Stale comment.** [AppContext.tsx:48](src/context/AppContext.tsx#L48) says `"posthog" = full OS` but the type is `"xo" | "boring"`.
- **No `gatsby-node.ts`** even though [tsconfig.json:30](tsconfig.json#L30) includes it.
- **No tests, no analytics, no sitemap, no robots.** All on the Phase 5 backlog in [PLAN.md](PLAN.md).

## 9. Where this fits in the XO product

xo-os is the marketing surface; it is not part of the Coworker workspace or the Swarm control plane. From [`../CLAUDE.md`](../CLAUDE.md):

```
                          xo.builders / os.xo.builders
                                  (this repo)
                                       │
                                       ▼
                                  Sign-up CTA
                                       │
                                       ▼
                         app.xo.builders (Clerk-backed)
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
                    xo-swarm (UI)            xo-swarm-api
                          │                         │
                          └──── launches ────┐
                                             ▼
                                     a Coworker workspace
                                  (xo-coworker + xo-cowork-api)
```

xo-os only owns the public storefront. Auth, billing, projects, agents, integrations all live elsewhere.

## 10. Reading order for a new contributor

1. [PLAN.md](PLAN.md): the why and the phased roadmap.
2. [package.json](package.json) + [gatsby-config.ts](gatsby-config.ts): the dependencies and plugin list.
3. [src/types/index.ts](src/types/index.ts): the data model in one screen.
4. [src/context/AppContext.tsx](src/context/AppContext.tsx): the windowing system. Everything else is decoration around it.
5. [src/components/Wrapper.tsx](src/components/Wrapper.tsx) -> [AppWindow.tsx](src/components/AppWindow.tsx): how state becomes pixels.
6. [src/data/appSettings.ts](src/data/appSettings.ts): how per-route window behavior is declared.
7. Then walk through any one page (e.g. [src/pages/index.tsx](src/pages/index.tsx)) to see how thin pages are: they only export a body and a Head; the OS shell does the rest.
