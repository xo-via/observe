# xo-phone-os, Lifecycle and Animation

Two questions this doc answers:

1. **How does the iPhone load on each page?** What runs in what order
   from the moment a request hits Next.js to the moment the OS shell
   is interactive.
2. **What do we do if we want richer animation?** Two distinct
   extensions: animated content *inside* an app, and animating /
   theming the *outer shell* itself.

Read alongside `ARCHITECTURE.md` for the static structure; this doc is
about motion.

---

## 1. The mount sequence, per request

Every route boots the same way. The cost of a cold load is
front-loaded; subsequent navigations reuse the shell.

```
  ┌───────────────────────────────────────────────────────────────┐
  │ 1. Request                                                    │
  │    Browser asks Next for /coworker (or /pricing, etc.)        │
  └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ 2. SSR: app/layout.tsx (Server Component)                     │
  │    - <html lang>, <body>                                      │
  │    - next/font/google Inter resolved, className applied       │
  │    - metadata + viewport injected into <head>                 │
  │    - imports app/providers.tsx, marks it as a CLIENT child    │
  │    - imports app/coworker/page.tsx (Server Component) and     │
  │      passes it as `children` to <Providers/>                  │
  └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ 3. SSR: app/coworker/page.tsx                                 │
  │    Rendered fully on the server as HTML inside Providers.     │
  │    No hooks, no state, no Framer Motion: this is pure markup. │
  │    Output is serialized into the HTML stream.                 │
  └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ 4. Browser parses HTML                                        │
  │    DOM constructed. Inline styles + Tailwind 4 CSS applied.   │
  │    First Paint: the device frame and a static version of the  │
  │    active app's body are visible before any JS runs.          │
  └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ 5. JS download + hydration                                    │
  │    Next runtime + Providers JS bundle download.               │
  │    React hydrates the client island rooted at <Providers/>.   │
  └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ 6. PhoneProvider effects fire                                 │
  │    - usePathname() → "/coworker"                              │
  │    - useState(current = "/coworker")                          │
  │    - setInterval for the live clock (every 15s)               │
  │    - keydown listener attached for Esc                        │
  │    - pageElement = <CoworkerPage/> (the SSR'd RSC payload)    │
  └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ 7. DeviceFrame mounts                                         │
  │    - reads current from PhoneContext                          │
  │    - findApp("/coworker") returns the AppDef                  │
  │    - current !== "/" → renders <AppView app={appDef}/>        │
  │    - <AppView> reads pageElement from context, mounts it      │
  │      inside <NavBar/> + scroll container                      │
  └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ 8. Framer Motion sees the first AppView mount                 │
  │    With no prior icon visible (cold load), there is no        │
  │    shared layoutId to morph FROM. AppView just appears.       │
  │    On subsequent navigations (icon tap) it morphs.            │
  └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ 9. AppIcon prefetch effects                                   │
  │    Even though the user is in an app, the (currently hidden)  │
  │    home screen icons still mount when the user navigates home │
  │    Each icon useEffect → router.prefetch(app.path)            │
  │    Next caches each route's RSC so the next morph is instant. │
  └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ 10. Steady state                                              │
  │     Status bar clock ticks. AppView body scrolls. Animations  │
  │     idle. User input drives the rest.                         │
  └───────────────────────────────────────────────────────────────┘
```

### Same sequence, but client-side navigation

When the user taps an icon (already inside the OS), steps 1 through 5
do not happen. Instead:

```
  AppIcon.onClick
    → openApp(path)               (updates PhoneContext.current)
    → router.push(path)           (Next swaps RSC payload, no reload)
        → prefetched payload arrives in milliseconds
        → layout's children prop updates to the new <CoworkerPage/>
        → PhoneProvider's pathname effect re-fires
        → DeviceFrame re-renders
          → motion.div with layoutId="app-tile-/coworker" appears
          → Framer Motion morphs from the icon's matching layoutId
            (spring: stiffness 280, damping 28)
```

The shell never unmounts. The clock keeps ticking. State (back stack,
overlay flags) persists. Only the page body and the `current` value
change.

---

## 2. What animates today

A short catalogue. Useful baseline before extending.

