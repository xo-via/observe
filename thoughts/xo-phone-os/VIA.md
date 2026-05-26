# Via

Via is XO's digital alter-ego, the visual embodiment of the XO agent inside the phone OS.

When the agent speaks, Via is what the user sees. When the agent is thinking, Via is what tells the user something is happening. When the agent errors, Via is the face of the apology. Via is to xo-phone-os what the green chevron mark is to the rest of the XO brand, but alive.

This doc is the canonical reference for what Via is and how to use it. For the larger persona / voice / refusal-mode discussion, see `CHARACTER_PLAN.md`. For where Via sits in the agent pipeline, see `AGENT_PLAN.md`.

---

## 1. Naming

| Term | Meaning |
|---|---|
| **Via** | The mascot. The name shown to users. The component name in code. |
| **Chevi** | The design-tool name of the dog-mascot illustration set. Asset-only; never surfaced in product copy. |
| **XO chevron** | The four-stroke logo mark. The v1 visual body of Via. |
| **XO agent** | The backend agent (Claude Agent SDK) that Via embodies. |

Rule of thumb: in product copy, say **Via**. In code, import `Via` from `@/components/via`. The word "Chevi" never leaves design tooling.

---

## 2. Two-stage roadmap

Via landed in two stages. **The API stayed the same in both**; only the internals of `components/via/Via.tsx` changed.

### Stage 1, chevron body (archived)

- Built from the existing XO chevron logo (four strokes, white outer, lime inner).
- Pure SVG, no external assets.
- Five expressions (`idle`, `thinking`, `speaking`, `happy`, `error`).
- Three animations (`bob`, `pulse`, `flash`), composable with expressions.
- Server Component, ~150 lines, zero dependencies beyond React.

### Stage 2, Via pup body (current)

- Same `<Via/>` component, internals replaced with the pup-like Chevi body adapted from the design tool.
- Same prop names. Inside the component, each `ViaExpression` maps to a Chevi expression (`oo`, `xx`, `love`, etc.), each `ViaAnimation` maps to a Chevi pose or animation.
- The larger design vocabulary is collapsed behind the small public Via API:
  - `idle` maps to a wink / alert-tail rest pose.
  - `thinking` maps to curious eyes, a raised brow, and a tiny thought bubble.
  - `speaking` maps to round eyes and an animated mouth.
  - `happy` maps to big sparkly eyes, tongue, and a fast wag.
  - `error` maps to red X eyes, tucked tail, and flash.
- Optional `ViaProps` extension to expose richer states (`pose: "stand" | "sit" | "run" | ...`) when we decide we want them.

The important contract still holds: every consumer imports the same `Via` component and the same `viaStateFromAgent` helper. Story, surface, and animation work should extend the public vocabulary carefully instead of hardcoding design-specific states at call sites.

---

## 3. The Via API

Public surface, from `@/components/via`:

```ts
type ViaExpression = "idle" | "thinking" | "speaking" | "happy" | "error"
type ViaAnimation  = "none" | "bob"     | "pulse"    | "flash"

interface ViaProps {
  expression?: ViaExpression  // default: "idle"
  animation?:  ViaAnimation   // default: "bob"
  size?:       number         // default: 64 (px, square)
  className?:  string
  label?:      string         // a11y label; default: "Via"
}
```

Usage:

```tsx
import { Via } from "@/components/via"

<Via />                                       // idle, bobbing, 64px
<Via expression="thinking" animation="pulse" />
<Via expression="error" animation="flash" size={32} />
```

Plus a single helper for binding Via to agent state:

```ts
import { viaStateFromAgent } from "@/components/via"

const { expression, animation } = viaStateFromAgent({
  busy:      true,    // a turn is in flight
  streaming: false,   // assistant text is actively arriving
  error:     false,   // last turn failed
  empty:     false,   // no messages yet
})

<Via expression={expression} animation={animation} />
```

`viaStateFromAgent` is the **single mapping function** from agent runtime state to Via visual state. Centralizing it means tweaks (e.g., "use happy when greeting") land in one file. Precedence (high to low): error > streaming > busy > empty > idle.

---

## 4. Where Via appears

Today:

