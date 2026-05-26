# xo-phone-os character plan

Plan for making "XO" a character (a la Claude Code's persona, or
Duolingo's Duo) that lives inside the phone OS. The character greets
first-time visitors, runs a guided tour of the home screen and the
apps, sticks around as an ambient helper, and graduates into a real
conversational assistant backed by xo-swarm-api.

This is a planning doc, not implementation. Read end-to-end. Where
the plan asks for a decision, the heading is marked `(decide)`.

---

## 1. Why a character

Today the phone OS is a brand artifact. A user lands on `phone.xo.builders`,
sees an iPhone-style home screen full of apps, and has to figure out
what XO is by tapping around. There is no guided narrative.

A character does three jobs at once:

1. **Onboarding.** A new visitor needs to learn that XO is "workspaces
   for AI agents," what Coworker vs Swarm means, and how to take a
   first action. A character explains this in a way a marketing page
   cannot: it points, it waits, it reacts.
2. **Personality vehicle.** XO sells AI agents. The most concrete
   demo of "we know how to make a useful agent" is to be one. A
   character is the product, walking around the product.
3. **Conversion surface.** Eventually the character becomes an
   AI-backed chat: "Ask XO" stops being a stub app and becomes the
   main entry point for product questions, pricing questions, demos,
   sign-up flows.

Claude Code is the reference model: brief, decisive, gets out of the
way, never narrates obvious things. Not Clippy. Not Bonzi.

---

## 2. Character design `(decide)`

Three candidate designs. Pick one before Phase 0 starts.

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A. Chevron creature** | The lime-green chevron pair from the XO mark gets eyes and a mouth. Two-chevron face, expressions through chevron deformation. | Preserves brand mark, instantly XO. Animation is geometric, cheap to render in SVG. | Limited expressiveness; eyes on a chevron can read as "logo with face stuck on." |
| **B. Lime sprite / orb** | A small glowing lime-green orb with eyes, hovers around the screen. Like an Apple Spotlight indicator with personality. | Maximum flexibility, easy to animate, can morph shape for emotions. | Less brand-tied; could be any AI assistant. |
| **C. Voice-only** | No avatar. A subtle glowing indicator (the home indicator pill, or a corner pulse) plus speech bubbles. Character lives in the voice and timing. | Zero distraction, can never feel Clippy-ish, accessible by default. | No mascot, harder to make memorable, weaker marketing artifact. |

**Default recommendation: A (chevron creature)** because it does the
brand work *and* the personality work. C is the safe fallback if mascot
risk becomes real.

For any option, target six base states:

- `neutral` (idle, slow blink)
- `talking` (mouth moves while text streams)
- `pointing` (gesture toward an element)
- `thinking` (eyes look up, slight delay before responding)
- `happy` (after a tour step completes, or sign-up)
- `sleeping` (dismissed, will not interrupt)

---

## 3. Voice and personality

Inherits the workspace house rules (`ClaudeWorkspace/CLAUDE.md` §1 to
§3): no em dashes, brief, ask when confused.

Character-specific overrides:

- **First-person.** "I" not "we." The character is one entity.
- **Lowercase greetings.** "hi, i'm xo" not "Hello! I'm XO."
- **One thought per bubble.** Long answers stream into multiple bubbles
  with short pauses, not one wall of text.
- **No fake enthusiasm.** No "Great question!", no exclamation marks
  unless the moment earns one.
- **Knows when to leave.** After a tour step the character recedes.
  Default state is invisible-ish, not pestering.
- **Suggests, does not command.** "want to try Coworker?" not "Now
  click Coworker."

Forbidden words / patterns: "Awesome!", "Let's get started!", "I can
help you with that!", "Of course!", "Happy to help!", any sentence that
starts with "Sure".

---

## 4. Three interaction modes

The same character runs in three modes, switched by context.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ Mode A: Onboarding   (first visit, full tour)               │
  │   ──────────────────────────────────────────────            │
  │   Triggered when localStorage flag missing.                  │
  │   Steps through home, dock, opening an app, back, done.     │
  │   Spotlight overlay + speech bubble + character avatar.     │
  │   Skippable, restartable from Settings.                     │
  └─────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────┐
  │ Mode B: Ambient      (default, post-onboarding)             │
  │   ──────────────────────────────────────────────            │
  │   Small avatar in a corner of the phone screen.             │
  │   Idle animation. Tap to summon a one-line tip.             │
  │   Reacts to *significant* context changes only (first       │
  │   time opening an app, first time hitting a stub page).     │
  │   Throttle: max 1 spontaneous bubble per minute, max 1      │
  │   per route per session.                                    │
  │   Long-press dismisses for the session.                     │
  └─────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────┐
  │ Mode C: Conversation (on demand)                            │
  │   ──────────────────────────────────────────────            │
  │   The existing /ask app becomes the chat surface.           │
  │   Full chat: streamed responses, scrollback, follow-ups.    │
  │   Same character avatar pinned to the top of the chat.      │
  │   Backed by xo-swarm-api in Phase 4.                        │
  │   "Ask XO" is also reachable from the ambient avatar:       │
  │   tap avatar → "ask me anything" → goes to /ask.            │
  └─────────────────────────────────────────────────────────────┘
```

---

## 5. Where the character lives in the React tree

Drops in cleanly on top of the existing Server/Client split.

```
  app/layout.tsx                                  (SERVER)
    └ <Providers>{children}</Providers>

  app/providers.tsx                               ("use client")
    └ <CharacterProvider>          ◀── NEW outer context
        └ <PhoneProvider pageElement={children}>
            └ <DeviceFrame/>
                ├ StatusBar
                ├ HomeScreen | AppView
                ├ HomeIndicator
                └ <XOCharacterLayer/>   ◀── NEW overlay, z above shell
                    ├ <XOCharacter/>    (avatar + idle anim)
                    ├ <SpeechBubble/>   (positioned, optional tail)
                    └ <TourSpotlight/>  (dark overlay w/ a hole)
```

Why outside PhoneProvider: the character should outlive route changes,
should be summonable from anywhere, and reading PhoneContext from the
character (not the other way around) keeps the dependency one-way.

Why inside DeviceFrame: visually the character must respect the device
frame on desktop (sits inside the phone screen, not outside on the
backdrop) and full-bleed on phone viewports.

---

## 6. State model

```
CharacterContextValue
├── visible: boolean                  master flag
├── mode: "onboarding" | "ambient" | "conversation" | "asleep"
├── currentBubble: { text, source, expiresAt } | null
├── tourStep: number                  0..N within current tour
├── seenRoutes: Set<string>           per-session, for hint throttle
├── lastInteractionAt: number         ms timestamp
├── personality: "default"            (decide: future variants)
└── actions
    ├── say(text, opts?)              push a speech bubble
    ├── point(target)                 highlight a DOM element
    ├── startTour(name)               kick off "first-visit" etc.
    ├── nextTourStep()
    ├── skipTour()
    ├── dismissForSession()
    ├── wake()
    └── openChat()                    routes to /ask
```

Persistence: `localStorage.xo-character-v1` stores `{tourCompleted,
dismissedAt, seenRoutes}`. Wipeable from Settings.

---

## 7. New files (planning, do not build yet)

```
context/
  CharacterContext.tsx          state + actions, "use client"

components/character/
  XOCharacterLayer.tsx          z-index host, decides what to render
  XOCharacter.tsx               the SVG avatar w/ Framer Motion states
  SpeechBubble.tsx              text bubble, optional tail pointing at a target
  TourSpotlight.tsx             dark overlay with a cutout around a target
  ChatPanel.tsx                 used by /ask in Mode C (Phase 4)

data/character/
  script.ts                     onboarding script as data (step list)
  personality.ts                voice tokens (greetings, fallbacks, tone marks)
  hints.ts                      per-route ambient hints

lib/character/
  storage.ts                    localStorage read/write, schema versioned
  positioning.ts                given a DOM target, compute bubble + spotlight
  ai.ts                         placeholder for xo-swarm-api wiring (Phase 4)

app/onboarding/page.tsx         (decide) standalone tour route, or in-place overlay

app/ask/page.tsx                upgraded to a full chat (Phase 4)
```

Brand new dir: `components/character/`. Keeps the existing flat
`components/` clean.

---

## 8. Integration with PhoneContext

Two hooks, no other changes to existing files.

1. **Read pathname.** Character watches `usePathname()` directly (it is
   a client component inside `next/navigation`'s tree). When pathname
   changes and the route is in `script.ts`'s "explain this app"
   list, it can chime in.
2. **Read overlay flags.** Future: when `switcherOpen` becomes real,
   the character should retract so it does not overlap.

No PhoneContext API surface changes required. Character is purely a
consumer.

---

## 9. Phased build

Estimates assume one engineer working full-time.

### Phase 0: design pass (0.5 to 1 day)

- Pick a design (Section 2).
- Sketch the 6 emotion states.
- Export as SVG, layered so individual parts (eyes, chevrons, mouth)
  can be animated with Framer Motion `motion.path`.
- Define color tokens (XO lime variants already exist).
- Idle animation loop (slow chevron pulse + blink).

Deliverable: `components/character/XOCharacter.tsx` placeholder with
the static SVG and the 6 state classes.

### Phase 1: ambient character, no logic (1 day)

- `CharacterContext` with `visible`, `mode`, `say()`, `dismissForSession()`
- `XOCharacterLayer` mounted inside `DeviceFrame`
- Sits in bottom-right corner of the screen
- Tap to greet with one canned line, long-press to dismiss
- Survives navigation (because it lives in the layout)
- localStorage persistence for dismissed state

Verification: open `/`, see XO. Tap → bubble. Long-press → gone for
session. Reload → still there until dismissed again.

### Phase 2: scripted onboarding (2 to 3 days)

- `data/character/script.ts` with the first-visit tour:
  1. "hi, i'm xo. tap me anytime."
  2. Points at home grid: "your apps live here."
  3. Points at the dock: "these stay pinned."
  4. "open Coworker. tap it." (waits for `pathname === "/coworker"`)
  5. (User opens Coworker) "this is one of our products."
  6. Points at NavBar back chevron: "tap back to leave any app."
  7. "you're set. find me again whenever."
- `TourSpotlight` darkens the screen, cuts a hole around the target
- Skip button (top-right of the spotlight)
- "Replay onboarding" toggle in Settings app
- localStorage `tourCompleted: true` flag

Verification: clear localStorage, reload. Full tour runs. Each step
advances on the right user action. Skip aborts cleanly. Settings
toggle restarts.

### Phase 3: contextual hints (1 to 2 days)

- `data/character/hints.ts` keyed by route:
  - `/coworker`: "want to try it? sign up takes 30 seconds."
  - `/swarm`: "swarm runs many coworkers. for teams."
  - `/pricing`: "compare plans. free works for most."
  - `/handbook` and other stubs: "we are still writing this one."
- Throttle: 1 spontaneous bubble per minute, max 1 per route per
  session
- Hints only fire on **first** route visit per session
- User-dismissed bubbles never reappear in the same session

Verification: open multiple apps in a row, hints fire as expected,
do not stack, do not reappear.

### Phase 4: conversational AI (3 to 5 days) `(decide path)`

This is the jump from "scripted character" to "actual assistant."
Two paths, pick before starting.

**Path A: direct in Next.js**
- New route handler `app/api/character/chat/route.ts`
- Uses Vercel AI SDK v6 via AI Gateway with `"provider/model"`
  strings (per the Vercel knowledge update)
- Streams responses to the client
- System prompt encodes the personality (Section 3)
- Tools: `openApp`, `navigateTo`, `showPlan` so the model can drive
  the UI
- Stateless; no memory beyond the active conversation
- Fastest to ship, fewest moving parts

**Path B: proxied through xo-swarm-api**
- xo-phone-os calls `xo-swarm-api`'s chat endpoint
- xo-swarm-api owns auth (Clerk), memory, MCP integrations, tools,
  billing telemetry
- Consistent with the rest of the XO stack (Coworker, Swarm all
  route through xo-swarm-api)
- Slower to ship; needs an endpoint added to xo-swarm-api
- Right answer long-term

**Default recommendation: A for MVP, B before public launch.** Path A
proves the UX. Path B makes the character a first-class XO agent
with memory, tools, and shared billing.

`/ask` becomes the full chat in either path; ambient bubbles can also
be AI-backed but should default to scripted hints for predictability.

### Phase 5: persona enrichment (open-ended)

- Multiple voices (`default`, `concise`, `playful`) picked in Settings
- i18n through `next-intl` (workspace already considering it)
- TTS for accessibility (`Web Speech API` first, ElevenLabs later)
- Optional: voice input (mic button in chat)
- Persistent memory across sessions (requires Clerk auth)

---

## 10. UX details that matter

- **Reduced motion.** Respect `prefers-reduced-motion`. Idle animation
  disabled, transitions become opacity fades.
- **Z-index.** Character above NavBar, below modals. TourSpotlight
  above everything except the character itself.
- **Focus management.** Speech bubbles are announced via `aria-live`.
  TourSpotlight traps focus during the spotlight.
- **Touch targets.** Avatar tap target is at least 44x44 px even when
  the visual is smaller.
- **Safe area.** Avatar position respects the home indicator and the
  Dynamic Island cutout on iPhone-frame mode.
- **Server safety.** Character is fully client-side; nothing in the
  SSR HTML changes based on character state (no hydration mismatch).
- **Cookie/storage notice.** Once we use `localStorage` for tour
  progress, the privacy page needs a line about it.

---

## 11. Performance budget

- **SVG character**: under 8 KB inline. Six states reuse the same
  paths, switched by props.
- **Framer Motion**: already in the bundle. The character reuses it,
  no new animation lib.
- **Tour data**: under 2 KB. Plain TS object, code-split via a
  dynamic `import("./script")` when onboarding actually runs.
- **AI chat** (Phase 4): streamed, no client-side model. The route
  handler is the only server cost. Budget: P50 first token under
  600 ms via AI Gateway.

Initial JS bundle delta from Phase 1-3: target under 10 KB gzipped
above today's baseline.

---

## 12. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Clippy syndrome (character is annoying) | High | Aggressive dismissal, hint throttle, no auto-popups after onboarding, easy "asleep" mode |
| Mascot reads as childish, undermines B2B credibility | Medium | Tone (Section 3) is the lever. If still wrong post-test, fall back to design C (voice-only) |
| Tour breaks when routes change | Medium | `script.ts` is data, validated at build time. Add a CI check that every step's target route still exists. |
| AI hallucinations on product questions (Phase 4) | Medium | System prompt with grounding from `data/apps.ts` + a structured "if you do not know, say so" rule. Eventually: RAG over xo-docs and xo-room. |
| Tour spotlight obscures real content on tiny viewports | Low | Test on 320 px wide; spotlight cutout grows with the target |
| `localStorage` blocked in iframes / incognito | Low | Treat absence as "not seen" and run the tour again; fine |
| Character animation jank on low-end Android | Low | SVG path animation is cheap; fallback to opacity transitions if `prefers-reduced-motion` or low frame budget detected |
| AI cost spike if `/ask` goes viral | Low | Rate limit per IP via Vercel's BotID + a tier-based quota in xo-swarm-api once on Path B |

---

## 13. Open decisions to make before Phase 0

1. **Design (Section 2):** A, B, or C? Default: A.
2. **Character name:** "XO" itself, or a sub-name (e.g. "Xeno",
   "Olive")? Default: just "xo," lowercase, no extra name.
3. **AI path for Phase 4:** A (direct) or B (via xo-swarm-api)?
   Default: A for MVP, B before public launch.
4. **Onboarding gating:** auto-launch for first-time visitors, or
   require a "Start tour" tap? Default: auto-launch, with an
   immediately visible Skip.
5. **Settings exposure:** "Replay onboarding," "Hide XO," and (later)
   "Voice" all in the Settings app? Default: yes, new `Group` titled
   "XO assistant."

---

## 14. Out of scope (intentionally)

- A character that walks between routes with animation (visually
  appealing, not worth the complexity)
- Multi-character (e.g. one mascot per app)
- 3D avatar
- User-uploaded avatars / "bring your own character"
- Voice input (Phase 5+)
- Anything that pretends the character is a real human

---

## 15. Estimated effort total

| Phase | Effort |
|---|---|
| 0 design | 0.5 to 1 day |
| 1 ambient static | 1 day |
| 2 scripted tour | 2 to 3 days |
| 3 contextual hints | 1 to 2 days |
| 4 AI conversation (Path A) | 3 to 5 days |
| 5 personality enrichment | open-ended |
| **Phases 0 to 4 total** | **~7 to 12 days** (1.5 to 2.5 weeks) |

Half-day buffer per phase for design polish and copy review.

---

## 16. Suggested order vs. other work

This plan is parallelizable with everything else on the phone OS
roadmap (the empty stub pages, real handbook content, Clerk auth,
Storybook). Two soft dependencies:

- **Clerk first** if Phase 5 cross-session memory is wanted (otherwise
  identity is fully anonymous).
- **xo-swarm-api endpoint** before Phase 4 Path B; not blocking for
  Phase 4 Path A.

Recommended sequence:

```
  now  ─►  Phase 0 (half-day creative pass)
       │
       ├─►  Phase 1 (ambient, no logic)        ◀── ship behind feature flag
       │
       ├─►  Phase 2 (scripted tour)            ◀── enable for new visitors
       │
       ├─►  Phase 3 (contextual hints)         ◀── always on
       │
       └─►  Phase 4 Path A (Vercel AI SDK)    ◀── /ask becomes real
            │
            └─►  later: Path B (xo-swarm-api proxy)
```

Phases 1 to 3 ship the character as a static, trustworthy guide.
Phase 4 is when the character earns the right to be called an AI
assistant.

---

## 17. Branch + commit strategy

Mirror the Next.js migration approach: one branch, phased commits,
verified before merge.

```
main
  └─► character-v1
       ├ chore: scaffold CharacterContext + Layer
       ├ feat: phase 1 ambient character
       ├ feat: phase 2 onboarding tour
       ├ feat: phase 3 contextual hints
       └ feat: phase 4a /ask via Vercel AI SDK
```

Tag the pre-character commit on `main` as `pre-character` for clean
revert.