| Animation | Where | Trigger | Spring / Tween |
|---|---|---|---|
| Icon → AppView morph | `AppIcon` + `AppView` share `layoutId="app-tile-{path}"` | `openApp` + route change | spring 280/28 |
| Home screen mount/unmount | `HomeScreen` motion.div `initial / animate / exit` | `current` toggles between `/` and an app | spring 280/26 |
| Icon press feedback | `AppIcon` `whileTap={{ scale: 0.9 }}` | tap | tween (default) |
| Home indicator drag | `HomeIndicator` `drag="y"` with constraints + elastic | touch / mouse drag | physics |
| Home indicator press | `whileTap={{ scaleX: 0.95 }}` | tap | tween |
| Status bar clock | not really an animation; `setInterval(15s)` updates text | timer | none |
| Hover / focus rings | Tailwind transitions (`hover:`, `focus-visible:`) | mouse/keyboard | CSS |

No animation happens on the **outer shell** today (bezel, dynamic
island, side buttons, desktop wallpaper). All motion is contained
inside `.phone-screen`.

---

## 3. Adding an animated app (motion INSIDE a page)

Two patterns. Pick by how much animation the page needs.

### Pattern A: tiny client island in a Server page

Best when most of the page is static text/markup and only one section
needs motion (a hero, a counter, a scroll-driven graphic). Keeps the
RSC payload small.

```
  app/<route>/page.tsx              (still a Server Component)
    └ static markup
    └ <ClientAnimation/>            (imported from components/)

  components/<RouteName>Animation.tsx
    "use client"
    framer-motion or canvas or whatever
```

Example. Replace the current `/coworker` hero with an animated badge:

```tsx
// components/CoworkerBadge.tsx
"use client"
import { motion } from "framer-motion"

export function CoworkerBadge() {
  return (
    <motion.div
      initial={{ scale: 0.6, rotate: -8, opacity: 0 }}
      animate={{ scale: 1, rotate: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 220, damping: 18 }}
      className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500 to-fuchsia-700 grid place-items-center text-white font-bold text-lg mb-3"
    >
      Co
    </motion.div>
  )
}

// app/coworker/page.tsx (still Server)
import { CoworkerBadge } from "@/components/CoworkerBadge"
export default function CoworkerPage() {
  return (
    <div className="p-5">
      <header className="mb-6">
        <CoworkerBadge />
        <h1>...</h1>
      </header>
      ...
    </div>
  )
}
```

The page stays server-rendered. Only `CoworkerBadge` ships JS to the
client. Bundle delta is ~1 KB plus Framer Motion (already in bundle).

### Pattern B: full client page

Best when the entire app is interactive (a real game, a 3D scene, a
canvas demo, an actual demo of a Coworker session). The whole page
becomes a Client Component.

```tsx
// app/demo/page.tsx
"use client"
import { useState } from "react"
import { motion, AnimatePresence } from "framer-motion"

export default function DemoPage() {
  const [step, setStep] = useState(0)
  return (
    <div className="p-5">
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
        >
          <h1>Step {step + 1}</h1>
          ...
        </motion.div>
      </AnimatePresence>
      <button onClick={() => setStep(s => (s + 1) % 3)}>Next</button>
    </div>
  )
}
```

Cost: the page no longer prerenders as static HTML for the body
(layout still does). Metadata still works via `export const metadata`.
You lose some streaming benefits and add hydration cost. Worth it when
the page is fundamentally interactive.

**Note on metadata in client pages.** `export const metadata` only
works in Server Components. If you want metadata on a Client page,
split: keep `app/<route>/page.tsx` as a thin Server Component that
exports `metadata` and renders an imported `<DemoApp/>` client
component with all the logic.

### Pattern C: heavy animation libraries

| Library | Use when | How to add |
|---|---|---|
| **Framer Motion** | 90% of cases. Layout, presence, drag, scroll, spring. | Already in deps. Just `import { motion } from "framer-motion"`. |
| **Lottie** | A designer hands you an `animation.json` from After Effects. | `pnpm add lottie-react`, dynamic-import in a client component so it does not bloat initial bundle. |
| **react-three-fiber** | Real 3D, a globe, a particle system, a Coworker visualizer. | `pnpm add three @react-three/fiber @react-three/drei`. Wrap `<Canvas/>` in a `"use client"` boundary with `dynamic(() => import("./Scene"), { ssr: false })`. |
| **HTML `<canvas>`** | Custom 2D rendering, p5-style sketches. | Plain client component with `useRef` + `useEffect`. |
| **CSS / Tailwind only** | Simple hover, fade, scale on a div. | Tailwind's `transition-*`, `animate-*`. Free, zero JS. |