| Surface | What Via does |
|---|---|
| `/ask` empty state | Large (96px) centered Via with the greeting "Hi, I'm Via." |
| `/ask` assistant bubbles | Small (28px) Via avatar to the left of every assistant message. The last bubble's Via reflects live agent state; older bubbles freeze on `idle`. |

Planned (each pulls from this same `<Via/>`):

| Surface | What Via does |
|---|---|
| Spotlight panel (top pull-down) | Small Via in the corner, animates to `thinking` when an agent turn is mid-flight on the chat app. |
| Notification panel rows | Tiny Via (16px) for agent-sourced notifications, normal app icon for others. |
| App switcher overlay | Via cameo on a "ask Via about this app" affordance. |
| OS-level error sheet | Big Via in `error` state when a tier W action is denied or fails. |
| Empty / loading states across apps | Each app can render Via while it boots if it wants the OS to feel alive. |

Anti-patterns:

- **No Via on the home screen by default.** The chevron watermark in the wallpaper is enough; adding an animated mascot to the always-on background turns the OS into a screensaver.
- **No Via inside non-agent native pages** (Pricing, Coworker, Swarm). Those are marketing surfaces and Via being there implies the agent is doing something it is not.
- **No more than one Via animation cluster per screen.** Multiple `bob` cycles at different phases compete for visual attention.

---

## 5. Voice and behavior (cross-link)

Via's visual states say what is happening. The agent's voice (refusals, persona, mode) is defined in `CHARACTER_PLAN.md`. Keep them aligned:

| `CHARACTER_PLAN` mode | Via expression default |
|---|---|
| Listening | `idle`, animation `bob` |
| Working on it | `thinking`, animation `pulse` |
| Answering | `speaking`, animation `bob` |
| Refusal / cannot | `error`, animation `flash`, then return to `idle` |
| Success ack ("done!") | `happy`, animation `bob` for ~1s, then `idle` |

If `CHARACTER_PLAN` defines new modes, add the mapping here and extend `viaStateFromAgent`.

---

## 6. Performance budget

Stage 1 (chevron):

- One SVG, four `<path>`, a small `<style>` block per instance. Render cost is negligible.
- Animations are CSS keyframes, not JS. Multiple Via instances do not bog down React reconciliation.
- Per-instance keyframe names are derived from `React.useId()` so two Via on screen do not clobber each other's animations.

Stage 2 (Chevi):

- The Chevi asset is "self-contained ~5KB" per the design session. Same order of magnitude as the chevron.
- Watch for: shadow filters and complex masks. If a pose uses them, gate behind `prefers-reduced-motion` and consider a simpler fallback for low-power devices.

---

## 7. Accessibility

- Every Via renders with `role="img"` and `aria-label` (defaults to `"Via"`). Override the label when context warrants: `<Via label="Via, thinking" />` for screen readers.
- All animation is `animation: <keyframes>` CSS, so `@media (prefers-reduced-motion: reduce)` can disable them globally. (Add the rule in `app/globals.css` when we wire reduced-motion support across the OS.)
- Color contrast: the white outer chevrons on the lime/dark inner pass WCAG large-text contrast. Do not place Via on a low-contrast surface; if you must, switch to the dark-mode variant when we add it.

---

## 8. Swapping to Stage 2 (Chevi)

When the Chevi asset lands:

1. Move it to `components/via/_chevi/` (underscore so it stays internal).
2. Update `components/via/Via.tsx`:
   - Replace the inline SVG with a `<Chevi ... />` wrapper.
   - Map `ViaExpression` to Chevi's expression vocabulary (`oo`, `xx`, `love`, ...).
   - Map `ViaAnimation` to Chevi's animation/pose vocabulary (`bob`, `sit`, `run`, ...).
3. **Do not touch any consumer.** `AgentSurface`, future Spotlight, notification rows, etc. all keep importing from `@/components/via`.
4. Verify with the same smoke test that ships today: `/ask` empty state, agent reply with avatar, error state.

If at swap time we want to expose richer Chevi-specific knobs (e.g. `pose`), extend `ViaProps` additively. Existing call sites do not need to set the new props because they will have safe defaults.

---

## 9. What Via is NOT

