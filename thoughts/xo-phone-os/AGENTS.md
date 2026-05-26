# AGENTS.md

Operating contract for AI agents working in `xo-phone-os`. Read this
before touching any file. Then read whichever sections apply to the
task in hand.

This document is the merge of:

- `V_NEXT_PLAN.html` (the pivot plan, what we are building)
- `SCREENS.html` (every screen, what's on it, what the user can do)
- `COWORK_INTERACTION.html` (endpoint catalog + auth header flow)
- `ADR_001_COWORK_INTEGRATION.html` (the architectural decision)

When this file disagrees with one of those, the HTML files win and
this file is out of date. Treat the HTML as primary source.

---

## 1. What XO Phone OS is

XO Phone OS is an iPhone-style web surface for XO. The browser
viewport renders as a phone (full bleed on mobile, framed device on
desktop). The OS itself is a thin Next.js client.

**v.Next architecture** (the target this doc describes):

```
   Browser (xo-phone-os) ──► Next.js Route Handlers ──► xo-cowork-api
       Clerk cookie              XO_API_KEY                multi-tenant
       calls /api/* only         X-XO-Username             by username
                                 attaches both headers
```

The phone OS is **UI only**. Every backend capability (chat, files,
agents, channels, usage) lives in `xo-cowork-api` on port 5002.
Next.js Route Handlers are thin proxies (~30 LOC each) that read
the Clerk session, attach the operator key + the user's username,
and forward to cowork-api. Browsers never see port 5002 or any API
key.

This replaces the v0 architecture, which had an in-Next Claude
Agent SDK runtime. That is being deleted in v.Next Section A.

---

## 2. Build state (what is and is not done)

The v.Next pivot is being shipped in numbered build sections. The
canonical execution order, status today, and where the code lives:

| # | Section | What it delivers | Status |
|---|---|---|---|
| 1 | **A** Rip TS agent | Delete `lib/agent/*`, `app/api/agent/*`, in-Next Claude SDK runtime | ✅ Done |
| 2 | **K** Mock data layer | `lib/cowork/{types,mock-data,mock-stream,browser-client}.ts` + `NEXT_PUBLIC_USE_COWORK_MOCKS` flag | ✅ Done |
| 3 | **C** Pager + 3 modes | iPhone-style Pager with horizontal mode swipe, landing/agent/feed modes, per-mode auth gate stub | ✅ Done |
| 4 | I | Consolidated top-edge Overlay (notif + controls + search merged) | ⏳ Pending |
| 5 | D | Chat dock button expand (`ChatExpanded` + layoutId morph) | ⏳ Pending |
| 6 | E | Widgets (AgentStatus, Mood, Thought, etc.) | ⏳ Pending |
| 7 | H | Cowork-derived `kind: "api"` apps (files, agents, channels, usage) | ⏳ Pending |
| 8 | B | Real Next Route Handlers replacing mocks | ⏳ Pending |
| 9 | **G** Clerk wiring | `<ClerkProvider>` at root layout, `clerkMiddleware` at project root, real Clerk-backed `useAuthGate` with `isSignedIn`, in-shell `<SignInOverlay>` mounted by `DeviceFrame`, `/sign-in` + `/sign-up` catch-all routes | ✅ Done |
| 10 | J | Agent-driven OS actions (`client-action` SSE events) | ⏳ Pending |
| 11 | F | Feed mode body | ⏳ Deferred |

**Rules of thumb when reading the tree**:

- Anything under `lib/cowork/` is v.Next. The browser-client reads
  the `NEXT_PUBLIC_USE_COWORK_MOCKS` flag to switch between in-memory
  mocks and real `/api/*` calls. The browser NEVER calls cowork-api
  directly.
- `lib/agent/` and `app/api/agent/` are gone. Do not bring them back.
  The agent runtime lives in xo-cowork-api now; the phone OS is a
  thin client.
- `components/agent/AgentSurface.tsx` exists but is a placeholder
  ("Chat is moving home") until Section D lands. Do not extend it.
- `components/Pager.tsx` and `components/ModePage.tsx` are the
  current home surface. Replaces the old single-mode HomeScreen flow.
- `data/modes/{landing,agent,feed,setup}.ts` are the four mode
  files. Landing, Agent, Feed are registered; setup is hidden in
  v.Next but kept for the role ladder (ignore unless working on it).
  Note: the Page 3 mode was renamed from "public" to "feed" in
  v.Next; old `?mode=public` URLs fall back to Landing.

When in doubt, prefer the v.Next direction. Do not add new code to
the v0 agent backend even if a similar pattern existed once.

---

## 3. House rules

Inherited from `ClaudeWorkspace/CLAUDE.md` plus repo specifics.
Non-negotiable.

1. **No em dashes or en dashes.** Never `—` or `–`. Use colons,
   commas, periods, parentheses, or sentence breaks. Scan your
   output before saving any file. This applies to code comments,
   markdown, and chat replies.
2. **Stay brief.** Lead with the answer, add detail only if asked.
   No "great question." No victory laps.
3. **Ask when confused.** A one-line clarifying question beats
   wrong work shipped fast.
4. **No client-side external API calls.** Every call to xo-cowork-api
   (or any other backend) goes through a Next.js Route Handler.
   `XO_API_KEY` and `COWORK_API_URL` are server-only. Never prefix
   with `NEXT_PUBLIC_`. The browser only ever calls `/api/*` on this
   origin. This rule is enforced architecturally and reviewed.
5. **Server Components by default.** Pages under `app/<route>/page.tsx`
   are Server Components. `"use client"` only when the file genuinely
   needs hooks, event handlers, Framer Motion, or `next/navigation`
   hooks. The OS shell (DeviceFrame, Pager, gesture surface) is the
   client island.
6. **One screen, one focus.** No more than one significant overlay
   open at a time (the consolidated Overlay panel enforces this).
7. **Reduced motion is honored everywhere.** Use `useReducedMotion`
   from `framer-motion`; fall back to opacity-only transitions or
   instant snaps.

---

## 4. Brand + theme

### Colors (from `app/globals.css` `@theme` block)

| Token | Value | Use |
|---|---|---|
| XO lime (primary) | `#83d63a` | Brand accent, active states, CTAs, inner chevron stroke |
| Lime soft | `rgba(131, 214, 58, 0.15)` | Backgrounds, glows, mode indicators |
| Lime edge | `rgba(131, 214, 58, 0.55)` | Borders on lime-tinted surfaces |
| Ink | `#08090A` | Page background, device backdrop |
| Ink-2 | `#131416` | Card backgrounds |
| Ink-3 | `#1c1c1e` | Code blocks, status pills, phone-bezel |
| Text | `#ffffff` | Primary text |
| Text-2 | `rgba(255,255,255,0.72)` | Body copy |
| Text-3 | `rgba(255,255,255,0.5)` | Captions, meta |
| Divider | `rgba(255,255,255,0.08)` | Hairline separators |
| Amber | `#ffb547` | Warning, deferred, setup-mode accent |
| Red | `#ff6b6b` | Error, destructive |
| Blue | `#64b5f6` | Info, neutral status |

**Mode accents** (per-mode `theme.accent` override the default lime):

- Landing: lime (default)
- Agent: lime (default)
- Setup (hidden in v.Next): amber `#f5a866`
- Feed: TBD (deferred)

### Type

- Sans (primary): Inter via `next/font/google`, exposed as
  `--font-inter` and used inside `--font-sans`
- Display: SF Pro Display fallback chain
- Mono: JetBrains Mono, SF Mono, Menlo

### Spacing + radii

| Token | Value |
|---|---|
| `radius-device` | 52px (outer device frame corners) |
| `radius-screen` | 44px (inner screen corners) |
| Panel border radius | 28px (glass panels) |
| App tile radius | 16px (`rounded-2xl`) |
| Dock pill radius | 24px (`rounded-3xl`) |

### Glass morphism (panels, banners, sign-in gate)

Shared utility in `components/gestures/glass.tsx`:

| Layer | What it does |
|---|---|
| `GLASS_PANEL_CLASS` | `bg-white/10`, `backdrop-blur-3xl`, `backdrop-saturate-200`, `backdrop-brightness-110`, `border-b-2 border-l-2 border-r-2 border-white/20`, soft drop shadow |
| `<GlassHighlight/>` | 1px gradient bar across the top edge |
| `<GlassInnerGlow/>` | 96px fade from `white/10` to transparent at the top |
| `<GlassSpecular/>` | Diagonal sheen near top-left |

**The single most important rule about scrims**: when a panel is
closed, its scrim must have `pointer-events: none`. Otherwise the
invisible scrim swallows every tap on the screen. Use
`pointerEvents: isOwner ? "auto" : "none"` on every scrim.

### Animation physics

Single shared spring constant: `PANEL_SPRING` in
`lib/gestures/constants.ts`. Currently `{ type: "spring",
stiffness: 280, damping: 28 }`. Touching this constant changes the
icon-to-app morph, every panel slide, and the mode crossfade
together. Intentional: keeps the OS feeling coherent.

| Surface | Duration / curve |
|---|---|
| Lockscreen slide-up (unlock) | 850ms tween, `[0.32, 0.72, 0, 1]` decelerating |
| Lockscreen slide-down (re-lock) | 750ms tween, `[0.22, 1, 0.36, 1]` |
| Icon → AppView morph | `PANEL_SPRING` (~280ms perceived) |
| Mode crossfade (Pager outer) | 600ms (icon fade + dock slide; wallpaper crossfade if theme set) |
| Inner sub-page swipe | 280ms spring (within a mode, lighter than mode change) |
| Chat dock button expand | 450ms total (layoutId morph + grid fade + dock-to-input-bar) |
| Panel slide (notif, spotlight) | `PANEL_SPRING` |
| Reduced motion | 120-200ms opacity-only fades; no scale, no slide |

---

## 5. File and directory layout

```
xo-phone-os/
├── app/                                Next.js App Router
│   ├── layout.tsx                      Root layout: fonts, metadata, viewport, Providers
│   ├── providers.tsx                   Single client island; wraps every provider
│   ├── page.tsx                        "/" route, renders <Pager/>
│   ├── globals.css                     @theme tokens + phone CSS
│   ├── api/                            Next.js Route Handlers (the thin proxy layer)
│   │   ├── healthz/                    Liveness for k8s (only handler today)
│   │   ├── chat/                       PENDING Section B: chat proxy + SSE pipe
│   │   ├── widgets/                    PENDING Section B: agent-status, quip
│   │   └── cowork/                     PENDING Section B: files, agents, channels, usage
│   └── <route>/                        One directory per app
│       ├── app.ts                      xoApp config (path, label, kind, requiredRoles, theme)
│       └── page.tsx                    The app body (usually Server Component)
├── components/                         Flat folder; subdirs for tightly-coupled groups
│   ├── DeviceFrame.tsx                 Phone chrome (bezel, side buttons, screen)
│   ├── Pager.tsx                       v.Next iPhone-style 4-layer pager (see §7)
│   ├── ModePage.tsx                    One mode's icon grid only (no dock, no wallpaper)
│   ├── HomeScreen.tsx                  Legacy single-mode home (kept for cleanup pass)
│   ├── AppView.tsx                     Full-bleed app body with layoutId morph
│   ├── XOAppShell.tsx                  In-app header + body wrapper (Server Component)
│   ├── XOAppShellIframe.tsx            Variant for kind:"iframe"
│   ├── XOAppShellHtml.tsx              Variant for kind:"html"
│   ├── LockScreen.tsx                  Lockscreen with Mood + Thought widgets
│   ├── lockscreen/NightPupWallpaper.tsx
│   ├── gestures/                       GestureSurface, NotificationPanel, SpotlightPanel,
│   │                                   PullToRefresh, glass.tsx (ControlCenter deleted)
│   ├── gates/                          RoleGate, SignInGate
│   ├── via/                            Via mascot (component + hero)
│   ├── agent/                          AgentSurface (stubbed placeholder; rewires in Section D)
│   ├── chat/                           PENDING Section D: ChatExpanded
│   ├── overlays/                       PENDING Section I: consolidated Overlay panel
│   ├── widgets/                        PENDING Section E: AgentStatus, Mood, Thought
│   ├── setup/                          Setup CTA buttons
│   └── mdx-components.tsx              MDX component map
├── context/                            React contexts (all "use client")
│   ├── ModeContext.tsx                 currentMode, modeApps, modeDock, transitioning
│   ├── LockContext.tsx                 locked, unlock, sticky, lastUnlockedAt
│   ├── PhoneContext.tsx                current, backStack, openApp, goHome
│   ├── GestureContext.tsx              openPanel ("notifications" | "spotlight" | null),
│   │                                   notifT + spotlightT motion values, lockGestures
│   ├── RoleContext.tsx                 roles, canAccess, grant/revoke, devModeEnabled
│   └── AgentContext.tsx                Agent state for Mood widget + future chat
├── lib/                                Pure utilities (no React, no fetch, no env reads)
│   ├── xo-app.ts                       AppDef types + defineXOApp factory
│   ├── xo-mode.ts                      ModeDef types + defineMode validator (auth field)
│   ├── xo-mode-registry.ts             Singleton registry with useSyncExternalStore
│   ├── xo-roles.ts                     Role type + pure evaluators
│   ├── via.ts                          ViaExpression, viaStateFromAgent precedence
│   ├── mdx.ts                          loadMdxSource()
│   ├── html.ts                         loadHtmlSource()
│   ├── gestures/                       constants.ts, zones.ts (pure; no "control" zone)
│   ├── pager/                          commit.ts (calculateCommitTarget; distance + velocity)
│   ├── auth/                           auth-gate.ts (permissive stub; Section G replaces)
│   └── cowork/                         types.ts, mock-data.ts, mock-stream.ts,
│                                       browser-client.ts (the only browser cowork surface)
├── data/                               Static registries + per-item config
│   ├── apps.ts                         Imports every app/<route>/app.ts and exports the registry
│   └── modes/                          landing.ts, agent.ts, feed.ts, setup.ts
├── content/                            Static MDX / HTML content (for kind:"mdx" and kind:"html" apps)
├── tests/                              Vitest test suite, 57 tests across 5 files
│   └── unit/
│       ├── data/modes.test.ts                    (11 tests)
│       ├── lib/xo-roles.test.ts
│       ├── lib/auth/auth-gate.test.ts            (5 tests)
│       ├── lib/cowork/browser-client.test.ts     (22 tests)
│       └── lib/pager/commit.test.ts              (10 tests)
├── public/                             Static assets
├── next.config.ts                      output: "standalone", turbopack.root pinned
├── postcss.config.mjs                  Tailwind 4 + autoprefixer
├── eslint.config.mjs                   eslint-config-next flat config
├── tsconfig.json                       Strict, @/* alias, react-jsx (Next-managed)
├── package.json                        pnpm scripts; onlyBuiltDependencies allowlist
│                                       (@anthropic-ai/claude-agent-sdk + MCP SDK removed)
├── Dockerfile                          3-stage, pnpm-first, Node 24-slim
└── entrypoint.sh                       runtime placeholder swap for NEXT_PUBLIC_*
```

**Recently deleted (do not recreate)**:

- `lib/agent/` (Claude Agent SDK runtime)
- `lib/cowork-api/` (server wrapper, folded into `lib/cowork/`)
- `app/api/agent/` (TS agent endpoints)
- `components/agent/action-bus.ts` (v0 client-side action dispatcher)
- `components/gestures/ControlCenterPanel.tsx` (Control Center removed)
- `data/modes/default.ts` (renamed to `agent.ts`)

### Where new files go

| What you are adding | Where |
|---|---|
| New app (any kind) | `app/<route>/app.ts` + `app/<route>/page.tsx` + entry in `data/apps.ts` |
| New mode | `data/modes/<id>.ts` + register call in `data/modes.ts` |
| New cowork-derived app | App pair + `app/api/cowork/<name>/route.ts` proxy |
| New widget | `components/widgets/<Name>.tsx` + optional `app/api/widgets/<name>/route.ts` |
| New shell component | `components/<Name>.tsx` flat, not in a subdir |
| Pure logic helper | `lib/<area>/<name>.ts` (no React, no DOM, no fetch) |
| New context | `context/<Name>Context.tsx`, register in `app/providers.tsx` |
| Static content | `content/<collection>/<slug>.{mdx,html}` |
| Test | `tests/<unit|components|integration|api|e2e>/<area>/<name>.test.ts` |

---

## 6. Provider tree (the order matters)

`app/providers.tsx` mounts the providers in this order, outermost
first:

```
   app/layout.tsx (server)
   └ <ClerkProvider>             Section G: session is the foundation
       └ <Providers> (client)    everything below is "use client"
           └ <RoleProvider>      who the user is (anonymous / signed-in)
               └ <AgentProvider>     agent state for Mood widget + chat
                   └ <ModeProvider>      which app set + dock the home screen shows
                       └ <LockProvider>      orthogonal lock; gates entry to the OS
                           └ <PhoneProvider>     current route + back stack
                               └ <GestureProvider>   panel state + motion values
                                   └ <DeviceFrame/>      chrome + gesture surface +
                                                          <SignInOverlay/>
```

Rules:

- **Outer providers can be read by inner providers.** Pick layer
  position based on what reads what.
- **Never reach into another context's state directly.** Always go
  through that context's hook (`useMode`, `useLock`, `useRoles`).
- **Each context exposes intent actions**, not state setters.
  `setMode(id)` not `setCurrentMode(id)`. `openApp(path)` not
  `setCurrent(path)`.

---

## 7. The Pager + modes (v.Next core surface)

v.Next replaces the v0 home screen with a horizontal Pager that
delivers the iPhone home-screen feel.

**Outer pager** = modes (3 pages):

| Page | Mode | Auth | Apps |
|---|---|---|---|
| 1 | Landing | `public` | Docs, Journal, Pricing, Demo, Get Started |
| 2 | Agent | `public` (v1: gating disabled, see §13) | v0 default suite (13) + cowork API apps (6+) |
| 3 | Feed | `public` (deferred) | TBD |

**Inner pager** = iOS-style sub-pages within a mode when the grid
overflows one screen. Agent mode uses this once cowork apps land.

### 7.1 Pager rendering model (the 4 layers)

The iPhone-style behavior (grid swipes, dock stays anchored, wallpaper
crossfades) comes from this exact layout in `components/Pager.tsx`:

```
┌─────────────────────────────────────────────┐
│ Layer 1: Wallpaper             (back)       │  fixed; crossfades on mode change
├─────────────────────────────────────────────┤
│ Layer 2: ModeBanner            (top, fixed) │  fixed at top edge
│                                             │
│ Layer 3: Swipeable strip       (only this   │  width = modes.length × screen
│           translates X)                     │  modes rendered side-by-side
│   ┌────────┬────────┬────────┐              │
│   │Landing │ Agent  │  Feed  │              │
│   │ grid   │  grid  │  grid  │              │  ModePage = ONLY the icon grid
│   └────────┴────────┴────────┘              │
│                                             │
│ Layer 4: WanderingVia + PageDots + Dock     │  fixed; always mounted
└─────────────────────────────────────────────┘
```

**Critical invariants**:

- **Mode indicator lives in the Dynamic Island (top center).**
  `components/ModeIslandIndicator.tsx` shows one dot per registered
  mode in compact state (active dot is XO lime). Tap to expand into
  a labeled mode picker; pick a mode to call `setMode`. The bottom
  PageDots row beneath WanderingVia is a secondary indicator and
  becomes the sub-page indicator once Section H lands inner pages.
- **GestureSurface skips the island.** `onPointerDown` early-returns
  when `e.target.closest(".device-mode-island")` matches, otherwise
  the top-edge swipe zone (top 24 px) swallows island taps.
- **`ModePage` is just the icon grid.** It never renders the dock,
  wallpaper, banner, or pagination dots. Those are siblings on
  Pager, fixed in place. This is what keeps the dock anchored as
  the grid swipes underneath.
- **Dock is rendered directly: `<Dock apps={[...modeDock]} />`.**
  No `<AnimatePresence>` wrapper. Wrapping it in AnimatePresence
  caused a ~250ms exit-then-enter gap on every mode change. The
  Dock container stays mounted; only the `apps` array swaps.
- **All modes render simultaneously** in the swipeable strip. The
  strip uses `transform: translateX(-currentIndex × width)`.
  Container width is read in `useLayoutEffect` (not `useEffect`),
  otherwise the strip flashes 0-width on first paint.
- **Drag uses Framer Motion's `drag="x"` + `dragDirectionLock` +
  small `dragElastic`.** On dragEnd, `lib/pager/commit.ts`
  decides target index from distance ratio (≥ 30%) or x-velocity
  (≥ 500 px/s).
- **Auth gate is consulted on commit, not on drag start.** Allows
  the user to see the destination peek before being asked to sign
  in. (Stub today: `useAuthGate().canEnter()` returns true; replaced
  in Section G.)

### 7.2 Dock convention (every mode)

```
   ┌──────────┬──────────┬──────────┬──────────┐
   │  Chat    │   mid    │   mid    │  CTA     │
   │ (always) │ per mode │ per mode │ (auth-   │
   │ leftmost │          │          │ aware)   │
   └──────────┴──────────┴──────────┴──────────┘
```

**v1 uniform dock (current ship):** every mode shows the same four
pins, in this exact order:

| Slot | Path | Tile | Behavior |
|---|---|---|---|
| 1 | `/ask` | Chat (iMessage green, speech-bubble svg) | Section D will morph into fullscreen chat |
| 2 | `/about` | Via (zinc, via.svg "i" mark) | Chromeless StoriesViewer: "Meet Via" tour |
| 3 | `/how-to` | How to (fuchsia/indigo, ▶ glyph) | Chromeless StoriesViewer: 60-second OS tour |
| 4 | `/signup-external` | Account (zinc, person glyph or Clerk avatar) | Signed-out: in-shell `<SignUp/>`. Signed-in: `<UserButton/>` account card. Dual-state visual lives in `components/auth/AuthDockTile.tsx`. |

The `/` (XO/Home) and `/cloud` (XO Cloud) tiles are NOT in the dock.
They moved into the XO folder on Page 2 (Agent mode); Landing no
longer surfaces them at all.

Enforced by two tests in `tests/unit/data/modes.test.ts`:

- "every registered mode has /ask (Chat) as the leftmost dock pin"
- "every registered mode has the same uniform dock for v1"

**Why uniform:** v1 ships predictability. Per-mode dock differentiation
is on the roadmap (auth-conditional right slot, mode-specific middles)
but is intentionally deferred so the user always knows where Chat,
Via, How to, and Account live regardless of which mode is active.

**Dock stays constant across inner sub-pages of the same mode** as
well: only the icon grid swipes; the dock is anchored.

### Mode change choreography (~600ms)

When mode changes:

1. Old icons + dock fade out + scale 1.00 to 0.96 (0-250ms)
2. Wallpaper crossfades to new mode's theme (150-450ms)
3. Status bar tint shifts to new mode color (250-550ms)
4. New icons + dock fade in + scale 1.04 to 1.00 (300-600ms)
5. Character (if mounted) speaks the new mode's greeting (post-600ms)

`useReducedMotion: true` collapses all this to a ~150ms opacity
cross-dissolve.

### Per-mode auth gate

Each mode declares `auth: "public" | "required"` in its
`data/modes/<id>.ts`. Pager intercepts swipe commits: if destination
is `auth: "required"` and Clerk session is missing, show the
sign-in surface (Screen 12) and queue the swipe. On successful
sign-in the swipe completes. On cancel, snap back to current mode.

### Mode registry

`lib/xo-mode-registry.ts` is a singleton. Modes register themselves
in `data/modes.ts`. Adding a 4th mode is "create
`data/modes/<id>.ts` + add one register call." Third-party plugins
can register modes at runtime; the provider reads via
`useSyncExternalStore` so the UI re-renders automatically.

---

## 8. Lockscreen

Gates entry to the OS. Hosts the **Mood widget** (Via mascot with
current expression, tap-to-pat) and the **Thought of the day
widget** (one-line quip beneath the clock). Status bar + Dynamic
Island remain visible above the lockscreen.

### Boot resolution

```
   1. URL path !== "/"             → unlocked (deep links bypass)
   2. localStorage xo-lock-v1 ok   → unlocked (24h rolling window)
   3. otherwise                    → locked
```

### Unlock paths (all route to `LockContext.unlock()`)

- Swipe up from bottom edge (GestureSurface routes to unlock when locked)
- Tap the swipe-up pill
- Press Esc, Space, or Enter

### Mood widget

- Reads `AgentContext.state`, computes expression via
  `viaStateFromAgent(state)`
- Renders `<Via expression={...} animation={...} size={140}/>`
- Tap-to-pat: ephemerally overrides to `happy` + bob for ~3s,
  reverts to whatever agent state says
- Sparkle SVG re-renders per pat (key-driven remount)

### Thought of the day widget

- Fetches `GET /api/widgets/quip` on mount
- Tap to cycle (refetch)
- Source: `data/quips.ts` local or `cowork-api /api/quip`; pending

### Re-lock

Tap the right-side device button (`DeviceFrame.tsx`). Aria-label
flips. Lockscreen slides DOWN from above (~750ms decelerating
tween).

---

## 9. Gestures + the consolidated overlay

### Current zones (v.Next direction)

```
   ┌───────────────────────────────────────────────────┐
   │  ↓ top swipe-down (anywhere)  →  consolidated     │ top 24 px
   │     Overlay (notif + controls + search)            │
   ├───────────────────────────────────────────────────┤
   │                                                   │
   │  pager:  swipe ←/→  =  mode change (outer) or     │ content
   │           sub-page (inner)                         │ area
   │                                                   │
   ├───────────────────────────────────────────────────┤
   │           ↑ home / unlock zone                    │ bottom 30 px
   └───────────────────────────────────────────────────┘
```

### Three-into-one overlay (Section I, pending)

v0 had three separate panels (Notification, Control Center,
Spotlight). Control Center has been **fully deleted** (zone removed
from `lib/gestures/zones.ts`, "control" stripped from
`GestureContext.OpenPanel` union, `controlT` motion value removed,
`components/gestures/ControlCenterPanel.tsx` deleted, all callers
cleaned).

Section I will consolidate the remaining two (Notifications +
Spotlight) into a single `components/overlays/Overlay.tsx`
triggered by ANY top swipe-down. Sections inside: notifications,
search. Scrolls vertically. Scrim tap or pull-up closes.

Until Section I lands, `NotificationPanel.tsx` and
`SpotlightPanel.tsx` are still the two transitional panels.
`GestureSurface.tsx` arbitrates based on top-left half (notif) and
the Spotlight zone (search). Do not re-introduce a "top-right" or
"control" zone.

### State machine (in `lib/gestures/`)

| Phase | Trigger | Note |
|---|---|---|
| IDLE | nothing | resting |
| RECOGNIZING | pointerdown in a zone | wait for axis confirmation |
| TRACKING | movement past `RECOGNITION_PX` | panel motion value follows finger |
| COMMITTING | pointerup | distance >= 30% OR velocity >= threshold |
| SETTLED | spring resolves | state recorded |

Off-axis cancel: any drag whose dominant axis is wrong releases the
pointer back to the page. This is what lets normal vertical scroll
keep working inside an app body.

### Arbitration

`GestureSurface.tsx` is the single pointer arbiter. On pointerdown:

```
   Panel already open?        → route to panel scrim, do nothing here
   Locked?                    → only bottom-edge active, routes to unlock
   In an edge zone?           → claim immediately, preventDefault
   In Spotlight zone on home? → wait for vertical movement (so icon taps survive)
   In-content at scrollTop=0
   AND app opted into PTR?    → claim for PullToRefresh
   Else                       → release to the page
```

### Pull-to-refresh

Per-app opt-in via `xoApp.gesture.pullToRefresh.enabled`. Lives
inside the scroll container in `AppView`, not in GestureSurface.
Default intent derives from `xoApp.kind`:

| kind | Default PTR intent |
|---|---|
| `native` / `mdx` / `html` | `router.refresh()` |
| `iframe` | re-set `<iframe src>` |
| `api` | re-run the fetch |
| `external` | n/a (no body to refresh) |

---

## 10. Chat (dock button that expands)

**Chat is the leftmost dock button on every mode.** No separate
chat widget exists above the dock anywhere.

### Resting state

`<AppIcon/>` with the chat glyph and the special `dock-chat`
identifier. Tap to expand.

### Expand animation (~450ms)

1. App grid fades + scales 0.96 (0-150ms)
2. Chat button morphs from dock position to fullscreen (layoutId, 0-250ms)
3. Dock background slides up, becomes input bar (100-300ms)
4. Other dock slots fade out (100-300ms)
5. Input bar fades in (200-400ms)
6. Back chevron + Stop button appear (300-450ms)

Reverse on back chevron: ~400ms.

### Expanded surface

`<ChatExpanded/>` (Section D, NEW):

- NavBar: back chevron (collapses), title "Chat", Stop button
- Large Via at 96px (idle, bobbing)
- Greeting + 3 suggestion chips (empty state)
- Transcript bubbles (assistant left with Via avatar, user right)
- Composer + send at bottom where dock was

### Data flow (when cowork is wired, Section B + D)

```
   ChatExpanded
       │
       │ POST /api/chat { text }                ← Next route
       │ Next route: read Clerk cookie, attach Bearer + Username
       │ Forwards to cowork-api /api/chat/prompt
       │ ◀── { stream_id, session_id }
       ▼
   browser opens EventSource("/api/chat/stream/{id}")  ← Next SSE proxy
       │
       │ events arrive:
       │   session-created   { session_id }
       │   text-delta        { text }            ← Via: speaking
       │   heartbeat
       │   client-action     { kind, ...args }   ← OS reacts (see §11)
       │   done              { ... }             ← Via: happy
       │   agent-error       { ... }             ← Via: error
```

### Single session per user

Each user has exactly one chat session, ever. No session picker, no
"new chat" button. `session_id` is resolved server-side from Clerk
username on every call. The browser never tracks or stores
`session_id`. The "Sessions" cowork app drops from the catalog.

### Stop / abort

Stop button calls `POST /api/chat/abort`. Inflight `text-delta`
events stop arriving. Via reverts to `idle`.

---

## 11. Agent drives the OS (client-action events)

The cowork-api chat stream emits a new SSE event type:
`client-action` with `{ kind, ...args }`. The phone OS subscribes
to this on the EventSource and dispatches via `lib/agent/actions.ts`.

### Supported kinds (v.Next initial set)

| kind | Dispatcher action |
|---|---|
| `navigate` `{ route }` | `PhoneContext.openApp(route)` + `router.push(route)` + toast "Opening …" |
| `go-home` | `PhoneContext.goHome()` + `router.push("/")` |
| `pop-back` | `PhoneContext.pop()` |
| `open-overlay` `{ section }` | Opens consolidated Overlay panel scrolled to section |
| `close-overlay` | Closes Overlay |
| `collapse-chat` | ChatExpanded collapses but conversation persists |
| `expand-chat` | ChatExpanded opens |
| unknown | Logged in dev, ignored in prod |

User asks "show me my files" → agent emits
`{ kind: "navigate", route: "/files" }` → OS routes there while
chat stays open in front. Back chevron collapses chat, Files app is
visible underneath.

---

## 12. Adding an app

### Native app (most common)

1. Create `app/<route>/app.ts`:
   - Use `defineXOApp({ path, label, glyph, tile, kind: "native", ... })`
   - Set `description` if you want a tagline under the header
   - Set `featured: true` for a large icon block in the header
   - Set `availableIn: ["mode-id", ...]` to restrict modes
   - Set `requiredRoles: ["signed-in"]` to gate access
   - Set `gesture: { pullToRefresh: { enabled: true } }` for PTR
2. Create `app/<route>/page.tsx`:
   - Server Component by default
   - Import `xoApp` from `./app`
   - `export const metadata = xoApp.metadata`
   - Render `<XOAppShell app={xoApp}>...</XOAppShell>`
3. Register in `data/apps.ts`:
   - Import the new `xoApp`
   - Add it to the `apps` registry array

### kind: "api" (cowork-derived)

Same as above plus:

4. Create `app/api/cowork/<name>/route.ts` Next proxy. Use the
   pattern from `ADR_001_COWORK_INTEGRATION.html` §"Route handler
   pattern". ~30 LOC: read Clerk username, attach headers, forward
   to cowork-api, return response body.
5. The Server Component page fetches its data from
   `${origin}/api/cowork/<name>` (NEVER from `:5002`).

### kind: "mdx"

Same as native plus `collection: "<dir>", slug: "<file>"` on the
`xoApp`. Content lives at `content/<collection>/<slug>.mdx`. Page
uses `loadMdxSource()` + `<MDXRemote source={source} components={mdxComponents}/>`.

### kind: "html"

Static HTML rendered in a sandboxed iframe. Inline `html: "..."`
or file-backed (`collection`, `slug`). Use `<XOAppShellHtml/>` not
`<XOAppShell/>`.

### kind: "iframe"

External URL rendered in a sandbox iframe. `src: "..."` and
optional `sandbox: "..."`. Use `<XOAppShellIframe/>`.

### kind: "external"

Pure dock tile that opens a URL in a new tab. No `page.tsx` needed.
`href: "..."`.

### Mode visibility (two layers)

- **Mode-side**: list the app's path in
  `data/modes/<id>.ts`'s `appPaths` array.
- **App-side**: optionally set `availableIn: [mode_ids]` on the app
  to refuse rendering in modes outside the allowlist.

Both layers must agree for the app to appear. The double-check
matters once third-party modes can register.

---

## 13. Auth + tenancy

### Two roles for v.Next (per `MODES_PLAN.md` decisions)

- `anonymous` (no role)
- `signed-in`

Future ladder (deferred): `pro`, `admin`. Pattern is the same; the
`RoleContext` and `RoleGate` already support multi-role evaluation.

### Where the role comes from

| Layer | Source |
|---|---|
| Section G (live) | `useUser()` from `@clerk/nextjs` in `lib/auth/auth-gate.ts` |
| Server side | `auth()` from `@clerk/nextjs/server` (enabled by `middleware.ts` at the project root) |
| Role evaluator (separate axis) | `localStorage.xo-roles-v1` + dev role switcher in Settings |

The role evaluator (`lib/xo-roles.ts`) is independent. Auth gating is
binary (signed in / not). The richer role ladder (`pro`, `admin`)
remains a future addition on top of the Clerk user id.

### Sign-in surface

**v1 contract**: every mode is openly browsable. Auth is triggered ONLY
by the **Sign up** dock tile (`/signup-external`), which navigates
in-shell to a page rendering Clerk's `<SignUp />` widget (with a
built-in toggle to `<SignIn />` at the bottom).

