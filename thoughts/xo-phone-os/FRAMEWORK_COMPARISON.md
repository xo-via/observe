# xo-phone-os framework comparison

If the eventual product is **animation heavy, extremely interactive,
and AI native**, then the framework choice matters more than for a
plain marketing site. This doc compares the current Next.js plan
against every credible alternative, scores each on the dimensions
that actually move the needle, and lands a verdict.

Sibling docs:

- `NEXTJS_MIGRATION_PLAN.md`: the in-progress Next.js migration plan
- `../XO_PHONE_NEXTJS.md`: the Gatsby vs Next decision rationale
- `PLAN.md`: the product roadmap

## 1. Goals and assumptions

The brief, restated:

1. **Animation heavy.** Layout transitions, shared-element morphs,
   spring physics, drag/snap/release, parallax, 60fps target on
   mobile.
2. **Extremely interactive.** Every interaction has a state and a
   visual response. Multiple concurrent UI states (overlays, sheets,
   drag in flight, audio cues). State must stay responsive under
   load.
3. **AI native.** Streaming text + tool calls, live agent UI, server
   actions feeding model contexts, retrieval, structured outputs.
   The app does not just *include* AI; it is *built around* an agent.

Implied operational constraints:

- Web-first (real iOS phones see the same surface in Safari)
- Eventually ship a real PWA install
- Stay aligned with the rest of the XO stack where possible
- Container-based deploy on k8s (already established)
- TypeScript everywhere

## 2. Evaluation rubric

| Dimension | What it measures | Weight |
|---|---|---|
| Animation fidelity | How smoothly the framework handles 60fps animations and reconciliation under churn | High |
| Reactivity model | How efficient state updates are; fine-grained vs whole-component | High |
| AI tooling first-class-ness | Native support for streaming, server actions, AI SDK adapters | Highest |
| Routing + navigation transitions | Quality of route-to-route motion (layoutId, view transitions) | High |
| Ecosystem maturity | Component libraries, AI libs, hosting, monitoring | High |
| DX and dev loop speed | HMR, type-safety, debugging story | Medium |
| Bundle size / cold load | Initial JS shipped to browser | Medium |
| SSR / SSG quality | SEO, social previews, fast TTFB | Medium |
| Migration cost from current state | Effort to switch off the current Next.js scaffold | Medium |
| Mobile / PWA story | Installable to home screen, offline, push notifications | Medium |
| Long-term viability | Active maintenance, community size | Medium |
| Stack alignment with XO | Match xo-main, xo-swarm, xo-docs, xo-room (all Next.js) | High |

## 3. Candidate frameworks

Nine credible options:

| Framework | Type | Reactivity | AI SDK story |
|---|---|---|---|
| **Next.js 16 (current plan)** | React metaframework | React (VDOM) | First-class: Vercel AI SDK is Next-native |
| **Vite + React (SPA)** | Pure client SPA | React | Use AI SDK with a separate backend |
| **Remix / React Router v7** | React metaframework | React | Strong, loaders/actions fit AI streaming |
| **TanStack Start** | React metaframework | React | Decent, newer, type-safe routing |
| **SolidStart** | Solid metaframework | Fine-grained (signals) | OK, `@ai-sdk/solid` exists but less common |
| **SvelteKit** | Svelte metaframework | Compiled, fine-grained | OK, `@ai-sdk/svelte` exists |
| **Astro + React islands** | Islands MPA | Per-island React | Awkward; AI runs in islands |
| **Qwik / QwikCity** | Resumable | Signals + resumability | OK, `@ai-sdk/qwik` exists |
| **Tauri 2 + Vite + React** | Native shell (desktop + mobile) | React in webview | Local model + Rust bindings |

Bonus: Expo + React Native Web for true cross-platform (web + iOS +
Android). Out of scope for the marketing surface but covered in
section 11.

## 4. Per-framework deep dives

### 4.1 Next.js 16 (current plan)

**Why it might be the answer**
- Vercel AI SDK (`@ai-sdk/react`, `useChat`, `useCompletion`) is
  Next-native. `xo-swarm` already uses it.
