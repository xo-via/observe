# xo-phone-os gesture plan

High-level architecture plan for adding iPhone-style gestures to the
phone OS. v1 ships five gestures only; everything else is v2. No
implementation, no code samples, diagrams only.

This doc reflects the **current** app architecture (`lib/xo-app.ts`
discriminated union, per-route `app/<route>/app.ts` files, central
registry in `data/apps.ts`, server-side `XOAppShell` wrapper). Per-app
gesture opt-ins are declared next to the rest of the app config.

Pair with `LIFECYCLE.md` (animation primitives) and `ARCHITECTURE.md`
(current shape).

---

## 1. Why gestures

Today the only real gesture is the home-indicator drag. Everything
else is tap-only. That leaves the iPhone illusion thin: the chrome
looks like iOS, the interactions do not.

A gesture layer earns three things:

1. **Believability.** Pull down from the top-right on a real iPhone,
   control center opens. Doing the same here is what makes "the
   website is an iPhone" stop feeling like a costume.
2. **Surface for the unbuilt overlays.** `switcherOpen`,
   `notificationsOpen`, and `controlCenterOpen` already exist in
   `PhoneContext` with no triggers. Gestures wake them up.
3. **Demoable polish.** Short-circuited evidence of craft.

---

## 2. Target gesture vocabulary

Mapped from iOS. v1 covers only the five gestures explicitly chosen.

| iOS gesture | Our equivalent | Tier |
|---|---|---|
| Swipe up from bottom edge | Goes home: `goHome()` + `router.push("/")` | **v1** |
| Swipe down from top-left | Notification center: `toggleNotifications(true)` | **v1** |
| Swipe down from top-right | Control center: `toggleControlCenter(true)` | **v1** |
| Pull down on home screen | Spotlight surface slides in above the grid | **v1** (gesture + empty panel) |
| Pull-to-refresh inside an app | Per-app opt-in via `xoApp.gesture.pullToRefresh` | **v1** |
| Swipe up + hold from bottom | App switcher (`toggleSwitcher(true)`) | v2 |
| Swipe right from left edge | Back: `pop()` or `goHome()` | v2 |
| Long-press an app icon | Context sheet / jiggle mode | v2 |
| Swipe between apps (bottom) | Quick app switch on bottom edge | v2 |
| Haptics on any gesture | Vibration API where available | v2 |
| Pinch / spotlight search content / wallpaper switch | Per-feature | later |

The whole "stretch" category from the previous draft (multi-finger,
real notification feed, wallpaper switching, etc.) stays in v2 or
later.

---

## 3. Gesture zones, visually (v1 only)

Three reserved zones for v1. Left edge, switcher zone, and long-press
overlays are not part of v1.

```
  ┌───────────────────────────────────────────────────┐
  │ ↓ notif zone                  ↓ control zone      │  <- top 24 px
  │ (top-left third)              (top-right third)   │     of the screen
  │                                                   │
  ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
  │                                                   │
  │                  content area                     │
  │                                                   │
  │   on /            → top half drag down            │  spotlight pull-down
  │                     opens Spotlight                │  is "home-screen only"
  │                                                   │
  │   in an app      → in-content vertical drag       │  pull-to-refresh is
  │                     at scrollTop===0 starts PTR    │  per-app opt-in
  │                     (only if opted in)             │
  │                                                   │
  ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
  │                                                   │  <- bottom 30 px:
  │           ↑  home zone                            │     home indicator
  │                                                   │     (existing)
  └───────────────────────────────────────────────────┘
```

Rules:

- **Zones are touch-start filters, not visual elements.** They affect
  which pointer-down events the gesture coordinator claims.
- **Vertical scrolling inside an app is preserved by default.** A
  touch that starts in the content area never triggers an OS-level
  gesture unless the app opts in to pull-to-refresh and the scroll
  is at the top.
- **Spotlight is home-screen only.** A drag in the same coordinates
  while an app is in the foreground does nothing.