When the user is signed in, the same `/signup-external` route renders
a small account card with Clerk's `<UserButton />` for managing the
session or signing out.

**Deferred plumbing kept on the shelf**:

- `lib/auth/auth-gate.ts` still exposes `canEnter()` + `requestSignIn()`.
- `components/auth/SignInOverlay.tsx` is mounted by `DeviceFrame` and
  still listens for `xo:auth:request-sign-in`.
- Pager + `ModeIslandIndicator` already consult the gate.

Nothing currently fires the overlay because every registered mode has
`auth: "public"`. Flipping any mode back to `auth: "required"` revives
the swipe-gate UX without further code changes.

For deep links and multi-step flows (SSO callbacks, email verification),
`/sign-in` and `/sign-up` catch-all routes still render Clerk's hosted
pages directly.

### Permissive discovery

Mode lists, dock, Spotlight all show every mode + app regardless of
role. Gating fires only when the user navigates INTO a gated app.
`<RoleGate/>` (inside `<XOAppShell/>`) renders `<SignInGate/>` over
the body when the active role set lacks the required role.

### Auth + username header flow (when cowork is wired)

```
   Browser request                          (no app code attaches headers)
   ─────────────────────────────────────────
   GET /api/widgets/agent-status
   Cookie: __session=eyJ...        ← Clerk session cookie, automatic

   Next.js Route Handler                    (lib/auth/clerk.ts helper)
   ─────────────────────────────────────────
   const { userId, username } = await auth()
   const u = username || "__operator__"

   fetch(`${process.env.COWORK_API_URL}${path}`, {
     headers: {
       Authorization: `Bearer ${process.env.XO_API_KEY}`,   ← operator key
       "X-XO-Username": u                                    ← tenant scope
     }
   })

   cowork-api                                (validates + scopes)
   ─────────────────────────────────────────
   verify Bearer matches XO_API_KEY    ← gate
   scope queries to user u             ← multi-tenancy
   return JSON for that user
```