**Bundle discipline.** Anything above ~30 KB gzipped goes behind
`next/dynamic` with `{ ssr: false }` so it only loads when the app is
opened. Example:

```tsx
"use client"
import dynamic from "next/dynamic"
const Globe = dynamic(() => import("./Globe"), { ssr: false })
export default function CustomersPage() {
  return <div className="h-full"><Globe /></div>
}
```

### Hooking into route entry / exit

If your animation should fire when the app *opens* (not just when the
component mounts, which is the same thing in 99% of cases), you have
two options:

- **Default**: `motion.div initial={...} animate={...}` runs on mount.
  Because AppView unmounts the previous page and mounts the new one,
  this is reliable.
- **Coordinate with the icon morph**: read `usePhone().current` and
  delay your animation by ~280 ms so it kicks off *after* the
  layoutId spring resolves. Otherwise both animations compete and
  look jittery.

```tsx
"use client"
import { motion } from "framer-motion"

export function HeroFlourish() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.28, duration: 0.4 }}
    >
      ...
    </motion.div>
  )
}
```

### Sub-navigation within an app

If you want an app with its own internal pages (e.g. `/coworker` ->
`/coworker/demo` -> `/coworker/pricing`), use Next nested routes plus
`AnimatePresence`. The PhoneContext already has `pushBack` and `pop`
wired up for this; today no page uses them, but the seam is there.

---

## 4. Animating the outer shell

The outer shell is `components/DeviceFrame.tsx`: bezel, screen, side
buttons, Dynamic Island, status bar, home indicator, plus the desktop
backdrop. None of these animate today; they are static styles.

There are four places to inject motion, in increasing scope:

```
                       ┌───────────────────────────────────────┐
                       │ A. Status bar tint per app            │
                       │    (smallest blast radius, easiest)   │
                       └───────────────────────────────────────┘
                                          │
                       ┌───────────────────────────────────────┐
                       │ B. Dynamic Island as live activity    │
                       │    (medium; high visual payoff)       │
                       └───────────────────────────────────────┘
                                          │
                       ┌───────────────────────────────────────┐
                       │ C. Per-app bezel / wallpaper theming  │
                       │    (medium; needs apps.ts schema bump)│
                       └───────────────────────────────────────┘
                                          │
                       ┌───────────────────────────────────────┐
                       │ D. Side buttons / cosmetic chrome     │
                       │    (low payoff, last)                 │
                       └───────────────────────────────────────┘
```

### Step 0: extend the AppDef so apps can declare their shell theme

```ts
// types/index.ts
export interface AppDef {
  path: string
  label: string
  glyph: string
  tileClass: string
  dock?: boolean
  href?: string
  navTitle?: string

  // NEW: optional per-app shell hints. Defaults preserve today's look.
  shell?: {
    statusBar?: "light" | "dark"             // text color (light by default)
    statusBarTint?: string                    // optional tinted bg behind status bar
    bezelClass?: string                       // tailwind class for the bezel
    backdropClass?: string                    // desktop backdrop override
    dynamicIsland?: {
      kind?: "pill" | "expanded" | "live"
      content?: React.ReactNode               // custom JSX inside the island
    }
  }
}
```

This is the single seam every shell animation hangs off. Apps opt in;
unset values fall back to defaults.

### A. Status bar tint per app

`StatusBar` reads `current` from PhoneContext (or accepts a prop from
`DeviceFrame`) and animates its background + text color when `current`
changes.