---

## 4. Architecture overview

One new context, one new gesture surface, three new panels. Slots
between `PhoneProvider` and `DeviceFrame`.

```
   <CharacterProvider>     (planned, character plan)
     └ <PhoneProvider>
         └ <GestureProvider>            ◀── NEW
             └ <DeviceFrame>
                 ├ <StatusBar/>
                 ├ <GestureSurface/>    ◀── NEW: invisible overlay,
                 │                          owns touch zones, captures
                 │                          pointer events, runs the
                 │                          state machine
                 ├ HomeScreen | AppView
                 │   (AppView wraps page body in a scroll container
                 │    that opts into pull-to-refresh per app)
                 ├ <NotificationPanel/>  ◀── NEW: slides from top
                 ├ <ControlCenterPanel/> ◀── NEW: slides from top
                 ├ <SpotlightPanel/>     ◀── NEW: slides from top,
                 │                          only mounts when on home
                 └ <HomeIndicator/>       (visual stub; drag logic
                                           moves into GestureSurface)
```

`GestureProvider` owns state and exposes intents. `GestureSurface`
owns pointer plumbing. Panels subscribe to motion values the surface
writes. Same split as the previous draft; `AppSwitcher` is the only
panel that moves out (to v2).

---

## 5. Per-app gesture opt-in

Pull-to-refresh is the first per-app gesture. It lives next to the
rest of the app config, not in a central registry.

Extend the `XOApp` discriminated union in `lib/xo-app.ts` with one
new optional field on `XOAppBase`:

| Field on `XOAppBase` | Purpose |
|---|---|
| `gesture?: { pullToRefresh?: PullToRefreshSpec }` | Opt-in handlers per app |

`PullToRefreshSpec` is small:

| Field | Purpose |
|---|---|
| `enabled: true` | Switch on the gesture |
| `intent: "refresh-route" \| "reload-iframe" \| "refetch-api" \| "custom"` | What "refresh" means for this app kind |
| `onTrigger?` | Optional callback name resolved client-side (for `custom`); declarative for everything else |

Defaults by `kind`:

| `XOApp.kind` | Default intent if `pullToRefresh.enabled` | Behavior |
|---|---|---|
| `native` | `refresh-route` | `router.refresh()` |
| `iframe` | `reload-iframe` | re-set `<iframe>` `src` |
| `api` | `refetch-api` | re-run the fetch with `revalidate` honored |
| `mdx` | `refresh-route` | same as native |
| `external` | n/a | external tiles do not open an in-OS page |

The seam stays declarative. Apps that want PTR add three lines to
their `app.ts`; apps that do not get the OS default (no PTR).

`XOAppShell` reads the spec and wraps `children` in a PTR-aware
scroll container when enabled. Apps that need something fancier than
the four canned intents pass `intent: "custom"` and a callback name
that `XOAppShell` resolves via a small client-component lookup.

---

## 6. The gesture state machine

Unchanged from the previous draft. One gesture moves through five
states; multi-touch is out of scope.

```
                ┌────────────┐
                │   IDLE     │   no active gesture
                └─────┬──────┘
        pointerdown   │
        in a zone     ▼
                ┌────────────┐
                │ RECOGNIZING│   coordinator watches direction +
                │            │   distance before committing.
                │            │   Movement < threshold → cancel.
                │            │   Wrong axis → release pointer back
                │            │   to the page (so vertical scroll
                │            │   still works for an off-axis drag).
                └─────┬──────┘
       threshold       │
       crossed         ▼
                ┌────────────┐
                │  TRACKING  │   gesture committed. Pointer captured.
                │            │   Panels move 1:1 with the finger.
                └─────┬──────┘
       pointerup       │
                       ▼
                ┌────────────┐
                │ COMMITTING │   commit threshold met (distance OR
                │            │   velocity)?
                │            │   yes → animate to open / closed / home
                │            │   no  → spring back to start
                └─────┬──────┘
        spring         │
        settles        ▼
                ┌────────────┐
                │  SETTLED   │   final state recorded in context.
                │            │   Coordinator returns to IDLE.
                └────────────┘
```