**Signed-out visitor**: `getUsername()` returns `"__operator__"`,
cowork-api scopes to the operator's workspace (shown as demo).

**Signed-in visitor**: Clerk yields username, cowork-api scopes to
that user's data.

### Env vars (server-side only)

| Var | Purpose |
|---|---|
| `XO_API_KEY` | Operator-level long-lived Clerk PAT for cowork-api. Never `NEXT_PUBLIC_`. |
| `COWORK_API_URL` | Base URL of xo-cowork-api. Defaults to `http://localhost:5002` in dev. |
| `CLERK_SECRET_KEY` | Server-side Clerk secret. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Client-OK Clerk key (Clerk SDK requirement). |

Set placeholders in `Dockerfile`'s `builder` stage so the build
embeds them; `entrypoint.sh` swaps real values at container start.

---

## 14. State + persistence

| Storage key | Schema version | Owner |
|---|---|---|
| `xo-mode-v1` | 3 (current) | `ModeContext` |
| `xo-lock-v1` | 1 | `LockContext` |
| `xo-roles-v1` | 1 | `RoleContext` |
| (none for gestures, phone) | n/a | in-memory only |

### Versioning rules

- Bump `STORAGE_VERSION` whenever the shape changes OR the default
  changes in a user-visible way
- `readStorage()` returns null on version mismatch; the context
  falls back to defaults