- Server Actions stream model responses with no extra plumbing.
- App Router lets us mix server-rendered shells with client-only
  animated chrome.
- Turbopack dev is fast enough now.
- Massive ecosystem; everything XO web ships is on Next.

**Where it costs us**
- App Router's RSC-payload round trips can hitch the icon-to-app
  morph (already documented in `NEXTJS_MIGRATION_PLAN.md` section 5).
- Whole-component re-renders on state changes. With a busy
  interactive shell, React 19's concurrent renderer and Motion's
  imperative layout updates handle it, but you have to be careful.
- Framework-level cost of layouts/server-vs-client boundary
  adds cognitive overhead.

**Animation grade**: A-
**AI grade**: A+
**Verdict**: still the right choice for our brief.

### 4.2 Vite + React (SPA)

**Why it might be the answer**
- Simplest mental model. No "use client" boundary, no server
  rendering. The whole tree is React.
- Fastest dev loop of any option (Vite + React Fast Refresh).
- Animations are dead simple because there is no SSR/hydration
  weirdness to fight.

**Where it costs us**
- No SSR. Initial HTML is empty; bots see nothing useful.
- AI work needs an explicit separate backend (xo-swarm-api, a
  Cloudflare Worker, or a Vercel Edge function). The AI SDK works
  but you re-implement the streaming plumbing.
- We lose route-level prerendering for the marketing pages.
- No first-class image optimization (next/image equivalent is
  patchwork).

**Animation grade**: A
**AI grade**: B (works, but you assemble the streaming yourself)
**Verdict**: tempting if we were AI-only, not great for our marketing
+ AI hybrid.

### 4.3 Remix / React Router v7

React Router v7 absorbed Remix in 2024. The "framework mode" is
effectively the new Remix.

**Why it might be the answer**
- Loaders + actions are a clean model for AI streaming.
- Web standards focused: works on any runtime, including Cloudflare
  Workers and Bun.
- SSR with progressive enhancement is the default.

**Where it costs us**
- Smaller ecosystem than Next. AI SDK works but is less battle-tested.
- We do not get free RSC; full client React hydrates.
- Stack divergence from xo-swarm.

**Animation grade**: A
**AI grade**: A-
**Verdict**: best alternative to Next on technical merits. Real cost
is ecosystem and XO stack alignment.

### 4.4 TanStack Start

**Why it might be the answer**
- File-routing is exceptionally type-safe (TanStack Router).
- Loader functions feel clean.
- Active development, momentum in 2025/2026.

**Where it costs us**
- Pre-1.0 at time of writing; some rough edges.
- Smaller AI tooling ecosystem.
- We become an early adopter for production.

**Animation grade**: A
**AI grade**: B+
**Verdict**: interesting in 12 months. Not yet for production.

### 4.5 SolidStart (Solid.js)

**Why it might be the answer**
- Fine-grained reactivity. State updates touch only the DOM nodes
  that actually depend on the changed signal. For a busy
  interactive shell, this is genuinely faster than React.
- Animations get the same Framer Motion benefits via `@motionone`
  / `solid-motionone`.
- JSX syntax, similar mental model to React.

**Where it costs us**
- Ecosystem is dramatically smaller. UI libraries, AI SDK, design
  tokens, all thinner.
- Hiring story: smaller talent pool.
- Stack divergence from XO (everything else is React).
- Framer Motion does NOT run on Solid; we use `solid-motionone`,
  which is a different (smaller) animation lib.

**Animation grade**: A+ (in theory; practical depends on motion lib parity)
**AI grade**: B (SDK adapter exists, less polished)
**Verdict**: technically appealing. Practically dangerous given the
rest of XO is React.

### 4.6 SvelteKit (Svelte 5)

**Why it might be the answer**
- Compiled output is tiny. Initial bundle could be ~30 to 50% of
  Next's.
- Animations and transitions are first-class language features
  (`transition:`, `animate:`).
- Svelte 5's "runes" reactivity is fine-grained, similar to Solid.
- AI SDK has `@ai-sdk/svelte`.