Tunable thresholds (constants module):

- **Recognition threshold:** 8 px in axis
- **Off-axis cancel:** 12 px in opposing axis
- **Commit distance:** 30% of panel travel (for PTR: a fixed 70 px)
- **Commit velocity:** 0.5 of screen height per second
- **Spring physics:** stiffness 280, damping 28 (matches the existing
  icon-to-app morph)

---

## 7. Arbitration: which gesture claims a touch

Simpler than the previous draft because v1 is smaller.

```
   pointerdown event
         │
         ▼
   ┌─────────────────────────────────────┐
   │ Is a panel already open?            │
   │   yes → route the touch to the open │
   │         panel (drag to close, tap   │
   │         scrim to close)             │
   │   no  → continue                    │
   └─────────────────────────────────────┘
         │
         ▼
   ┌─────────────────────────────────────┐
   │ Where did the touch start?          │
   │                                     │
   │   top-left  edge (24 px) → notif    │
   │   top-right edge (24 px) → control  │
   │   bottom    edge (30 px) → home     │
   │                                     │
   │   content area on home screen, top  │
   │     half, vertical drag down        │
   │       → Spotlight (claim only       │
   │         after off-axis check)       │
   │                                     │
   │   content area inside an app,       │
   │     scrollTop === 0, vertical drag  │
   │     down, app opted in to PTR       │
   │       → pull-to-refresh             │
   │                                     │
   │   anything else → release to page   │
   └─────────────────────────────────────┘
         │
         ▼
   ┌─────────────────────────────────────┐
   │ Enter RECOGNIZING for the candidate │
   │ gesture. Watch axis + distance.     │
   │   off-axis → cancel, release        │
   │   matches  → enter TRACKING         │
   └─────────────────────────────────────┘
```

Three rules to internalize:

1. **Open panels win.** A touch landing while any panel is open
   talks to that panel only.
2. **Edge corners are exclusive.** The two top corners and the
   bottom edge belong to the gesture coordinator. The home
   indicator pill stays as a visual hint but no longer owns the
   drag itself.
3. **Content-area gestures are conditional.** Spotlight needs
   `current === "/"`. PTR needs `xoApp.gesture.pullToRefresh.enabled
   && scrollTop === 0`. Anything failing those conditions releases
   to the page.

---

## 8. State additions

**Inside `GestureProvider` (new):**

| Field | Purpose |
|---|---|
| `activeGesture` | `"home" \| "notifications" \| "control" \| "spotlight" \| "ptr" \| null` |
| `phase` | `"idle" \| "recognizing" \| "tracking" \| "committing" \| "settled"` |
| `panelOffsets` | per-panel motion values (notif Y, control Y, spotlight Y, ptr distance) |
| `peeking` | `true` when a panel is partway open mid-drag |
| `ptr` | `{ appPath, status: "idle" \| "pulling" \| "refreshing" \| "done" }` for the active app |
| `lastSettleAt` | ms timestamp; debounces rapid open/close |

**Additions to existing `PhoneContext`:**

None for v1. (The previous draft added `recentApps` for the switcher;
the switcher is v2, so this field deferred.)

Existing flags driven by the gesture provider: `switcherOpen` stays
unused, `notificationsOpen`, `controlCenterOpen` get wired.
`spotlightOpen` is new but lives in `GestureProvider`, not
`PhoneContext`, because only the gesture layer cares.

---

## 9. The panels

Three render targets for v1. All driven by motion values the gesture
surface writes.

