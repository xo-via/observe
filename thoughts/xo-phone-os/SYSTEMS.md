# Modes, Gestures, Lockscreen, together

Three orthogonal-ish systems sit between the user and the OS shell:

| System | What it owns | Provider | Boundary |
|---|---|---|---|
| **Mode** | Which apps + dock the home screen shows | `ModeProvider` | Reads everywhere; only Settings + Control Center + the banner write |
| **Lock** | Whether the OS is reachable at all | `LockProvider` | Reads in shell + gesture surface; writes via Settings, side button, unlock gesture |
| **Gesture** | Pointer recognition, panel state, drag motion values | `GestureProvider` | Driven by `GestureSurface`; reads lock + mode |

This page is about the **seams between them**: how each one
changes the others, what wins when they conflict, and what your
mental model should be when adding new behavior.

Cheat sheets: `MODES.md`, `GESTURES.md`, `LOCKSCREEN.md`. Designs:
`MODES_PLAN.md`, `GESTURE_PLAN.md`, `LOCKSCREEN_PLAN.md`.

---

## The provider hierarchy

```
   <ModeProvider>            outermost: app inventory + dock per mode
     │
     └─ <LockProvider>       gates entry to the OS shell
         │
         └─ <PhoneProvider>  active route + back stack
             │
             └─ <GestureProvider>   panel state + pointer motion values
                 │
                 └─ <DeviceFrame>   chrome + screen + gesture orchestrator
```

Why this order:

- **Mode outermost.** Mode is the broadest reframing; lock,
  character, and gestures can all read mode if they need to.
- **Lock above Phone + Gesture.** GestureSurface needs to know if
  the device is locked so the bottom-edge swipe routes to unlock
  instead of home.
- **Phone above Gesture.** Gesture needs the current route to
  decide if Spotlight is allowed (home-only) and to navigate.
- **Gesture innermost.** Gesture writes motion values; the panels
  + lockscreen + home crossfades all read those values directly,
  so the producer sits closest to the consumers.

A new system slots in based on what it needs to read. A Character
provider would sit between Lock and Phone (reads mode + lock,
ignored by gestures). A Theme provider would sit outside everyone
because it influences pure visual style.

---

## Who reads from whom

```
                  ┌──────────┐
                  │   Mode   │ ──── reads ──── (nothing internal)
                  └──────────┘
                       ▲
                       │  reads
                       │
                  ┌──────────┐
                  │   Lock   │ ──── reads ──── (nothing internal)
                  └──────────┘
                       ▲
                       │  reads
                       │
                  ┌──────────┐
                  │  Phone   │ ──── reads ──── (nothing internal)
                  └──────────┘
                       ▲
                       │  reads
                       │
                  ┌──────────┐
                  │ Gesture  │ ──── reads Mode + Lock + Phone
                  └──────────┘
                       │
                       ▼  writes
                  ┌──────────────────────────────────────────────┐
                  │ Mode (via Control Center panel)              │
                  │ Lock (via bottom-edge swipe when locked)     │
                  │ Phone (via openApp / goHome)                 │
                  │ Gesture itself (openPanel, motion values)    │
                  └──────────────────────────────────────────────┘
```

Mode + Lock are independent of each other and don't read each
other. Gesture reads all three but only writes through their
intent surfaces (`setMode`, `unlock`, `goHome`, `openApp`).

---

## What each system changes in the OS shell

### Mode changes

When `setMode(newId)` fires:

1. `ModeProvider.currentMode` flips immediately (optimistic)
2. `ModeProvider.transitioning = true` for ~600 ms
3. `HomeScreen` re-renders: AnimatePresence sees new key
   `grid-{newId}`, runs the crossfade (250 ms exit + 350 ms enter
   for the grid + dock)
4. `Dock` re-renders with new pinned apps
5. `SpotlightPanel` (if mounted) re-derives its filtered list
6. `ModeBanner` appears (if `newId !== "default"`) or disappears
7. `ModeMismatchBanner` in any open `XOAppShell` re-evaluates
8. localStorage write fires (best-effort)
9. Other tabs catch up via `storage` event

The lockscreen, the gesture state, and the active route are
**unaffected**. The icon set changes; nothing else moves.

### Lock changes

When `lock()` or `unlock()` fires:

```
   lock()                          unlock()
   ────────                        ────────
   LockProvider.locked = true      LockProvider.locked = false
   LockProvider.unlocking = false  LockProvider.unlocking = true (~900ms)
       │                                │
       ▼                                ▼
   DeviceFrame:                    DeviceFrame:
     mounts <LockScreen/>            unmounts <LockScreen/> via exit anim
     hides HomeIndicator             remounts HomeIndicator + panels
     hides all panels                full gesture vocabulary returns
       │                                │
       ▼                                ▼
   GestureSurface:                 GestureSurface:
     suppresses all zones            normal arbitration resumes
     except bottom-edge
     (which routes to unlock)
       │                                │
       ▼                                ▼
   Side button:                    Side button:
     aria-label = "Device locked"    aria-label = "Lock device"
     onClick: no-op                  onClick: lock()
       │                                │
       ▼                                ▼
   Other tabs: storage event syncs to same state
```