- Cross-tab sync via `storage` event on every persisted state
- Best-effort writes (private mode, quota): log warning, do not
  block UI

---

## 15. Testing

Vitest + happy-dom + RTL is the scaffold. Phase 0 shipped.

### Current state

**57 tests across 5 files, all passing** (`pnpm test`):

| File | Tests | What it covers |
|---|---|---|
| `tests/unit/lib/cowork/browser-client.test.ts` | 22 | Mock/real switch, fetch shape, abort, SSE stream parsing |
| `tests/unit/data/modes.test.ts` | 11 | Mode registration, precedence, dock validation, auth field |
| `tests/unit/lib/pager/commit.test.ts` | 10 | Distance + velocity thresholds, edge clamping |
| `tests/unit/lib/auth/auth-gate.test.ts` | 5 | Stub permissiveness; future-proof contract |
| `tests/unit/lib/xo-roles.test.ts` | (legacy) | Role evaluator |

### Layout (per `TESTING_PLAN.md`)

```
tests/
├── setup.ts          jest-dom matchers, reduced-motion mock
├── unit/             pure logic + context unit tests
├── components/       RTL component tests (empty for now)
├── integration/      cross-system flows with real providers (empty)
├── api/              Route handler tests (mock cowork-api with MSW; empty)
└── e2e/              Playwright (separate runner; empty)
```