```
  NotificationPanel               ControlCenterPanel
  ┌──────────────────┐            ┌──────────────────┐
  │  Notifications   │            │  Control center  │
  │  ─────────────── │            │  ◯  ◯  ◯  ◯     │  toggles
  │  [empty for v1]  │            │  ▢  ▢  ▢  ▢     │
  └──────────────────┘            └──────────────────┘
   slides from top                 slides from top
   anchored top-left               anchored top-right
   covers ~80% of screen height    covers ~80% of screen height

  SpotlightPanel
  ┌──────────────────────────────────────────────┐
  │  🔍  search                                  │  text input
  │  ─────────────────────────────────────────── │
  │  suggestions:                                │  static list of all
  │    Coworker  Swarm  Pricing  Docs ...        │  app labels, taps
  │                                              │  open them
  └──────────────────────────────────────────────┘
   slides from top, only on / route
   covers ~60% of screen height
```

Content rules (v1):

- **Notifications:** empty state. "Nothing here yet" + a sentence
  about future use. Real notifications are not in v1.
- **Control center:** three real toggles (reduced motion, character
  dismiss, theme toggle once theming lands) + decorative tiles
  (brightness, wifi, flashlight). Decorative ones tagged so users
  do not expect them to function.
- **Spotlight:** input field + a static list of all `XOApp`s
  filtered by label. No real search; this ships the gesture and the
  surface, content depth comes later.

---

## 10. The pull-to-refresh surface

PTR is the one v1 gesture that lives **inside** an app, not as a
panel. Visual contract:

```
  app body in normal scroll              user pulls past 0
  ┌──────────────────┐                   ┌──────────────────┐
  │ NavBar           │                   │ NavBar           │
  │ ──────────────── │                   │ ──────────────── │
  │ page content     │                   │       ◜  ◝       │  ← spinner reveal
  │                  │      drag down    │     /    /       │    grows with
  │                  │      ────────►    │     ◟  ◞         │    pull distance
  │                  │                   │ page content     │
  └──────────────────┘                   │ (translated      │
                                         │  down)           │
                                         └──────────────────┘

  release past 70 px              spinner replaced with checkmark,
                                  then PTR snaps content back up
  ┌──────────────────┐
  │ NavBar           │
  │ ──────────────── │
  │   refreshing     │  ← intent runs (route refresh,
  │   spinner spins  │    iframe reload, api refetch,
  │                  │    or custom callback)
  │ stale content    │
  └──────────────────┘
```

The PTR surface is provided by `XOAppShell` for apps that opt in.
`XOAppShellIframe` and any custom shells need their own PTR wrapper
since they bypass `XOAppShell`. The gesture coordinator only runs
the state machine; the visual is owned by the shell.

---

## 11. Where each gesture lives

| Concern | New file |
|---|---|
| Gesture state + intent actions | `context/GestureContext.tsx` |
| Pointer capture, state machine, arbitration | `components/gestures/GestureSurface.tsx` |
| Notification panel surface | `components/gestures/NotificationPanel.tsx` |
| Control center panel surface | `components/gestures/ControlCenterPanel.tsx` |
| Spotlight panel surface | `components/gestures/SpotlightPanel.tsx` |
| PTR-aware scroll container | `components/gestures/PullToRefresh.tsx` (consumed by XOAppShell) |
| Per-zone hit testing | `lib/gestures/zones.ts` |
| Thresholds and physics constants | `lib/gestures/constants.ts` |
| `XOApp` schema bump for `gesture.pullToRefresh` | extend `lib/xo-app.ts` |

`HomeIndicator.tsx` shrinks to a visual stub (drag logic moves to the
gesture surface). `XOAppShell.tsx` adds the optional PTR wrapper.

---

## 12. Phased build

Four small phases for v1, two for v2 once we get there.