Mode, current route, back stack, and any open panels are kept
where they were. When the device unlocks, the user lands back in
whatever mode + route + app they were in.

### Gesture changes

Gestures don't change much on their own; they trigger the other
systems. The two exceptions:

- `GestureContext.openPanel`: which of the three panels is open
  (or null). Changes drive panel slide animations + scrim
  pointer-events.
- `GestureContext.gestureLocked`: lockout window for ~280 ms
  during route transitions, ~600 ms during mode transitions.
  Stops a stacked gesture from fighting an animation.

---

## How systems read each other at key moments

```
   user taps an app icon
   │
   ▼
   GestureSurface (capture phase pointerdown)
   │    reads Lock.locked → false (not locked, proceed)
   │    reads Phone.current → "/" (we're on home)
   │    reads Gesture.openPanel → null (no panel open)
   │    zone resolves → "spotlight" (top half of grid)
   │    waits for movement before claiming
   │  (no movement, tap is fast)
   │
   ├─ AppIcon's onClick fires:
   │    reads Phone.openApp + router.push
   │    layoutId morph begins
   │
   ▼
   PhoneContext updates current → "/coworker"
   ▼
   DeviceFrame re-renders → <AppView/> mounts
```

```
   user swipes down from top-right while in landing mode
   │
   ▼
   GestureSurface
   │    reads Lock.locked → false
   │    reads Gesture.openPanel → null
   │    zone → "top-right"
   │    claims immediately, preventDefault
   │
   ▼
   tracks pointer, writes controlT motion value 0 → 1
   ▼
   pointerup, commit threshold met
   ▼
   Gesture.openPanel = "control"
   ControlCenterPanel slides in
   │
   ├─ User taps "Default" pill in the Mode segmented control
   │  │
   │  ▼
   │  ModeContext.setMode("default") fires
   │  ▼
   │  ModeContext.currentMode = "default" (immediate)
   │  ModeContext.transitioning = true (~600 ms)
   │  HomeScreen crossfades grid + dock BEHIND the open panel
   │
   ├─ User taps scrim
   │  ▼
   │  Gesture.openPanel = null
   │  ControlCenterPanel slides out
   │
   ▼
   Panel closed; user sees the new mode's icons. Banner gone
   (default mode does not show one).
```

```
   user swipes up from bottom while locked
   │
   ▼
   GestureSurface
   │    reads Lock.locked → true
   │    only zone allowed: "bottom"
   │    claims, tracks
   │
   ▼
   pointerup, commit
   ▼
   Lock.unlock()
   ▼
   Lock.locked = false
   Lock.unlocking = true
   ▼
   AnimatePresence in DeviceFrame triggers LockScreen exit
   (~850 ms slow slide up)
   ▼
   GestureSurface zone vocabulary returns to full
   PhoneContext.current is unchanged (was /)
   ModeContext.currentMode is unchanged
   ▼
   User sees: home grid in whatever mode they last had
```

---

## Conflict matrix

When two systems want to do something at the same time, who wins?

| Situation | Resolution |
|---|---|
| Locked + mode change fires (e.g. cross-tab) | Mode change applies silently in the background. User sees the new mode after unlock. No lockscreen animation runs for a mode change. |
| Mid-panel-drag + mode change fires (cross-tab) | Panel drag is cancelled (release pointer, snap closed). Then the mode crossfade runs. |
| Mid-route-morph + new gesture starts | `gestureLocked` is true for 280 ms; the new gesture is rejected at `pointerdown` (early return in arbitration). |
| Mode transition in flight (600 ms) + user starts a gesture | Same: `gestureLocked` rejects until the transition settles. |
| Mode change while inside an app not in the new mode's appPaths | App stays open. `ModeMismatchBanner` appears above the header offering to switch to a mode that includes the app. Soft promo, never a forced redirect. |
| Lock + Settings open + user toggles "Stay unlocked between visits" | Setting flips, but the device stays locked (you have to swipe up). The setting affects FUTURE visits only. |
| User taps side-button to lock + a panel is open | Lock happens; the panel disappears with the rest of the OS shell (everything below the lockscreen is hidden by the lockscreen overlay). On unlock the panel does not re-open. |
| Mode change + active app in the new mode + nothing else | Smoothest case. Active app stays open. User sees the home crossfade only when they go home. |
| Deep link to `/coworker?mode=landing` | URL takes precedence in mode resolution. Device auto-unlocks (deep link). User lands in landing mode, inside Coworker. The banner from `ModeMismatchBanner` does NOT fire because Coworker is in landing's appPaths. |

---

## What persists, what doesn't