### Commands

| Command | What it does |
|---|---|
| `pnpm test` | All non-e2e suites once |
| `pnpm test:watch` | Watcher |
| `pnpm test:ui` | Vitest browser UI |
| `pnpm test:coverage` | V8 coverage report |
| `pnpm typecheck` | `tsc --noEmit` (run after deleting routes; stale `.next/types/` cause false positives, `rm -rf .next` to recover) |
| `pnpm lint` | eslint flat config |

### Conventions

- One test file per source module (`lib/xo-roles.ts` →
  `tests/unit/lib/xo-roles.test.ts`)
- Prefer Testing Library queries by role/label (doubles as a11y check)
- Force `useReducedMotion: true` in test setup so animations are
  instant
- Live SDK calls live in `*.live.test.ts` files, run only with
  `LIVE=1` env var (nightly cron, not per-PR)
- New section work MUST land with tests for any new `lib/` module.
  Component-level tests follow when Section D introduces real chat UI.

---

## 16. Don't do this

A short list of failure modes, all of which have happened or were
explicitly considered and rejected.

| Don't | Why |
|---|---|
| Add `NEXT_PUBLIC_XO_API_KEY` | Leaks the operator key to the browser bundle. Violates ADR_001. |
| Call `http://localhost:5002` from a browser component | Browsers must only call `/api/*`. CORS, key exposure, no rate-limit point. |
| Filter modes by role in `ModeProvider` | Discovery is permissive on purpose. Gate at the app body via `<RoleGate/>` only. |
| Add a third-party mode without `defineMode` | Bypasses validation (dock max 4, dock paths must be in appPaths). Use the factory. |
| Mount a scrim with `pointer-events: auto` when closed | Swallows every tap on the screen. Always gate on `isOwner`. |
| Add a panel without registering it in `GestureContext` | The motion value will not be cleared on close; state drifts. |
| Build a new top-corner gesture zone | v.Next consolidates ALL top-edge gestures into one. Add to the consolidated Overlay, do not re-introduce corners. |
| Add a "new chat" button or session picker | Single session per user. The conversation IS the chat dock. |
| Drive animation timings from per-component magic numbers | Use `PANEL_SPRING` from the constants module. One source of truth keeps the OS coherent. |
| Skip `useReducedMotion` | Accessibility violation. Every animation path needs an instant-snap fallback. |
| Write to `.xo/` | Watcher service owns that directory; agent writes will conflict. |
| Add a new client-action kind without telling cowork-api | The dispatcher logs unknown kinds in dev and ignores in prod, but the agent will never emit kinds that were not negotiated. |