```
   v1 phases
   ─────────

   Phase 1 → scaffold + bottom-edge home gesture
           - GestureProvider, GestureSurface skeleton
           - bottom-edge zone wired to swipe-up home
           - HomeIndicator becomes visual-only
           - parity check: tap and swipe both return home

   Phase 2 → notification + control center panels
           - top-right and top-left zones wired
           - both panels render with v1 content + scrim
           - drag-down to peek, release to commit / spring back

   Phase 3 → Spotlight pull-down (home screen)
           - home-screen-only zone in the top half of the grid
           - SpotlightPanel slides in with input + filtered app list
           - tap an app → openApp + close spotlight

   Phase 4 → pull-to-refresh
           - extend XOApp with gesture.pullToRefresh
           - XOAppShell wraps children in PullToRefresh when opted in
           - default intents: route refresh, iframe reload, api refetch
           - one app opts in as the canonical example (Docs? Demo?)

   v1 polish
   - threshold tuning on a real phone
   - prefers-reduced-motion: panels snap, no spring
   - cleanup of dead AppSwitcher references

   ─────────
   v2 phases (after v1 ships)
   ─────────

   Phase 5 → app switcher + recentApps tracking
   Phase 6 → left-edge back gesture
   Phase 7 → long-press app icons (context sheet, jiggle)
   Phase 8 → haptics (Vibration API where available)
```

v1 effort, one engineer:

| Phase | Effort |
|---|---|
| 1 home gesture | ~1 day |
| 2 notif + control center | ~2 to 3 days |
| 3 Spotlight surface | ~1 day |
| 4 PTR + schema bump | ~1 to 2 days |
| polish | ~1 day |
| **v1 total** | **~6 to 8 days** |

---

## 13. Browser and platform considerations

1. **Mobile Safari back-swipe.** v1 does not implement left-edge back.
   That sidesteps the Safari conflict entirely until v2.
2. **Touch-action.** `phone-screen` already declares `touch-action:
   pan-y`. We tighten to `touch-action: none` inside reserved edge
   zones so the browser does not also try to scroll while we drag.
3. **Desktop pointer (mouse).** Supported for demo purposes only.
   Mouse drag fires the same gestures, slower and without velocity
   feel. Acceptable.
4. **`<600px` is the real device case.** Tune thresholds against the
   393x852 phone viewport, not the centered desktop frame.
5. **iOS overscroll on PTR.** Need to suppress the native rubber-band
   when our PTR claims the gesture. `overscroll-behavior: contain`
   on the scroll container handles this; PTR adds `none` when
   pulling.

---

## 14. Animation choreography

Three principles, unchanged from the previous draft:

- **One axis at a time.** Notification, control center, Spotlight,
  and PTR all move on Y only.
- **Match the existing morph spring** (stiffness 280, damping 28).
- **Backdrop dims and scales** when a panel opens (scale 0.96,
  opacity 0.7). PTR does not dim the background (it is in-app).

```
    closed                  peeking                 open
  ┌───────┐               ┌───────┐               ┌───────┐
  │       │               │ ──────│               │ ╔═══╗ │
  │  OS   │   drag down   │  ░░░  │   release     │ ║ N ║ │
  │ shell │   ────────►   │  OS   │   ────────►   │ ╚═══╝ │
  │       │               │ scale │   pass thr    │ scrim │
  │       │               │ down  │               │       │
  └───────┘               └───────┘               └───────┘
       background continues to scale as panel travel grows
```

---

## 15. Conflict matrix (v1)

| Started... | ...while this is happening | Winner |
|---|---|---|
| Any | A panel is open | Touch goes to the panel only |
| Bottom-edge swipe up | App in foreground | Home gesture |
| Bottom-edge swipe up | Home screen | Home gesture (no-op) |
| Top-left swipe down | App or home in foreground | Notifications |
| Top-right swipe down | App or home in foreground | Control center |
| Top-half home-screen drag down | Home in foreground | Spotlight |
| Top-half home-screen drag down | App in foreground | Ignored (releases to page) |
| In-content vertical drag at scrollTop=0 | App opted in to PTR | Pull-to-refresh |
| In-content vertical drag at scrollTop=0 | App did NOT opt in | Page scroll (no-op) |
| In-content vertical drag at scrollTop>0 | Any app | Page scroll |
| Tap on AppIcon | Idle | openApp |
| Tap on AppIcon | A panel open | Closes the panel first, no openApp |