**Where it costs us**
- Ecosystem fragments away from React. XO devs would learn a new
  syntax.
- Component-sharing across xo-phone-os and xo-swarm becomes
  impossible.
- Smaller pool of off-the-shelf UI primitives.
- Migrating off Framer Motion / Motion to Svelte's built-in
  transitions changes the animation API significantly.

**Animation grade**: A
**AI grade**: A-
**Verdict**: this is the best non-React option on raw merits.
Killed only by XO stack alignment.

### 4.7 Astro + React islands

**Why it might be the answer**
- Best static-HTML output of any framework. Marketing pages would
  ship near-zero JS.
- Per-component "islands" for interactive bits.

**Where it costs us**
- Astro's model is built for content sites with sprinkled
  interactivity. Our shell is the opposite: a giant interactive
  surface with content slots.
- Layout transitions, shared element morphs, and route-level
  animation between two interactive routes are awkward in islands.
- AI is fine but requires islands wrapping the AI UI.

**Animation grade**: C+ (awkward across islands)
**AI grade**: B+
**Verdict**: wrong fit. Astro shines for blogs and docs. Our app is
all chrome.

### 4.8 Qwik / QwikCity

**Why it might be the answer**
- Resumability: near-zero JS on the initial load. The whole app is
  serialized on the server and "resumed" on the client lazily.
- Theoretically the lightest initial bundle of any approach.

**Where it costs us**
- The mental model is fundamentally different. Components are
  serialized, event handlers are URLs that lazy-load. Debugging is
  unusual.
- Animation libraries do not all map cleanly. Framer Motion has no
  Qwik port. Built-in `useTask$` lifecycle is the substitute.
- Ecosystem is small.
- AI tooling exists (`@ai-sdk/qwik`) but is not where Vercel pours
  energy.

**Animation grade**: B-
**AI grade**: B
**Verdict**: fascinating, not the right bet for an animation-heavy
app.

### 4.9 Tauri 2 + Vite + React

Tauri is a desktop AND mobile shell wrapping a webview. With
Tauri 2 (2024+) it ships to iOS and Android too. The web frontend
runs in a system webview; the native shell gives us OS APIs.

**Why it might be the answer**
- For a "phone OS" product, shipping a real installable app on
  Android and iOS is on-brand.
- Local model inference via Rust bindings (llama.cpp, candle).
- Real notifications, real haptics, file system access.

**Where it costs us**
- We still need a separate web build for the marketing surface.
  Two builds, one shell config.
- Apple app store approval, code signing, distribution overhead.
- The "OS-inside-OS" gag works better on the web (open in browser,
  see a phone). Inside Tauri the phone takes over the actual phone.

**Animation grade**: A (it is a regular web stack inside the shell)
**AI grade**: A (any AI SDK + local models)
**Verdict**: complement to a web framework, not a replacement.
Pair with one of the above for the web side.

## 5. AI native specifically

Vercel AI SDK currently supports: React (Next), Svelte, Solid, Vue,
Qwik. Adapter quality and example density follows the same order.

**What "AI native" needs from the framework**:

1. **Token streaming**: the framework can stream `text/event-stream`
   or RSC chunks from a server function to the UI without
   buffering.
2. **Server actions or loaders**: tool calls and structured outputs
   often need server-side glue. Frameworks with first-class server
   functions (Next, Remix, SvelteKit, TanStack Start) win here.
3. **`useChat` / `useCompletion` hooks**: maintained out of the box
   in Next, Svelte, Solid, Vue, Qwik. The chat state machine is
   tedious to write from scratch.
4. **Edge-runtime support**: for sub-100ms model proxies, edge
   matters. Next + Vercel, Remix + Cloudflare, SvelteKit +
   Cloudflare all have it.
5. **MCP-friendly server runtime**: if we want xo-phone-os to talk
   to MCP servers directly (Slack, Linear, GitHub), we need a Node
   runtime not a browser. All metaframeworks have this; pure SPAs
   do not.

**Net winner: Next.js**, then Remix / SvelteKit tied for second.