```tsx
// components/StatusBar.tsx
"use client"
import { motion } from "framer-motion"
import { usePhone } from "@/context/PhoneContext"
import { findApp } from "@/data/apps"

export function StatusBar() {
  const { current, status } = usePhone()
  const app = findApp(current)
  const tint = app?.shell?.statusBarTint
  const isDark = app?.shell?.statusBar === "dark"

  return (
    <motion.div
      className={`phone-status-bar relative z-40 h-11 px-6 pt-2 flex items-center justify-between text-[13px] font-semibold tracking-tight ${
        isDark ? "text-black" : "text-white"
      }`}
      animate={{ backgroundColor: tint ?? "transparent" }}
      transition={{ duration: 0.25 }}
    >
      ...
    </motion.div>
  )
}
```

Adding `statusBarTint: "rgba(131,214,58,0.18)"` to the Coworker
AppDef will fade the status bar lime when you open Coworker. Cost: a
few lines, zero new components.

### B. Dynamic Island as a live activity

The Dynamic Island is currently a dumb black div. It can become a
`motion.div` that morphs between three shapes the way iOS does:

```
  pill         expanded         live-activity
  ─────        ──────           ─────────────
  ●●          ┌──────┐         ┌──────────────┐
              │ 1:23 │         │  Co  Coworker│
              └──────┘         │  3 sessions  │
                               └──────────────┘
```

```tsx
// components/DynamicIsland.tsx
"use client"
import { motion, AnimatePresence } from "framer-motion"
import { usePhone } from "@/context/PhoneContext"
import { findApp } from "@/data/apps"

export function DynamicIsland() {
  const { current } = usePhone()
  const app = findApp(current)
  const di = app?.shell?.dynamicIsland
  const kind = di?.kind ?? "pill"

  const shape =
    kind === "live"     ? { width: 220, height: 44, borderRadius: 22 } :
    kind === "expanded" ? { width: 160, height: 36, borderRadius: 18 } :
                          { width: 112, height: 28, borderRadius: 14 }

  return (
    <motion.div
      className="absolute top-2 left-1/2 z-50 -translate-x-1/2 bg-black overflow-hidden"
      animate={shape}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
    >
      <AnimatePresence mode="wait">
        {di?.content && (
          <motion.div
            key={current}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="h-full w-full flex items-center justify-center text-white text-xs px-3"
          >
            {di.content}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
```

Wire `<DynamicIsland/>` into `DeviceFrame` in place of the existing
cosmetic island div. Now any app can drive an iOS-style Live Activity
just by setting `shell.dynamicIsland` in its AppDef.

This is the highest-payoff shell animation. Marketing artifact value
alone justifies it.

### C. Per-app bezel + desktop wallpaper

Two parts:

1. Make `DeviceFrame` read the active app's `shell.bezelClass` and
   `shell.backdropClass`, and animate the border-color / background
   transitions when `current` changes.
2. Move the bezel and backdrop divs into `motion.div`s with `animate`
   on the relevant style props.

```tsx
// components/DeviceFrame.tsx
"use client"
import { motion } from "framer-motion"
import { usePhone } from "@/context/PhoneContext"
import { findApp } from "@/data/apps"

export function DeviceFrame() {
  const { current } = usePhone()
  const app = findApp(current)
  const bezel = app?.shell?.bezelClass ?? "border-phone-metal"
  const backdrop = app?.shell?.backdropClass ?? "phone-backdrop"

  return (
    <motion.div
      className={`fixed inset-0 flex items-center justify-center p-4 sm:p-6 lg:p-10 ${backdrop}`}
      // backdrop transitions via CSS class swap; or animate gradient stops with
      // useMotionTemplate if you want a smooth color crossfade.
    >
      <motion.div
        className={`device-frame relative bg-phone-bezel shadow-device rounded-device border-[3px] ${bezel}`}
        animate={{ borderColor: undefined }}   // class swap handles this
        transition={{ duration: 0.4 }}
        style={{ width: "min(393px, 92vw)", height: "min(852px, 90dvh)", padding: 6 }}
      >
        ...
      </motion.div>
    </motion.div>
  )
}
```

For *smooth* color crossfades (not just CSS class swaps with a `transition`
property), use Framer Motion's `useMotionValue` + `useMotionTemplate`:

```tsx
import { motion, useMotionValue, animate, useMotionTemplate } from "framer-motion"

const borderHue = useMotionValue(0)
useEffect(() => {
  const hue = app?.shell?.bezelHue ?? 0
  const ctrl = animate(borderHue, hue, { duration: 0.4 })
  return ctrl.stop
}, [app])

const borderColor = useMotionTemplate`hsl(${borderHue}, 0%, 18%)`

return <motion.div style={{ borderColor }} ... />
```