(Long-press, left-edge back, swipe-up-and-hold, and any multi-touch
gestures intentionally absent.)

---

## 16. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Gestures break native scrolling in apps | High | Off-axis cancel rule (§6) + tight `touch-action` regions |
| PTR clashes with normal scroll inertia | Medium | Only claim PTR at `scrollTop === 0` and only if app opted in. Cancel cleanly on horizontal movement. |
| Spotlight zone shadows tap targets on home | Medium | Only activate after off-axis check + min 12 px drag; pure taps reach AppIcon as usual |
| Edge zones too thin on small screens | Medium | Tune per breakpoint; desktop frame can have slightly wider zones |
| Spring physics feel sluggish vs. real iOS | Medium | Match Apple's published curves; A/B against a side-by-side iPhone |
| `XOApp.gesture` schema bump breaks existing app.ts files | Low | The field is optional; existing files are untouched |
| Multi-touch / pinch interferes with single-touch tracking | Low (v1 ignores non-primary pointers) | Explicitly ignore pointer events with `isPrimary === false` |
| Reduced-motion users get no panels | Low | Panels snap instantly without spring; still functional |
| iframe-kind app PTR cannot read scrollTop of cross-origin frame | Medium | `XOAppShellIframe` provides PTR around the iframe (outer scroll), not inside it. Documented constraint. |

---

## 17. Out of scope for v1

- App switcher (v2)
- Left-edge back gesture (v2)
- Long-press app icons / jiggle / context sheet (v2)
- Haptics (v2)
- Quick app switch (v2)
- Real notification feed (panel ships as a surface only)
- Real Spotlight search (input field + static list only in v1)
- Wallpaper / theme switching
- Multi-finger / pinch gestures
- Reachability mode
- Routing gestures to native OS (e.g. share sheet)

---

## 18. Decisions to make before Phase 1

Trimmed from the previous draft (haptics, switcher card style, and
bottom-edge ambiguity all moved with the v2 gestures).

1. **Spotlight zone definition: top half of home grid, or anywhere
   in the grid?** Default: top half. Keeps the bottom of the grid
   available for normal taps without accidentally triggering
   Spotlight.
2. **PTR canonical example app: Docs or Demo?** Default: Docs (will
   eventually pull live MDX; PTR fits semantically).
3. **Spotlight closes on tap-outside?** Default: yes, scrim closes
   it. Matches iOS.
4. **`gesture.pullToRefresh` shape: boolean shorthand, or always the
   object form?** Default: always the object form for forward
   compatibility (so we can add `cooldown`, `minPullDistance`, etc.
   later).
5. **Spotlight focuses the input on open?** Default: yes on desktop,
   no on touch (focusing forces the on-screen keyboard up; we want
   the user to *see* the surface first).

---

## 19. Where this plugs into existing plans

- **Character plan.** The character avatar lives in the same overlay
  layer as the gesture panels (z-20 vs. z-30-ish). The character
  retracts when any panel opens (`CHARACTER_PLAN.md` §4, ambient
  mode).
- **Lifecycle / animation doc.** The gesture system shares the spring
  physics conventions from `LIFECYCLE.md` §3 ("coordinate with the
  icon morph"). Panels never compete with the layoutId morph because
  the coordinator blocks new gestures during PhoneContext route
  transitions for ~280 ms.
- **App architecture.** `XOApp.gesture` is the same pattern that
  `LIFECYCLE.md` §4 proposes for `shell` theming: a small,
  declarative seam on the per-route `app/<route>/app.ts` file, with
  defaults derived from `kind`. Each new opt-in surface (gesture,
  theme, future ones like notifications or widgets) extends
  `XOAppBase` the same way without touching anything else.
- **More-apps doc** (still to be written). PTR defaults per `kind`
  (native, iframe, api, mdx) are documented here; the more-apps doc
  will reference these defaults when explaining how to add each app
  kind.