---

## 17. Workflow conventions

### Before any change

1. Read this file (you are here).
2. Read the relevant HTML reference doc:
   - Building a screen → `SCREENS.html`
   - Wiring cowork → `COWORK_INTERACTION.html` + `ADR_001_COWORK_INTEGRATION.html`
   - Planning a feature drop → `V_NEXT_PLAN.html`
3. Check the existing `.md` plans for the system you're touching:
   - `MODES_PLAN.md`, `LOCKSCREEN_PLAN.md`, `GESTURE_PLAN.md`,
     `CHARACTER_PLAN.md`, `TESTING_PLAN.md`, `AGENT_PLAN.md`,
     `NEXTJS_MIGRATION_PLAN.md`, `LIFECYCLE.md`, `ARCHITECTURE.md`
4. Check the corresponding one-pager: `MODES.md`, `GESTURES.md`,
   `LOCKSCREEN.md`, `SYSTEMS.md`.
5. Check what already exists in `components/`, `context/`, `lib/`.
   Reuse before creating.

### Standard change loop

For any non-trivial change, follow this exact sequence:

```
   1. State the intent in one sentence.   (what + which section in §2 above)
   2. Read the affected files start to finish before editing.
   3. Mock-first: if cowork-api is involved, build/extend in lib/cowork/
      (mocks + browser-client) before touching app/api/*.
   4. Edit. Keep pure logic in lib/, React in components/, side-effecty
      stuff in context/ or route handlers.
   5. Add or update tests in the matching tests/unit/<area>/ directory.
   6. Run: pnpm test, pnpm typecheck, pnpm lint.
   7. If you touched the Pager, the Lockscreen, or a gesture: open the
      preview server and verify the swipe / unlock / panel in a real
      browser. Unit tests do NOT catch perceptible-motion regressions.
   8. Commit with a one-sentence subject and a brief body explaining
      the section / phase touched.
```