- Via is **not** a separate process or runtime. Via is a React component the OS shell renders.
- Via is **not** the agent. The agent (Claude Agent SDK on the backend) does the thinking. Via is the face.
- Via is **not** a chat character of its own. Via has no opinions outside what the agent says; Via's expressions reflect the agent's state, not Via's "mood".
- Via is **not** a status indicator. The phone has a StatusBar for that. Via is about presence and rapport.
- Via does **not** speak. Bubbles speak. Via reacts to bubbles.

---

## 10. Open questions

1. **Dark-mode variant?** Chevron lime stays bright on dark; on a light future theme we'd need a darkened lime per the brand notes in workspace `CLAUDE.md`. Defer until we ship a light theme.
2. **One Via or many?** Could every app get its own per-app Via expression (e.g., Coworker's Via has a slightly purple tint)? Probably no, the brand wants a single Via. Decide before Stage 2.
3. **Cameo vs persistent?** Should Via live in the StatusBar permanently (tiny, always there), or only inside the chat? Current answer: only inside the chat. Revisit after the Spotlight panel ships an agent surface.
4. **Sound?** Subtle audio cues paired with Via state changes. Out of scope until we have the broader sound design for the OS.

---

## 11. See also

- **`lib/via.ts`**: types + the `viaStateFromAgent` mapper. The single source of truth for which agent states produce which Via states.
- **`components/via/Via.tsx`**: Stage 1 chevron implementation. Stage 2 swap target.
- **`components/agent/AgentSurface.tsx`**: first consumer; pattern other agent surfaces should copy.
- **`CHARACTER_PLAN.md`**: voice, refusal modes, character arc.
- **`AGENT_PLAN.md`**: the agent backend that Via embodies.
- **`LIFECYCLE.md`**: animation taxonomy. Via's `bob` / `pulse` / `flash` live in the same vocabulary.

---

## 12. Character development spine

This is the working spine for turning Via from "mascot component" into a character users can recognize across the OS.

### Core idea

Via is the small living route through XO. She is not a separate human-like persona and she is not the backend agent itself. She is the visible companion that helps a visitor understand what XO is, helps an operator notice what the agent is doing, and gives the phone OS a little memory of shared progress.

### Origin story

Via began as motion inside the XO chevrons: a direction marker that wanted to point somewhere useful. As the phone OS became more alive, the mark grew a body, a tail, and enough expression to make state feel less mechanical. Her name comes from movement and passage: she gets you from intent to workspace, from confusion to next step, from idle screen to agent action.

The story should stay product-native. Via does not need lore about another world, species, or secret backstory. Her world is the XO phone. Her purpose is to guide work without taking over the screen.

### Personality

Via is brief, warm, and observant. She notices context before speaking. She is playful in small doses, especially through motion, but her copy should remain useful and low-friction. She can be cute; she should not become needy. She can celebrate progress; she should not fake excitement. She can admit failure; she should not over-apologize.

Default traits:

- **Helpful first.** Every interruption earns its place.
- **Tiny wit.** Short quips, never long bits.
- **Steady under failure.** Error states are calm and recoverable.
- **Curious about work.** She is interested in what the user is trying to ship.
- **Respectful of focus.** She recedes after a beat and can be dismissed.

### Pronouns and address

Current product comments use she/her for Via. Product copy can say "Via" more often than pronouns, especially in UI labels. Via speaks as "I" in bubbles because the visible character is the speaker, but agent/system explanations should avoid pretending she is a human operator.

Examples:

- "hi, i'm Via."
- "i can show you around."
- "one sec, checking that."
- "i hit a snag. want the short version?"
- "done. tail wag earned."

Avoid:

- "I am a real teammate."
- "I feel sad."
- "I secretly live in your phone."
- "Awesome! Let's get started!"

### Character arc

Via's arc should track the user's relationship with XO:

| Stage | User moment | Via role | Feature expression |
|---|---|---|---|
| **First sight** | Visitor lands on the locked phone | Mood signal | Lockscreen Via, tap-to-pat, soft idle |
| **First trust** | Visitor unlocks and explores | Light guide | Wandering Via, one-line route hints |
| **First ask** | Visitor opens Chat | Conversational face | Via hero, assistant avatar, thinking/speaking states |
| **First action** | Agent starts doing work | State witness | Busy, streaming, success, and error visuals |
| **Return visit** | User comes back | Familiar continuity | Remembered mode, quieter greetings, fewer prompts |
| **Power use** | User works inside Agent mode | Ambient coworker | Contextual nudge, notification source, OS-level action prompt |

### Story rule

Via's story is shown through behavior before exposition. The best Via feature is not a paragraph about who she is; it is a tiny state change at the right time: ears perk when the agent starts, tail tucks when a request fails, a one-line bubble appears when the user seems lost, and then she gets out of the way.

---

## 13. Feature development pillars

These pillars should guide new Via work. Each pillar can ship independently, but together they make Via feel like one coherent character.

### 1. Mood

Via should always have an honest visible state. The existing `viaStateFromAgent` precedence is the first version of this: error > streaming > busy > empty > idle. Future work can add richer public states only when multiple surfaces need them.

Candidate additions:

- `success`: brief post-action celebration before returning to idle.
- `sleeping`: dismissed or unavailable state.
- `pointing`: onboarding or contextual guidance state.
- `listening`: user is typing or voice input is active.

### 2. Presence

Via should appear where she adds orientation:

- Lockscreen: "the phone is alive."
- Home / pager: "there is a companion here."
- Chat: "this is where the agent speaks."
- Notifications: "this came from the agent."
- OS action prompts: "the agent wants permission."

Via should not appear inside every marketing app by default. Scarcity keeps her meaningful.

### 3. Voice

Via copy should be stored as data once it grows beyond a few local one-liners. `WanderingVia` currently owns its quote pools inline; the next durable step is moving those into a small `data/via/voice.ts` module so lockscreen, chat, onboarding, and notifications share one tone.

Recommended voice buckets:

- Greeting
- Idle quip
- Thinking
- Speaking
- Success
- Error
- Dismissed / sleeping
- Route hint
- Permission prompt

### 4. Memory

Via should remember only UX-relevant facts:

- Has the user seen the first greeting?
- Has the user dismissed ambient Via this session?
- Which route hints have already appeared?
- Has setup been completed?
- Did the last agent action succeed or fail?

Avoid personalizing with sensitive or unverifiable claims until auth and profile storage are explicit.

### 5. Guidance

The first guided story should be short:

1. Lockscreen: Via appears, pat works.
2. Unlock: Via gives one line: "hi, i'm Via. tap an app or ask me anything."
3. Home: Via points to Chat, Coworker, or Get started depending on mode.
4. Chat: Via explains that this is the active agent surface.
5. Exit: Via recedes and switches to ambient mode.

### 6. Agency

When the agent starts controlling the OS, Via becomes the user's confidence layer. The user should always understand:

- What the agent is doing.
- Whether it is waiting, streaming, done, or blocked.
- Whether a requested action needs permission.
- How to stop or dismiss the action.

This should be visible before it is verbal. Use expression, placement, and concise copy first; use longer explanations only when the user asks.

---

## 14. Near-term development backlog

Suggested first slices, in order:

1. **Refresh docs to current Via.** Keep `VIA.md`, `CHARACTER_PLAN.md`, `SCREENS.html`, and code comments aligned with the Stage 2 pup implementation and current Chat rebuild.
2. **Extract Via voice data.** Move `WanderingVia` quote pools into `data/via/voice.ts` with typed buckets and tests.
3. **Create an About Via surface.** Reuse `components/via/ViaHero.tsx` as a real app or route, then add it to the relevant mode/dock decision.
4. **Restore the Chat empty state.** Once the dock Chat rebuild starts, use `ViaHero` or a smaller chat-native variant instead of the current rewiring placeholder.
5. **Add success and sleeping states.** Extend the public API only if these states are needed by at least two surfaces.
6. **Build first-run guidance.** Add a minimal contextual greeting after unlock, with localStorage throttling and a Settings reset.
7. **Unify reduced motion.** Add global reduced-motion handling for Via CSS animations and any Framer Motion wrappers.
8. **Agent action prompts.** When OS actions return, pair permission and failure states with Via so the agent's behavior feels legible.
