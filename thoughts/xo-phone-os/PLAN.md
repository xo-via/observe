# xo-phone-os plan

XO's marketing surface as an iPhone-style phone OS. Same idea as `xo-os`
(the website is the UI of an operating system), but the model is a
phone: one app at a time, home screen with an icon grid, status bar,
dock, and gesture-driven navigation. Phone-first, with a device frame
when viewed on desktop.

This document is the architecture for a **separate** project (not a
modification of `xo-os/`). The two plans intentionally do not share a
runtime; we pick one as the public site, or run them side by side at
different routes.

## 1. Why this might be the better choice

| Reason | Detail |
|---|---|
| Phone-native | A phone OS UX on a phone is the natural surface. xo-os has to fall back to a static page below 1024px. xo-phone-os is fluent everywhere. |
| Tighter focus | Single app at a time. Users land on one thing instead of juggling overlapping windows. |
| Touch-first | Built around tap, swipe, long-press. No multi-pointer gymnastics. |
| Brand fit | XO sells "workspaces for AI agents." A pocket-sized OS frames each product as an installed app rather than a feature tab. |
| Lower complexity | No window stacking, no z-index management, no drag constraints, no resize handles. The state model is `currentApp` plus a back stack. |

The desktop OS approach (xo-os) is striking on a laptop but inelegant on
a phone. The phone OS approach is striking everywhere, at the cost of
losing the "many things open at once" desktop metaphor.

## 2. Visual model

### On a phone (viewport <= 599px)

Full-bleed. The browser viewport is the device. The OS UI fills the
screen. No device frame.

### On a tablet or desktop (viewport >= 600px)

Render an iPhone-shaped device frame, centered on a dark XO-branded
backdrop. The "OS" lives inside this frame. Outside the frame, decorative
desktop wallpaper.

### Device frame spec (desktop view)

- Reference device: iPhone 15 Pro proportions, 19.5:9
- Frame inner dimensions: 393x852 (scales to ~80% of viewport height, capped at 900px tall)
- Outer chrome: 8px titanium-tone bezel, ~50px corner radius
- Dynamic Island: 120x35 pill, top center, ~12px from top
- Side buttons (cosmetic): action button + volume up/down on left, side button on right
- Drop shadow + subtle backdrop blur on the desktop wallpaper

## 3. State model

Compared to xo-os, the state shrinks dramatically:

```ts
type AppState = {
  // "home" or the route key of the active app
  current: "home" | string
  // back-stack for in-app navigation
  backStack: string[]
  // app switcher overlay open
  switcherOpen: boolean
  // pull-down panels
  notificationsOpen: boolean
  controlCenterOpen: boolean
  // home screen paging
  homePage: number
  // theme + wallpaper
  theme: "light" | "dark"
  wallpaper: string
}
```

No windows array. No z-index. No drag constraints. The active app gets
the screen; everything else is paused.

## 4. Component tree

```
<PhoneProvider>
  <DeviceFrame>                  device chrome on >=600px viewports only
    <StatusBar />                time, signal/wifi/battery, app icon
    <Screen>                     the inside of the phone
      <HomeScreen />             when current === "home"
      <AppView app={current} />  when current !== "home"
      <AppSwitcher />            overlay when switcherOpen
      <NotificationsPanel />     overlay when notificationsOpen
      <ControlCenter />          overlay when controlCenterOpen
    </Screen>
    <HomeIndicator />            the swipe-up bar at the bottom
  </DeviceFrame>
</PhoneProvider>
```

## 5. Screens, in order of build

### 5.1 Status bar

Top of the screen. Left: time (live clock). Right: signal icon + wifi
icon + battery icon. Decorative; not interactive. Drops a backdrop blur
when an app is open and content scrolls underneath.

### 5.2 Home screen

A 4-column icon grid. Up to 6 rows per page. Page dots at the bottom.
Swipe left/right to switch pages. A persistent dock sits below the page
dots holding 4 pinned apps.

Apps on the home screen (in order):

Page 1: Home, Coworker, Swarm, Pricing, Customers, Demo, Docs, Talk to a
human, Ask XO, Sign up, Why XO?, Changelog, Handbook.

Page 2 (optional): Store, Work here, Trash, Settings.

Dock (always visible at home): Home, Coworker, Swarm, Sign up.

### 5.3 App view

When an app launches, the home screen scales down and the app expands
from the icon position to fullscreen (shared element transition). Inside,
the app gets:

- An optional in-app `NavBar` (back chevron + title + optional right button)
- Full-bleed scrollable content
- A persistent home indicator at the bottom

Apps can opt out of NavBar to look like wallpaper-thick experiences
(useful for the demo video).

### 5.4 App switcher

A swipe-up-and-hold gesture (or tap on a small "recents" pill if
gesture detection fails) opens a card carousel of recently used apps.
Swipe a card up to dismiss; tap to reopen.

### 5.5 Notifications + Control Center

Swipe down from the top-left for Notifications. Swipe down from the
top-right for Control Center. v1 ships them as static panels with brand
content (Notifications shows recent changelog entries; Control Center has
wallpaper toggle + theme switcher).

## 6. Apps to ship in v1

| Slot | App | Route | Notes |
|---|---|---|---|
| Home | Home | `/` | Hero, two-card Coworker / Swarm pitch, CTA |
| App | Coworker | `/coworker` | Vertical scroll of features, screenshots |
| App | Swarm | `/swarm` | Same shape |
| App | Pricing | `/pricing` | Tier cards stacked |
| App | Customers | `/customers` | Logo grid + quotes |
| App | Demo | `/demo` | Embedded video, full bleed |
| App | Docs | `/docs` | Reader with table of contents |
| App | Talk to a human | `/talk-to-a-human` | Form |
| App | Ask XO | `/ask` | Chat surface (placeholder UI in v1) |
| Link | Sign up | external | Opens `app.xo.builders/signup` in a new tab |
| App | Why XO? | `/about` | Long-form |
| App | Changelog | `/changelog` | Feed |
| App | Handbook | `/handbook` | MDX pulled from `xo-docs` |
| App | Settings | `/settings` | Theme, wallpaper, sign in (Clerk later) |

Trash and Store can land in v1.5 if there is room.

## 7. Gestures and shortcuts

| Input | Action |
|---|---|
| Tap icon | Launch app |
| Swipe up (short) | Close to home |
| Swipe up + hold | Open app switcher |
| Swipe horizontally on home | Page through home screens |
| Swipe down from top-left | Notifications |
| Swipe down from top-right | Control Center |
| Tap NavBar back chevron | In-app back |
| Browser back button | In-app back if backStack non-empty, else home |
| Long-press icon (v2) | Rearrange / delete (jiggle mode) |
| Keyboard `Esc` | Close current app |
| Keyboard `Cmd+K` | Spotlight search (v2) |

Gestures are detected with `framer-motion`'s `useDragControls` /
`onPan` handlers, with `touch-action: none` on the screen container so
the browser does not intercept vertical scroll.

## 8. Animations

All transitions go through Framer Motion with spring physics:

- **Icon to app**: shared-layout transition. The tapped icon's position
  and size are captured; the AppView mounts at that position and scales
  to fullscreen. Inverse on close.
- **App to home**: scale + opacity, with the home screen fading back in
  from a slightly zoomed state.
- **App switcher**: cards rest at ~85% scale, snap on drag, fly off
  vertically on dismiss.
- **Panels (notifications, control center)**: slide from the top, parallax
  with backdrop blur.

Target 60fps; avoid layout thrash by animating `transform` and `opacity`
only.

## 9. Routing

Same Gatsby file-routes as `xo-os`. The difference is purely the shell:
each route renders inside `<AppView>` instead of `<AppWindow>`. The
provider listens to location changes and pushes/pops the back stack
accordingly. No window spawn vs focus vs replace logic; routes are 1:1
with apps.

Deep links still work: `os.xo.builders/coworker` opens directly into the
Coworker app, with the home screen logically "underneath" so back lands
there.

## 10. Tech stack

Same shape as `xo-os`. Gatsby 5 + TypeScript + Tailwind 3 +
Framer Motion 11. Differences:

- No `gatsby-plugin-mdx` needed for v1 (handbook can come later)
- Add a thin gesture library (or hand-roll on top of Framer Motion)
- Add a `useMediaQuery` helper to flip between phone-bleed and
  device-frame layouts

## 11. File layout (proposed)