### Mock-first pattern (Section K is the reference)

The browser must never know whether mocks or real Next routes are
behind `lib/cowork/browser-client.ts`. The pattern:

```
   UI code
      │
      ▼
   coworkApi.<method>()            ← lib/cowork/browser-client.ts
      │
      ├── if NEXT_PUBLIC_USE_COWORK_MOCKS = "1"
      │     → resolve from lib/cowork/mock-data.ts (sync)
      │     → SSE streams resolve from lib/cowork/mock-stream.ts
      │
      └── else
            → fetch("/api/cowork/...")   ← Section B Next route handler
            → that route reads Clerk + injects XO_API_KEY
            → that route forwards to cowork-api on :5002
```

UI code calls only `coworkApi.foo()`. Switching the flag swaps
backends. Adding a new endpoint means:

1. Add the type to `lib/cowork/types.ts`
2. Add the fixture to `lib/cowork/mock-data.ts`
3. Add the method to `browser-client.ts` with mock + fetch branches
4. Build the UI against the mock branch
5. Land Section B's route handler when ready

### Where things go

| Adding | Goes here |
|---|---|
| New app | `app/<route>/{app.ts,page.tsx}` + register in `data/apps.ts` |
| New mode | `data/modes/<id>.ts` + register in `data/modes.ts`, bump `STORAGE_VERSION` in `ModeContext` |
| New cowork endpoint surface | `lib/cowork/types.ts` + mock + browser-client method + (later) `app/api/cowork/<name>/route.ts` |
| New widget | `components/widgets/<Name>.tsx` + optional `app/api/widgets/<name>/route.ts` |
| New shell component | `components/<Name>.tsx` flat, not in a subdir |
| Pure logic | `lib/<area>/<name>.ts` (no React, no DOM, no fetch) |
| New context | `context/<Name>Context.tsx` + register in `app/providers.tsx` (mind the order, §6) |
| Test | `tests/<unit|components|integration|api|e2e>/<area>/<name>.test.ts` |

### When committing