## 6. Animation specifically

Three animation patterns we will actually use:

1. **Layout / shared-element transitions** (icon morphing into app):
   - Framer Motion / Motion `layoutId`: works in any React framework
   - Native View Transitions API: progressive, supported in modern
     browsers, works in any framework
2. **Spring physics drag / release** (home indicator, app switcher):
   - Framer Motion `drag` works in React
   - SolidJS / Svelte have equivalents but smaller libs
3. **Per-frame interpolations** (parallax, scroll-linked motion):
   - Anything with `requestAnimationFrame` works everywhere
   - View Transitions can replace some cases

**Framework-level differences for animation**:

- React 19 + concurrent renderer + Motion is currently the most
  capable combo for shared-element transitions across routes.
- Solid / Svelte have finer-grained DOM updates; this matters for
  scenes with hundreds of moving elements, but not for our case
  (we animate a few dozen).
- Astro / Qwik struggle with cross-island shared layouts.

**Net winner**: a tie between Next, Remix, SvelteKit. Differences in
practice are sub-2%.

## 7. Big comparison matrix

| Framework | Animation | AI | Interactivity | DX | Ecosystem | Bundle | SSR/SSG | PWA | XO align | Migration cost from current | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Next.js 16 (current) | A- | **A+** | A | A | **A+** | B+ | A | A | **A+** | **$0 (in progress)** | **Keep** |
| Vite + React SPA | A | B | A | **A+** | A | A- | F | B | B+ | ~1 day | Consider for AI-prototype branches |
| Remix / RR v7 | A | A- | A | A | B+ | B+ | A | A | B | ~2 to 3 days | Strong alt; loses on alignment |
| TanStack Start | A | B+ | A | A | B | B+ | A- | B | B- | ~3 days | Revisit in 12 mo |
| SolidStart | A+ | B | A+ | B+ | C+ | A- | A | B | C | ~5 days | Tech wins, ecosystem loses |
| SvelteKit | A | A- | A+ | A | B+ | **A** | A | A | C | ~5 to 7 days | Best non-React; XO alignment kills it |
| Astro + islands | C+ | B+ | C | A | A- | A+ | A+ | A | B | ~4 days | Wrong shape for our app |
| Qwik | B- | B | B+ | B | C+ | A+ | A | B+ | C | ~5 to 7 days | Interesting bet, not now |
| Tauri 2 + Vite | A | A | A | A | B | n/a | n/a | A+ | B | additive, ~2 wk | **Pair with Next for native** |

Higher is better. "A+" is exceptional, "F" is disqualifying.

## 8. Verdict

**Stay on Next.js 16 for xo-phone-os.** Three reasons, all
load-bearing:

1. **AI native today.** The Vercel AI SDK is born in Next.js. Every
   feature lands there first: `useChat`, `useCompletion`, server
   actions for streaming, RSC AI components, structured output
   hooks. If xo-phone-os is going to be AI-built, this is where the
   tooling lives.
2. **XO stack alignment.** xo-main, xo-swarm, xo-docs, xo-room,
   xo-internal, xo-org, xo-docs-template are all Next.js. Picking
   anything else for a tenth surface forks the tooling for one
   project that is no more demanding than the others.
3. **Animation is not the bottleneck.** Framer Motion (and its
   successor `motion`) gives us A-grade animations on React. The
   marginal gains from Solid or Svelte on fine-grained reactivity
   matter only for thousand-node scenes. We have dozens.

The framework call only changes if XO's center of gravity shifts.
Two scenarios:

- **If we commit to native + mobile** (App Store presence): pair
  Next with **Tauri 2**. The web stays Next; the app is a Tauri
  shell around the same React code. This is additive, not a
  switch.
- **If AI is the only thing that matters** and we are willing to
  carve xo-phone-os out of XO's shared toolbox: SvelteKit or
  SolidStart deliver a slightly leaner runtime. Slight, not
  transformative.

Either way, Next is the right primary choice today.

## 9. What we would change about the Next plan, given the new brief