| State | Persisted? | Storage key |
|---|---|---|
| `LockContext.locked` (current) | Yes (within sticky window) | `xo-lock-v1` |
| `LockContext.sticky` (preference) | Yes | `xo-lock-v1` |
| `ModeContext.currentMode` | Yes | `xo-mode-v1` (v2 schema) |
| `GestureContext.openPanel` | No (in-memory only) | n/a |
| `GestureContext.gestureLocked` | No | n/a |
| Pointer motion values (notifT, controlT, etc.) | No | n/a |
| `PhoneContext.current` | Implicit via URL | n/a |
| `PhoneContext.backStack` | No | n/a |

All persisted state syncs across tabs via the `storage` event. The
non-persisted state is per-tab.

---

## Shared primitives

These are the cross-system DRY surfaces. Touch them, you touch
all three systems:

| Primitive | Where | Affects |
|---|---|---|
| `PANEL_SPRING` (stiffness 280, damping 28) | `lib/gestures/constants.ts` | Panel slide animations, icon-to-app morph, would-be mode crossfade default if revisited |
| Status bar + Dynamic Island z-index (40 / 50) | `LIFECYCLE.md` §5 + `components/DeviceFrame.tsx` | Lockscreen at z-30 sits below them; modes don't touch them yet (theming is deferred) |
| Reduced motion check (`useReducedMotion`) | Framer Motion built-in | LockScreen exit/enter, HomeScreen mode crossfade, panel scrim opacity |
| `localStorage` write pattern | Each context | Versioned schema, cross-tab `storage` event, best-effort writes |
| Glass styling | `components/gestures/glass.tsx` | All three slide-down panels |

If you change `PANEL_SPRING`, the icon morph + every panel + the
default mode crossfade all shift together. That's intentional;
shared physics keeps the OS feeling coherent.

---

## Adding a fourth system

If you want to add a fifth context (Character, Themes, Notifications
real content, etc.), the questions to answer in order:

1. **Where does it sit in the provider tree?** Outside the systems
   it reads, inside the systems it writes to. Character reads
   Mode + Lock → sits between LockProvider and PhoneProvider.
2. **Does it gate anything?** Lock gates the OS shell. Mode gates
   the visible app set. If your system gates a surface, the shell
   needs an early-return branch (like Lock has).
3. **Does it suppress gestures?** Lock suppresses all but
   bottom-edge. If your system needs to disable gestures during
   some state (e.g. tour overlay), it adds a check in
   `GestureSurface.onPointerDown`.
4. **Does it require persistence?** Use the existing
   `xo-<system>-v1` localStorage versioned-key pattern.
5. **Does it react to other systems?** Read them via their hooks
   (`useMode`, `useLock`); never reach into their state directly.

Any new system that follows these five conventions slots in
cleanly without rewriting the existing three.

---

## File map at the system seams

| File | Reads | Writes | Why |
|---|---|---|---|
| `app/providers.tsx` | none | mounts all four providers in correct order | The single source-of-truth for provider hierarchy |
| `components/DeviceFrame.tsx` | Lock, Phone, Mode (indirectly via HomeScreen) | Lock (via the side button) | The shell composer; conditional rendering driven by lock |
| `components/gestures/GestureSurface.tsx` | Lock, Phone, Mode (none currently, but available), Gesture | Lock (unlock), Phone (goHome / openApp), Gesture (openPanel, motion values) | The pointer arbiter |
| `components/HomeScreen.tsx` | Mode | none | Pure consumer; crossfades when mode changes |
| `components/gestures/ControlCenterPanel.tsx` | Mode (modes + currentMode), Gesture | Mode (setMode) | The mode picker lives here |
| `components/gestures/SpotlightPanel.tsx` | Mode (modeApps), Gesture, Phone | Gesture (closeAll), Phone (openApp) | Search is mode-filtered |
| `components/XOAppShell.tsx` (via `ModeMismatchBanner`) | Mode | Mode (setMode, when user taps banner) | In-app mode banner for missing apps |

---

## Common cross-system tasks

| I want to... | Touch these |
|---|---|
| Make a new gesture also unlock | Add the gesture in `GestureSurface`; route its commit to `LockContext.unlock()` when `lock.locked` is true |
| Suppress all gestures during onboarding | Add an `if (onboarding.active) return` early in `GestureSurface.onPointerDown` |
| Lock when entering a specific mode | In `ModeContext.setMode`, if newId === "secured" call `LockContext.lock()` after the transition lockout window |
| Make the lockscreen show the current mode | `LockScreen` imports `useMode`, renders `mode.label` somewhere visible |
| Hide a panel when in a specific mode | Wrap the panel mount in `DeviceFrame` with a `currentMode !== "..."` guard |
| Re-lock on mode change | In `ModeContext.setMode`, call `LockContext.lock()` right before the state flip |
| Share a spring across the three systems | Already done via `PANEL_SPRING`; touch the constant, everyone follows |