- `pnpm test` green, `pnpm typecheck` clean, `pnpm lint` clean
- No em dashes, no en dashes anywhere (code, comments, commit messages)
- No new client-side calls to external APIs (rule #4 in §3)
- Storage version bumped if persisted state shape changed
- Plan doc / build status in §2 updated if you shipped a section
- New `lib/` module → matching test file in `tests/unit/`

### When unsure

Ask. Examples of good clarifying questions:

- "Which mode should this new app belong to: landing, agent, or both?"
- "Should this require `signed-in`, or stay anonymous?"
- "Is this a v0 cleanup or a v.Next build?"
- "Should the gate fire on navigate or only on action attempt?"
- "Mock-only for now, or also wire the Next route handler?"

---

## 18. Open contract questions

These are documented in `COWORK_INTERACTION.html` §7 and
`V_NEXT_PLAN.html` §7. Do not resolve unilaterally; flag them.

- `X-XO-Username` header name (or another name)
- Username value when signed out (`__operator__`, empty, omit?)
- How cowork-api emits `client-action` events (tool call, special token, structured output)
- Supported `client-action` kinds in the first cowork drop
- Quip source (local `data/quips.ts`, repointed `/api/agent/quip`, new cowork endpoint)
- Binary file download (`/api/files/content-binary`?)
- SSE stream reconnect with `Last-Event-ID`
- `/api/channels/` and `/api/usage` response shapes
- Connector endpoints needed for first ship
- Get Started tile target (setup mode hidden)
- Create Your Own button target (signed-in rightmost dock)
- Journal app full spec
- About + Via dock buttons (existing apps vs new routes)
- Lockscreen "more interactive" stretch scope

---

## 19. Document map

Use this as the index when picking what to read next.

### Reference, source of truth

| File | What it is |
|---|---|
| `V_NEXT_PLAN.html` | The pivot plan. v0 → v.Next. 5 build steps + deferred set. |
| `SCREENS.html` | Every screen, what's on it, what the user can do. 13 mockups. |
| `COWORK_INTERACTION.html` | Endpoint catalog + auth flow + 5 major flows. |
| `ADR_001_COWORK_INTEGRATION.html` | The architectural decision (thin client + Next proxy). |
| `APP_LOADING.html` | How apps are loaded, the 7 kinds, and the per-piece storage map (what is local vs cowork vs not implemented). |

### Plans (mostly executed, some pending)

| File | Status |
|---|---|
| `NEXTJS_MIGRATION_PLAN.md` | Executed |
| `MODES_PLAN.md` | Executed through Phase 7.0 |
| `GESTURE_PLAN.md` | v1 executed |
| `LOCKSCREEN_PLAN.md` | Phases 1-4 executed |
| `TESTING_PLAN.md` | Phase 0 executed |
| `CHARACTER_PLAN.md` | Not started; Via component built separately |
| `AGENT_PLAN.md` | v0; will be reframed when Section D (chat UI shell) lands |

### One-pagers (logic + flow, no implementation detail)

| File | What it covers |
|---|---|
| `MODES.md` | Mode system as it is built today |
| `GESTURES.md` | Gesture state machine + arbitration |
| `LOCKSCREEN.md` | Lockscreen + unlock paths + persistence |
| `SYSTEMS.md` | How modes + lock + gestures + role interact |

### Architecture

| File | What it covers |
|---|---|
| `ARCHITECTURE.md` | Codebase shape: provider tree, file map, current state |
| `LIFECYCLE.md` | Render lifecycle + animation primitives |
| `VIA.md` | Mascot API + roadmap |
| `XOAPPS.md` | App-kind taxonomy + how to ship each kind |
| `ADDING_APPS.md` | Per-kind app authoring recipes |
| `COWORK_WRAPPER.md` | Server-side cowork-api client + types |
| `CLAUDE_INTEGRATION.md` | Claude Agent SDK usage in v0 (being removed) |
| `FRAMEWORK_COMPARISON.md` | Why Next.js over the alternatives |

---

## 20. The single most important rules

If you only remember three things:

1. **The browser only ever calls `/api/*` on this origin.** Every
   call to xo-cowork-api goes through a Next Route Handler. Keys
   live on the server. ADR_001 enforces this.

2. **`PANEL_SPRING` and `GLASS_PANEL_CLASS` are the OS coherence
   anchors.** Both panels, the icon morph, the mode crossfade, the
   sign-in gate, every glassy surface, all use them. Touch one, you
   touch all of them.

3. **Permissive discovery, strict access.** Modes, apps, dock items
   show to everyone in every mode. Gating happens at the app body
   via `<RoleGate/>`, never at the UI surface. Per `MODES_PLAN.md`
   decision: "Completely open and free to try just when they
   navigate to it, it either shows, a paywall or sign in
   components."

Everything else in this file is detail. These three are the spine.

---

## 21. Remaining build plan (the next 8 sections)

The order is intentional. Each section unlocks the next; do not skip
ahead. Status is mirrored from §2.

### Section I, Consolidated Overlay (next up)

- **Goal**: replace `NotificationPanel` + `SpotlightPanel` with one
  `components/overlays/Overlay.tsx` that any top-edge swipe-down
  opens. Vertically scrollable sections inside: notifications, search.
- **Touches**: `lib/gestures/zones.ts` (collapse top-left into full-
  width top zone), `context/GestureContext.tsx` (single `overlayT`
  motion value, `openPanel = "overlay" | null`), new `components/
  overlays/Overlay.tsx`, delete `NotificationPanel.tsx` and
  `SpotlightPanel.tsx` once the new panel ships.
- **Tests**: gesture zone routing, overlay open/close state.
- **Pre-req**: none (independent).

### Section D, Chat dock expand

- **Goal**: leftmost dock chat button morphs (`layoutId`) into a
  fullscreen `<ChatExpanded/>` surface. Dock background converts to
  composer. Back chevron reverses the morph.
- **Touches**: new `components/chat/ChatExpanded.tsx`, update
  `components/Dock.tsx` and `components/AppIcon.tsx` to recognize
  the special `dock-chat` id, hook `coworkApi.chatPrompt()` +
  `coworkApi.streamChat()` to the UI.
- **Mock-first**: mock stream already exists in
  `lib/cowork/mock-stream.ts`; build the UI against that.
- **Tests**: open/close transitions, transcript rendering, SSE event
  handling.
- **Pre-req**: optional Section E (Via widget) for the chat header.

### Section E, Widgets

- **Goal**: AgentStatus pill on lockscreen, Mood (Via expression),
  Thought of the day quip; consume `coworkApi.agentStatus()` and
  `coworkApi.quip()`.
- **Touches**: new `components/widgets/{AgentStatus,Mood,Thought}.tsx`,
  wire into `LockScreen.tsx`.
- **Mock-first**: mock data already in `lib/cowork/mock-data.ts`.
- **Tests**: each widget's rendering + the cycle-on-tap behavior for
  Thought.

### Section H, Cowork-derived apps

- **Goal**: ship `kind: "api"` apps for files, agents, channels,
  usage, sessions (sessions becomes implicit per §10; deferred).
- **Touches**: new `app/<route>/{app.ts,page.tsx}` per app, all
  fetching via `coworkApi.<method>()` (mock or real per flag).
- **Tests**: app-level integration tests using the mock client.

### Section B, Real Next Route Handlers

- **Goal**: implement `app/api/{chat,widgets,cowork}/.../route.ts`
  that read Clerk username and forward to cowork-api on :5002.
- **Touches**: ~30 LOC per handler, pattern in
  `ADR_001_COWORK_INTEGRATION.html`.
- **Tests**: `tests/api/` with MSW mocking cowork-api.
- **Pre-req**: none, but lands AFTER UI is built against mocks
  (so the flag flip is a one-line change in env, not in code).

### Section G, Clerk wiring (✅ DONE)

Shipped: `<ClerkProvider>` at root layout, `middleware.ts` at project
root, real `useAuthGate()` reading `useUser()`, in-shell
`<SignInOverlay>` mounted by `DeviceFrame`, `/sign-in` and `/sign-up`
catch-all routes. Pager calls `requestSignIn({ redirectMode })` on
gate block and resumes the swipe after Clerk confirms the session.

Env vars (set in `.env.example`):
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
`NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`,
`NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`.

### Section J, Agent-driven OS actions

- **Goal**: SSE stream emits `client-action` events that drive
  `PhoneContext` (navigate, go-home, open-overlay, collapse-chat).
- **Touches**: `lib/agent/actions.ts` (NEW; dispatcher only, no
  runtime), extend mock stream to emit a sample action, wire the
  EventSource subscriber in ChatExpanded.
- **Tests**: each kind's dispatch path; unknown-kind safety.

### Section F, Feed mode body (deferred)

- **Goal**: actual content for the 3rd Pager page (renamed from
  "Public" to "Feed" in v.Next).
- Spec to be defined when the other sections land.

---

## 22. CLAUDE.md note

`CLAUDE.md` at the repo root is a one-line `@AGENTS.md` import.
This file IS the project guide. Update this file when state changes;
do not split rules across two locations.