The current `NEXTJS_MIGRATION_PLAN.md` is correct as-is, but three
additions are worth pricing in now that "AI native + extremely
interactive" is the actual target:

1. **Add `@ai-sdk/react` as a dependency from day one.** Even before
   we wire any AI UI, ship the dependency, write a placeholder
   `useChat` hook in `app/ask/page.tsx`. Lets us iterate against
   real streaming endpoints during Phase 2.
2. **Plan an Edge runtime API route** at `app/api/chat/route.ts`
   for low-latency model proxying. Document this in the Dockerfile
   note: edge routes are NOT served from the standalone container;
   they need Vercel or a separate edge worker. For k8s deploys
   without Vercel, swap to node runtime and accept the latency.
3. **Reserve `motion` (the post-Framer split) for v2.** Motion is
   the spiritual successor to Framer Motion as a framework-agnostic
   animation lib. If we ever do experiment with Solid or Svelte,
   it's the bridge.

## 10. AI native + animation: the specific risk

When an AI response streams in and lays out (text appears, blocks
render), that itself is animation. The framework has to handle
streaming text PLUS animated layout PLUS continued interactivity
without the main thread choking.

- **Next App Router + Suspense + streaming**: the right primitives.
  Tokens stream as RSC chunks; layouts settle as they arrive.
- **Framer Motion + AnimatePresence** can animate the streamed
  blocks in.
- **React 19 concurrent renderer** keeps the main thread interactive
  during streams.

This combo is what `useChat` is designed for. Next is uniquely
positioned to express it cleanly.

For comparison: a Vite SPA hitting our own backend would buffer the
SSE stream into state and re-render on each chunk. Same UX, much
more wiring.

## 11. Edge cases worth naming

### 11.1 PWA

Any of these frameworks supports PWA install. The work is the same:
manifest, service worker, icons. Plan to ship a PWA manifest in
Phase 3 regardless of framework.

### 11.2 Expo + React Native Web

If we ever want the same code running natively on iOS / Android +
the web, Expo is the canonical bet. Cost: rewriting the OS shell
in `react-native-web` primitives. Animations need
`react-native-reanimated` 3. Significantly different code from a
plain React app. Not a near-term move; flagged for Phase 6 or
later.

### 11.3 Tauri pairing

Tauri does not replace Next; it embeds a Next build inside a Rust
shell that can ship to iOS, Android, macOS, Windows, Linux. A
plausible 2026 sequence:

1. Ship Next-on-web first (current plan).
2. When stable, wrap the Next build in Tauri 2 for App Store
   distribution.
3. The "phone OS on the desktop" gag becomes a real installable app
   that puts a phone-shaped icon on the user's Mac dock.

### 11.4 React Compiler (forget)

React 19 ships with the React Compiler. Next 16 supports it but
xo-swarm has it disabled (`reactCompiler: false`). Worth revisiting
in 6 months to see if turning it on helps interactivity. Out of
scope for this comparison.

## 12. Open questions

1. **Do we want to keep xo-phone-os and xo-swarm sharing components?**
   If yes, both must be on React. This single answer kills SvelteKit
   and SolidStart for production.
2. **Will AI features run on Vercel or on our k8s cluster?** Vercel
   gives us edge streaming for free. K8s gets us full control but
   higher latency on the AI proxy. Affects which framework features
   we lean on.
3. **PWA vs Tauri vs both?** Decide before Phase 4 (originally
   wallpaper polish). PWA is cheaper; Tauri is more memorable.
4. **What is the actual AI surface?** Is xo-phone-os mainly
   visual / informational with one chat app inside, or is it an
   agentic UI where every app integrates an agent? Bigger AI scope
   raises the cost of being on a non-Next framework.

## 13. Bottom line, one paragraph

The current Next.js 16 plan stands. It is the only framework that
combines the strongest AI tooling with XO's existing stack and a
proven animation story. The interesting question is no longer
"which framework"; it is "what AI primitives do we wire from day
one." Add `@ai-sdk/react` to dependencies, reserve an
`app/api/chat/` route, and treat Tauri as a future additive option
when we are ready to ship a real installable phone OS.