### D. Side buttons / cosmetic chrome

The three cosmetic spans on the left of the device + one on the right
are static today. They can:

- **Glow on a system event** (e.g. notification arrived): add a
  `motion.span` with `animate={{ boxShadow: glowing ? "..." : "" }}`
- **Animate on a long-press shortcut**: e.g. long-pressing the right
  side button could toggle a "do not disturb" mode for the character
- **Scale subtly with viewport**: nice touch on desktop, no behavior
  change

Lowest payoff. Save for last.

---

## 5. Layering and z-index rules

Once the shell starts animating, layering matters. Current ordering,
plus where future layers should slot in:

```
  z-index    Layer
  ───────    ─────────────────────────────────────────────
  z-[100]    TourSpotlight  (planned, character plan)
  z-[60]     Modals / sheets  (planned)
  z-50       Dynamic Island
  z-40       StatusBar, HomeIndicator
  z-30       NavBar (inside AppView)
  z-20       Character avatar  (planned, character plan)
  z-10       (reserved)
  z-0        HomeScreen / AppView content
  z-[-10]    Wallpaper inside HomeScreen
```

Rules:

- The Dynamic Island always wins on top because Live Activities must
  be readable.
- Status bar text must stay legible: when a shell-tinted status bar
  collides with a tinted page header, the page header is responsible
  for matching the tint, not the other way around.
- Character avatar sits above the page but below the Dynamic Island
  so it never covers a Live Activity.
- The TourSpotlight overlay is the only thing above z-60. Modals
  defer to it.

---

## 6. Performance

Three rules, in order:

1. **Stay at 60 fps.** That means each frame's work budget is ~16 ms.
   For shell animations this is easy because they only animate when
   `current` changes (rare). For app-internal animations, profile if
   you do anything continuous.
2. **Respect `prefers-reduced-motion`.** Wrap continuous / spring-y
   animations in a media-query check:

   ```tsx
   const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
   <motion.div transition={reduce ? { duration: 0 } : { type: "spring" }} />
   ```

3. **Offload to the GPU.** Animate `transform` and `opacity`, not
   `width` / `height` / `top` / `left`. Framer Motion uses
   `transform` by default; you mostly need to avoid `layout` prop on
   tall lists.

For heavy content (3D scenes, Lottie files >100 KB) put them behind
`next/dynamic` with `{ ssr: false }`. The OS shell stays in the
critical path; animation payloads should not.

---

## 7. SSR + hydration pitfalls

The shell is hydrated. Three traps that bite people once they start
adding shell animations:

1. **Server/client mismatch on the clock.** The status bar already
   handles this: it formats time inside `formatTime()` and updates
   only after mount. Do not stick `Date.now()` directly into JSX or
   you will see hydration warnings.
2. **`useMotionValue` defaults differ from initial render.** If you
   set an animated background based on `app?.shell?.statusBarTint`,
   provide a sensible non-undefined fallback that matches the SSR
   output, otherwise the first paint flashes.
3. **Avatar position depends on viewport.** The character avatar
   plan (see `CHARACTER_PLAN.md`) uses `window.innerWidth` math.
   That math runs only in `useEffect`. Position the avatar
   off-screen on the server, slide it in on hydrate.

A practical heuristic: anything inside `useEffect` will not run on
the server, so put viewport-dependent positioning, time-based math,
and `localStorage` reads there.

---

## 8. Recipes

### Recipe 1: an app with its own intro animation

Goal: when the user opens `/coworker`, the title slides up + fades in
after the layoutId morph completes.

```tsx
// app/coworker/page.tsx is still Server. The animated bit goes in a
// small client component.

// components/CoworkerIntro.tsx
"use client"
import { motion } from "framer-motion"

export function CoworkerIntro() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.28, duration: 0.35 }}
    >
      <h1 className="text-2xl font-semibold tracking-tight">Coworker</h1>
      <p className="text-white/60 text-sm mt-1">
        The unit. A portable, containerized agent workspace.
      </p>
    </motion.div>
  )
}
```