```
xo-phone-os/
├── gatsby-browser.tsx           wrapPageElement with PhoneProvider
├── gatsby-ssr.tsx
├── gatsby-config.ts
├── tailwind.config.ts           same XO tokens as xo-os
├── tsconfig.json
├── package.json
├── README.md
├── PLAN.md                      this file
├── src/
│   ├── context/
│   │   └── PhoneContext.tsx     current app, back stack, panel state
│   ├── components/
│   │   ├── DeviceFrame.tsx      iPhone chrome on desktop
│   │   ├── StatusBar.tsx
│   │   ├── HomeScreen.tsx
│   │   ├── HomeIndicator.tsx
│   │   ├── Dock.tsx
│   │   ├── AppIcon.tsx
│   │   ├── AppView.tsx          per-app fullscreen container
│   │   ├── NavBar.tsx           in-app top bar (back + title)
│   │   ├── AppSwitcher.tsx
│   │   ├── NotificationsPanel.tsx
│   │   ├── ControlCenter.tsx
│   │   └── apps/
│   │       ├── HomeApp.tsx
│   │       ├── CoworkerApp.tsx
│   │       ├── SwarmApp.tsx
│   │       ├── PricingApp.tsx
│   │       └── SettingsApp.tsx
│   ├── data/
│   │   ├── apps.ts              ordered icon list, dock pins
│   │   └── wallpapers.ts
│   ├── pages/                   one per route, each renders its app body
│   ├── styles/global.css
│   └── types/index.ts
└── content/
    └── handbook/                MDX, later
```

## 12. Phased delivery

1. **Shell + one app (week 1)**
   - PhoneProvider with `current`, `backStack`, basic actions
   - DeviceFrame, StatusBar, HomeScreen (single page), Dock
   - AppIcon that launches its route with the shared-element transition
   - AppView with optional NavBar
   - One real app body (Home)
   - Static stub for everything else

2. **Apps + content (week 2)**
   - Real content for Coworker, Swarm, Pricing
   - Multi-page home screen with page dots
   - Long-form scroll within apps

3. **Gestures (week 3)**
   - Swipe up to home
   - Swipe up + hold for app switcher
   - Horizontal swipe between home pages
   - Vertical swipe panels (Notifications, Control Center)

4. **Settings + theme (week 4)**
   - Settings.app with theme toggle, wallpaper picker
   - Lock screen (optional)
   - Animations polish pass

5. **Clerk auth (week 5)**
   - `@clerk/clerk-react` inside Settings.app
   - Persisted wallpaper, theme, recent apps to user profile via `xo-cowork-api`

6. **SEO + analytics (week 6)**
   - Static gen audit, meta tags, sitemap, robots
   - Analytics in place

7. **Launch**
   - Vercel deploy to `phone.xo.builders` (or `os.xo.builders` if we pick
     phone over desktop). Feature-flag rollout.

## 13. Comparison vs xo-os

| Aspect | xo-os (desktop) | xo-phone-os |
|---|---|---|
| Mental model | Windows on a desktop | Apps on a phone |
| Focus | Multi-window, overlap | Single app, full screen |
| State | `windows[]` + z-index | `current` + back stack |
| Drag / resize | Yes | None |
| Touch-first | Bolted on above 1024px | Native |
| Best on | Laptop, iPad landscape | Phone, also fine on desktop in a frame |
| Mobile fallback | Static `BoringFallback` page | Same UI, no fallback needed |
| Complexity | Higher: window manager, constraints, snap, resize | Lower: app router + gesture layer |
| Brand vibe | "We are a workspace, here is the workspace" | "We are an OS, here are our apps" |

Either approach can win. The phone version is a better fit if XO wants
the marketing surface to feel like a product the visitor could hold, and
it removes the small-screen compromise. The desktop version is a better
fit if XO wants the surface to feel like a power tool.

## 14. Open questions

1. **Replace xo-os, or run both?** Could host xo-os at `os.xo.builders`
   and xo-phone-os at `phone.xo.builders`, then keep the winner. Or
   ship the phone version at `xo.builders` and the desktop version
   behind a button labeled "open desktop view."
2. **Device frame extras**: do we want a working clock / battery (drops
   on low device battery)? Anything that uses the real device makes the
   demo memorable.
3. **Lock screen**: ship as visitor entry point, or skip?
4. **Reduced motion**: do animations need a `prefers-reduced-motion`
   path? Yes; we should plan it in week 4.
5. **Landscape on phones**: do we adapt or force portrait? Force
   portrait simplifies a lot.
6. **Sound**: subtle haptic-style audio on tap (with mute toggle in
   Control Center) or none.
7. **PWA**: install to home screen? Manifest + service worker would let
   visitors literally pin the XO icon, which is on-brand.

## 15. What this plan does NOT cover

- The full Clerk auth flow (deferred to phase 5)
- Real-time data inside apps (this is a marketing site)
- Multiplayer / shared state
- Mobile push notifications (decorative panels only in v1)