Delay `0.28` matches the layoutId spring's settle time so the two
animations stack instead of compete.

### Recipe 2: a Live Activity-style Dynamic Island for an in-progress task

```ts
// data/apps.ts entry for Coworker
{
  path: "/coworker",
  label: "Coworker",
  glyph: "Co",
  tileClass: "...",
  dock: true,
  shell: {
    dynamicIsland: {
      kind: "live",
      content: (
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-lime-400 animate-pulse" />
          <span className="text-[11px]">Coworker</span>
          <span className="text-white/50 text-[10px]">3 sessions</span>
        </div>
      ),
    },
  },
}
```

When `current === "/coworker"`, the DynamicIsland morphs to the live
shape and shows the pill + label + session count. Switch routes, it
morphs back. Set per any app you want to feel "active."

### Recipe 3: heavy 3D demo behind dynamic import

```tsx
// app/demo/page.tsx (Server Component)
export const metadata = { title: "Demo, XO" }
export default function DemoPage() {
  return <DemoClient />
}

// components/DemoClient.tsx
"use client"
import dynamic from "next/dynamic"
const Scene = dynamic(() => import("./DemoScene"), { ssr: false })
export default function DemoClient() {
  return (
    <div className="h-full w-full">
      <Scene />
    </div>
  )
}

// components/DemoScene.tsx
"use client"
import { Canvas } from "@react-three/fiber"
export default function DemoScene() {
  return (
    <Canvas>
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#83d63a" />
      </mesh>
      <ambientLight />
    </Canvas>
  )
}
```

three + react-three-fiber land in a route-specific chunk, not the
initial bundle.

### Recipe 4: shell color shift driven by scroll position inside an app

When the user scrolls down in `/pricing`, the bezel border slowly
shifts from metal-grey toward lime, hinting the CTA is approaching.

```tsx
// inside DeviceFrame.tsx
"use client"
import { useScroll, useTransform, useMotionTemplate, motion } from "framer-motion"

const scrollContainerRef = useRef<HTMLDivElement>(null)
const { scrollYProgress } = useScroll({ container: scrollContainerRef })

const hue = useTransform(scrollYProgress, [0, 1], [0, 92])    // grey to XO lime hue
const sat = useTransform(scrollYProgress, [0, 1], [0, 60])
const borderColor = useMotionTemplate`hsl(${hue}, ${sat}%, 30%)`

<motion.div className="device-frame ..." style={{ borderColor }}>
  ...
  <main ref={scrollContainerRef}>...</main>
</motion.div>
```

Note: `useScroll` only works when the scroll container is a Framer-aware
ref. The current `<main>` wrapper in DeviceFrame is the right place.

---

## 9. When to extend, when to leave alone

| Situation | Do this |
|---|---|
| You want a page to feel "alive" but the body is mostly static text | Pattern A: small client island for the hero |
| You want the whole app to be interactive | Pattern B: client page; export metadata via a Server wrapper |
| You want the iPhone itself to react to the active app | Section 4: `shell` field on AppDef, animate per-app |
| You want to demo an XO product visually (Coworker, Swarm) | Combine: Live-Activity-style Dynamic Island + dynamic-imported 3D scene |
| You want a small polish detail (button glow, click ripple) | Tailwind transitions or plain `whileTap`; do not reach for new libs |
| You want a global "OS event" (notification slide-in) | Add to PhoneContext + a sibling overlay layer; do not mix into DeviceFrame |

The OS shell stays simple by default. Per-app shell theming is
opt-in. Animation libs beyond Framer Motion are opt-in and lazy.

---

## 10. Where this points next

Two natural follow-ups already drafted:

- **`CHARACTER_PLAN.md`** assumes the character lives in the same
  overlay layer described here (above z-20, below Dynamic Island).
  When the character is built, it slots into the layering chart
  in §5 without changing anything else.
- **The "more apps" doc (still to be written)** will cover three
  concrete app types: a wrapper UI calling xo-cowork-api, a route
  that renders xo-docs MDX, and a launcher for xo-swarm. Each of
  those benefits from Section 4 (let them theme the shell) and
  Section 3 (let them ship rich animation safely).
