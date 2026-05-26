# xo-phone-os agent plan

How to make the phone OS itself agent-controllable: an Anthropic Claude Agent SDK backend that can read OS state, launch and navigate apps, call per-app functions, and surface results back through the OS chrome (notifications, spotlight, chat).

This document only covers the design. The scaffold (`/agent-sdk-dev:new-sdk-app`) lands after we converge on the choices in §13.

---

## 1. What "agent controls the OS" means here

The XO Phone is a thin client. The agent runs on a backend. The agent can do four kinds of things, in increasing levels of intrusion:

| Tier | What the agent does | Examples |
|---|---|---|
| **R**  | Read OS state | "What apps are pinned to the dock?" "What is the user looking at?" |
| **N**  | Navigate the OS | "Open the Pricing app." "Return home." "Show the notification panel." |
| **A**  | Call per-app actions | "List my last 5 sessions in API demo." "Reload the Example iframe." "Toggle the Theme setting." |
| **W**  | Write to user-visible chrome | "Drop a notification." "Pin this app to the dock." "Set the wallpaper." |

A complete integration ships all four tiers. The plan below isolates each tier so we can land R + N before A + W and watch how users react.

---

## 2. Layered architecture

```
                       ┌────────────────────────────────────────┐
                       │  Browser, xo-phone-os                  │
                       │                                        │
                       │  PhoneProvider + GestureProvider       │
                       │  DeviceFrame, StatusBar, HomeScreen,   │
                       │  AppView, Dock, panels...              │
                       │                                        │
                       │  <AgentSurface>                        │
                       │   ├ chat transcript                    │
                       │   ├ streaming reply (SSE)              │
                       │   └ "Agent action incoming" toasts     │
                       │                                        │
                       │  Action bus (client side)              │
                       │   ├ opens apps                         │
                       │   ├ fires notifications                │
                       │   ├ updates context                    │
                       │   └ writes back into PhoneContext      │
                       └─────────────┬──────────────────────────┘
                                     │
                  bi-directional     │
                  ┌──────────────────┴────────────────────┐
                  │ HTTP + SSE / WebSocket                │
                  │   POST /api/agent/turn  (user msg in) │
                  │   GET  /api/agent/stream (events out) │
                  │   POST /api/agent/ack   (action ack)  │
                  └──────────────────┬────────────────────┘
                                     │
                       ┌─────────────▼──────────────────────────┐
                       │  Backend, Next.js Route Handler        │
                       │  (Vercel Fluid Compute, Node 24)       │
                       │                                        │
                       │  Claude Agent SDK loop                 │
                       │   ├ SystemPrompt(os-snapshot)          │
                       │   ├ Tools(os, app, mcp)                │
                       │   ├ PermissionHooks → UI confirmations │
                       │   ├ Sessions (per device / per Clerk)  │
                       │   └ Streaming (SSE back to client)     │
                       │                                        │
                       │  Tool resolvers                        │
                       │   ├ OS tools (open/close/notify)       │
                       │   ├ App tools (registered per XOApp)   │
                       │   └ MCP servers (per app, optional)    │
                       └────────────────────────────────────────┘
```

Two things make this work cleanly:

1. **The phone is the single source of truth for OS state.** The backend never tries to "know" what is on screen; it asks the client via a tool call or reads the OS snapshot the client sent in the turn. This avoids the entire class of "agent thinks it opened Coworker, but the user already swiped home" bugs.
2. **Client actions are commands, not facts.** When the agent calls `os.openApp("/coworker")`, the backend emits an event that the client interprets and (optionally) confirms. The client may refuse. The agent sees the response.

---

## 3. The tool surface

Three concentric rings.

### 3.1 OS tools (always available)

These come for free with the runtime. The agent does not have to "discover" them per session.

| Tool | Tier | Purpose |
|---|---|---|
| `os_list_apps()` | R | Returns the registry: every XOApp's `path`, `label`, `kind`, `description`. Sourced from `data/apps.ts`. |
| `os_get_state()` | R | Returns `{ current, backStack, switcherOpen, notifOpen, controlOpen, dockApps, time, charge, wifi }`. |
| `os_open_app(path)` | N | Foregrounds the given app. Equivalent to `openApp(path) + router.push(path)`. |
| `os_go_home()` | N | `goHome() + router.push("/")`. |
| `os_pop_back()` | N | `pop()` on the in-app back stack. |
| `os_show_panel(panel)` | N | `panel` is `"notifications" | "control" | "spotlight" | "switcher"`. |
| `os_close_overlays()` | N | `closeAllOverlays()`. |
| `os_notify({ title, body, intent? })` | W | Pushes a row into the Notification Panel (same channel as system notifications). |
| `os_set_dock(paths[])` | W | Reorders / replaces dock pins (max 4). Requires permission. |
| `os_set_wallpaper(id)` | W | If/when wallpaper switching ships. |

These map 1:1 to existing `PhoneContext` actions and `data/apps.ts` queries. Implementing them on the client side is mechanical because the context already has the verbs.

### 3.2 App tools (per-XOApp, opt-in)

Any XOApp can declare tools that the agent can call when it wants something app-specific. The manifest gets a new optional field:

```ts
// lib/xo-app.ts (proposed addition)
export interface XOAppToolSpec {
  name: string                  // e.g. "list_channels"
  description: string           // shown to the agent
  inputSchema?: object          // JSON Schema for arguments
  // Resolution: "server" runs inside the backend's tool resolver.
  // "client" emits a client action; the client computes and posts back.
  side: "server" | "client"
  handler: string               // name resolved in a per-app registry
}

export interface XOAppBase {
  // ...existing fields...
  agent?: {
    tools?: XOAppToolSpec[]
  }
}
```

A page declares its tools in `app.ts`:

```ts
// app/api-demo/app.ts
export const xoApp = defineXOApp({
  path: "/api-demo",
  kind: "api",
  endpoint: "/users",
  // ...
  agent: {
    tools: [
      {
        name: "list_users",
        description: "List the first N demo users from jsonplaceholder.",
        inputSchema: { type: "object", properties: { limit: { type: "number" } } },
        side: "server",
        handler: "api-demo:list-users",
      },
      {
        name: "refresh",
        description: "Re-fetch the user list and re-render the API demo.",
        side: "client",
        handler: "api-demo:refresh",
      },
    ],
  },
})
```

The backend reads `data/apps.ts` at boot (it can; the file is pure data) and assembles the full tool list. Tool names are namespaced by app path to avoid collisions: `api-demo__list_users`, `api-demo__refresh`, etc.

**Server-side tools** resolve inside the backend. A registry maps handler keys to async functions:

```ts
// backend/tool-registry/api-demo.ts
import { registerTool } from "./registry"

registerTool("api-demo:list-users", async ({ limit = 5 }) => {
  const res = await fetch("https://jsonplaceholder.typicode.com/users")
  const data = await res.json()
  return data.slice(0, limit)
})
```

**Client-side tools** resolve in the browser. The agent's tool call becomes an SSE event; the client executes the handler, posts the result back via `/api/agent/ack`, and the agent loop continues with the tool result.

### 3.3 MCP servers (optional, app-level)

Any XOApp can declare an MCP server URL. The Agent SDK consumes MCP natively. Point it at the URL and the server's tools merge into the agent's tool list. This is the right shape for heavyweight integrations (xo-cowork-api as MCP, xo-swarm-api as MCP):

```ts
defineXOApp({
  // ...
  agent: {
    mcp: { url: "https://cowork.user-xyz.xo.builders/mcp" },
  },
})
```

MCP is out of scope for v1; mentioning it so the manifest shape is forward-compatible.

---

## 4. Wiring tools from XOApp manifests

`data/apps.ts` becomes the agent's tool source of truth. A small helper builds the SDK tool list at request time:

```ts
// backend/tools-from-apps.ts
import { apps } from "@/data/apps"
import { tool } from "@anthropic-ai/claude-agent-sdk"   // shape TBD per docs
import { resolveTool } from "./tool-registry"

export function buildAppTools() {
  return apps.flatMap(app => (app.agent?.tools ?? []).map(spec =>
    tool({
      name: `${app.path.replace(/[/]/g, "_")}__${spec.name}`,
      description: spec.description,
      inputSchema: spec.inputSchema,
      run: spec.side === "server"
        ? (args) => resolveTool(spec.handler, args)
        : (args) => emitClientAction(spec.handler, args),    // SSE bridge
    })
  ))
}
```

The OS tools (§3.1) are built the same way from a static `os-tools.ts` module. The backend assembles `[...osTools, ...appTools]` and passes the array to the Agent SDK on every turn.

**Per-app discoverability for the agent.** The Agent SDK supports subagents and progressive tool discovery. For sanity, expose the OS tools always and gate per-app tools behind an "active context": when the user opens Coworker, only Coworker's tools light up. This keeps tool counts bounded (the SDK currently performs best with ~20-50 tools in the active set).

---

## 5. Server-to-client bridge

The phone-os is a browser. The backend cannot directly call into the React tree. So OS-affecting tool calls become **events** the client subscribes to and acts on.

```
  user types "open coworker"  ─►  POST /api/agent/turn { content: ... }
                                       │
                                       ▼  agent SDK loop runs server-side
                                       │  decides to call os_open_app("/coworker")
                                       │
  GET /api/agent/stream  ◄──── SSE: { type: "client-action",
       (already open from              kind: "os_open_app",
        AgentSurface mount)            args: { path: "/coworker" },
                                       id: "call_a1b2" }
                                       │
  AgentSurface dispatches into     ───┘
  the action bus
                                       │
  PhoneContext.openApp("/coworker")
  router.push("/coworker")
                                       │
  POST /api/agent/ack { id: "call_a1b2", ok: true, snapshot: {...} }
                                       │
                                       ▼  agent loop resumes with tool result
  more SSE events: assistant text streams in
```

Two transports both work; pick one and stick with it:

- **SSE** (recommended). The chat stream IS the action channel. One long-lived `GET /api/agent/stream` connection, one `POST /api/agent/turn` per user message, one `POST /api/agent/ack` per client-resolved tool call. Vercel Fluid Compute supports long streaming responses well. Simpler than WebSocket; works with React Server Components nicely.
- **WebSocket**. Slightly lower latency, bidirectional from one socket. More infra to host (Vercel's WS story is fine but more setup).

Recommendation: **SSE + POST**. The Agent SDK's streaming API already emits chunks; route them onto the SSE channel as typed events. Client-action events are just another event type alongside `text`, `tool-call-start`, `tool-call-end`, `done`.

Event taxonomy:

```ts
type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool-call-start"; name: string; args: unknown; id: string }
  | { type: "tool-call-end"; id: string; ok: boolean; result?: unknown }
  | { type: "client-action"; kind: string; args: unknown; id: string }
  | { type: "permission-request"; id: string; what: string; risk: "low" | "medium" | "high" }
  | { type: "notification"; title: string; body: string; intent?: string }
  | { type: "done" }
  | { type: "error"; message: string }
```

---

## 6. The chat surface (`<AgentSurface>`)

The agent lives behind the existing **Ask XO** app (`/ask`), upgraded from stub to a real chat. No new XOApp kind required; it is a `kind: "native"` page that renders `<AgentSurface>` as its body.

```tsx
// app/ask/page.tsx
import { xoApp } from "./app"
import { XOAppShell } from "@/components/XOAppShell"
import { AgentSurface } from "@/components/agent/AgentSurface"

export const metadata = xoApp.metadata

export default function AskPage() {
  return (
    <XOAppShell app={xoApp}>
      <AgentSurface />
    </XOAppShell>
  )
}
```

`<AgentSurface>` is the only client component. It:

- Opens the SSE stream on mount, closes on unmount
- Renders the transcript
- Handles the input field + send
- Dispatches `client-action` events into the action bus
- Renders permission prompts inline
- Renders the streaming reply with cursor

A secondary, persistent surface: **Spotlight panel (pull down from the top, opposite of Control Center)** becomes a "quick agent" pane available from any app. Same `<AgentSurface>` component, smaller skin. Lives in `components/gestures/SpotlightPanel.tsx` which already exists per the gesture work.

---

## 7. Permissions

The Claude Agent SDK exposes permission hooks: before any tool runs, you can prompt the user. The phone-os needs to surface those prompts inside the chat (and optionally on top of the current app via a sheet) without breaking the visual model.

Three confirmation modes:

| Mode | Used for | UX |
|---|---|---|
| **silent** | OS reads (`os_list_apps`, `os_get_state`) | No prompt; runs immediately. |
| **toast** | OS navigation (`os_open_app`, `os_go_home`, `os_show_panel`) | Brief toast: "Opening Coworker". User can tap to undo within 3s. |
| **prompt** | OS writes (`os_notify`, `os_set_dock`), client-side app actions touching user data, any sensitive app tool | Modal sheet: "Allow agent to: {what}? [Once] [Always] [Deny]" |

Per-app grants persist (in `localStorage` for unauthed users; in the user's profile when Clerk lands). The agent sees grant decisions as part of the OS snapshot in the next turn so it can adapt without re-asking.

Hard rules:

- Anything financial (payment, signup completion) requires `prompt` regardless of prior grants.
- The agent cannot dismiss the user's prompt programmatically.
- A "Pause agent" button in the chat header is always available; killing the conversation kills any in-flight tool call.

---

## 8. Sessions and persistence

Each device gets a session UUID stored in `localStorage`. The backend keys conversation history off this UUID. When Clerk lands, sessions migrate to be keyed off the Clerk user id (one user, multiple devices, same history).

Persistence layer choices, from cheapest to richest:

| Option | Cost | Properties |
|---|---|---|
| **Vercel Marketplace Upstash Redis** | low | Keyed by session UUID, 30-day TTL, sub-ms read |
| **Vercel Marketplace Neon Postgres** | low | Joins with future Clerk user table; auditable |
| **Vercel Blob** | low | One JSON per session; simple but cold reads slower |
| **xo-swarm-api's Postgres** | needs wiring | Consistent with the rest of XO |

Recommendation: **Upstash Redis** for v1 (zero setup via Marketplace, perfect ergonomics for chat history), migrate to xo-swarm-api's Postgres once Clerk auth is wired and we want first-class history surfaces in the wider platform.

Session shape:

```ts
type AgentSession = {
  id: string                           // session UUID
  userId?: string                      // Clerk id when auth lands
  device: { ua: string; createdAt: string }
  messages: AgentMessage[]             // user + assistant turns
  grants: Record<string, "once" | "always" | "denied">   // permission decisions
  contextSnapshot?: OsSnapshot         // last known OS state from client
}
```

The system prompt assembled at each turn includes a compact OS snapshot, recent grants, and a curated tool list (per §4). This is the "memory" the agent has about the OS.

---

## 9. System prompt strategy

The system prompt has three sections, in this order:

1. **Identity**: see `CHARACTER_PLAN.md`. The XO persona, voice, refusal modes.
2. **OS snapshot**: compact, structured:
   ```
   You are inside the XO Phone OS.
   Current app: /coworker  (Coworker, kind: native)
   Back stack: [/]
   Pinned dock: /coworker, /example, /api-demo, /signup-external
   Open overlays: none
   Time: 14:32  Battery: 84%
   Available apps (13): /, /coworker, /swarm, /pricing, ...
   ```
3. **Tool list**: only OS tools + tools for the active app and recently-used apps. Capped at ~30 entries.

Re-built on every turn. Cheap, deterministic, no drift.

---

## 10. New repo layout (additive)

```
xo-phone-os/
├── app/
│   ├── api/
│   │   ├── agent/
│   │   │   ├── turn/route.ts        POST: user message in
│   │   │   ├── stream/route.ts      GET (SSE): assistant chunks + events out
│   │   │   └── ack/route.ts         POST: client-resolved tool result back in
│   │   └── healthz/route.ts         (existing)
│   └── ask/
│       ├── app.ts                   add agent: {} block if desired
│       └── page.tsx                 swap stub for <AgentSurface/>
│
├── components/
│   ├── agent/
│   │   ├── AgentSurface.tsx         "use client" chat surface
│   │   ├── AgentTranscript.tsx
│   │   ├── AgentComposer.tsx
│   │   ├── PermissionSheet.tsx
│   │   └── ActionBus.tsx            dispatches client-action events into PhoneContext
│   └── gestures/
│       └── SpotlightPanel.tsx       (existing) embed <AgentSurface variant="mini">
│
├── lib/
│   ├── xo-app.ts                    add `agent?: { tools?, mcp? }` to XOAppBase
│   └── agent/
│       ├── client.ts                browser-side SSE client + action dispatch
│       ├── server.ts                Agent SDK wrapper, session store, system-prompt builder
│       ├── tool-registry.ts         server-side tool handler registry
│       ├── tools-from-apps.ts       reads data/apps.ts → SDK tool list
│       └── transport.ts             SSE event encoder/decoder
│
├── context/
│   └── AgentContext.tsx             optional: expose live agent state to apps
│
└── AGENT_PLAN.md                    this file
```

Nothing in `app/<route>/page.tsx` for non-agent routes needs to change. The agent layer is purely additive.

---

## 11. Phasing

Each phase is shippable on its own. Stop after any of them and the OS still works.

### Phase 1: Conversation surface (no OS control yet)

- Backend Route Handler: `/api/agent/turn` + `/api/agent/stream`. Agent SDK, no tools. Bare conversation.
- `<AgentSurface>` in `/ask`, SSE wired, transcript rendering.
- Session UUID in `localStorage`, Upstash Redis store.
- Smoke test: open Ask XO, chat with the agent, get streaming replies.

Duration: ~2 days. Value: the phone has a real chat.

### Phase 2: OS tier R + N (read + navigate)

- Implement `os_list_apps`, `os_get_state`, `os_open_app`, `os_go_home`, `os_show_panel`, `os_close_overlays`, `os_pop_back`.
- Client action bus + SSE event handling for `client-action`.
- Permission UX: toasts for navigation; silent for reads.
- Smoke test: "Hey XO, open Coworker." → Coworker opens.

Duration: ~3 days. Value: the agent can drive the OS hands-free.

### Phase 3: App tools (tier A)

- Extend `XOAppBase` with optional `agent: { tools? }`.
- `tools-from-apps.ts` assembles the tool list per turn (active-app-aware filtering).
- Server-side handler registry; client-side handler registry mirroring it.
- Pilot: one server-side tool on `/api-demo` (`list_users`), one client-side tool on `/example` (`reload-iframe` already lives in `PullToRefresh`; surface it as an agent tool too).

Duration: ~3 days. Value: agent can do real work inside apps.

### Phase 4: Write tier W

- `os_notify` writes to the Notification Panel.
- `os_set_dock` reorders / swaps dock pins (with `prompt` permission).
- Optional: `os_set_wallpaper`, `os_pin_app`, when those features exist.
- Permission UX: modal sheets for everything in this tier.

Duration: ~2 days. Value: agent surfaces output through the OS chrome, not just the chat.

### Phase 5: Subagents and MCP

- Wire the Agent SDK's subagent feature for long-running tasks ("research Coworker pricing, then summarize").
- Pilot MCP integration: point at one xo-cowork-api endpoint exposed as MCP.
- Background task UI: spinning indicator in StatusBar; results dropped via `os_notify`.

Duration: ~5 days. Value: the agent can take genuinely long jobs.

### Phase 6: User identity (Clerk) + multi-device

This phase is about **knowing which XO user is on the phone**, not about
Claude credentials. Anthropic auth stays operator-level (see §13 #2a).

- Clerk integration (already planned in the broader roadmap).
- Session migrate from device UUID to Clerk user id.
- Cross-device chat history per Clerk user.
- Per-user permission grants instead of per-device.
- Forward the Clerk session token into agent tool calls that hit
  xo-swarm-api or xo-cowork-api so the agent acts on the user's
  behalf in those backends.

Duration: depends on the broader Clerk landing.

---

## 12. Trade-offs we are accepting

Cross-referencing the "running locally" analysis from earlier:

| Constraint | Why it is acceptable here |
|---|---|
| Backend container has no access to the user's local filesystem | The phone-os user is in a browser; there is no local filesystem to access. The relevant "filesystem" is the user's data on xo-swarm-api and xo-cowork-api, both of which the agent can reach over HTTP / MCP. |
| Backend uses the operator's Anthropic API key, not the user's Claude subscription | The phone-os is a public surface anyway; usage costs are a marketing/conversion expense like analytics or CDN. Per-user metering happens when Clerk lands. |
| Network latency on every tool call | The OS tools are local to the client (instant); only the agent <-> backend hop crosses the network. App tools are within one Vercel region; sub-50ms in practice. |
| Privacy: user messages flow to Anthropic | Document plainly in the chat header. Standard for any hosted LLM. |
| Cold starts | Vercel Fluid Compute reuses instances; cold starts are sub-second. Streaming responses keep perceived latency low. |
| 300s function timeout | Conversation turns finish in seconds. Long-running tasks (Phase 5) move to Vercel Queues or a separate worker; main turn returns immediately with a "task scheduled" notification. |

What we explicitly are NOT trying to do:

- The agent will not have shell access to the user's machine. Ever. This is a browser.
- The agent will not navigate to URLs the user does not approve.
- The agent will not be a generic "do anything" surface; tools are explicitly enumerated. No `Bash` tool. No arbitrary code execution.

---

## 13. Locked decisions

| # | Question | Decision |
|---|---|---|
| 1 | Backend language | **TypeScript**. Next.js Route Handler in this repo. xo-cowork-api stays the data backend; we call it over HTTP as needed (no second deploy). |
| 2 | SDK choice | **`@anthropic-ai/claude-agent-sdk`** (`0.3.144` installed). All agentic features (tools, MCP, subagents, sessions, permission hooks) wanted. |
| 2a | Backend auth | **Operator-level only**, forever. Two operator modes: (1) OAuth via `claude /login` on the host running the dev server, which uses the operator's Claude Pro/Max subscription with no per-token bill (recommended for local). (2) `ANTHROPIC_API_KEY` env var for pay-per-token. The env var wins when both are set. **Per-user "log in with your own Anthropic account" is explicitly out of scope** for this app: phone-os is one app among many in XO, and user identity / per-user backend access belong in xo-swarm-api + Clerk, not here. See `lib/agent/auth.ts` for the probe. |
| 3 | Session store | **Local, in-process** for v1. Plain `Map<sessionId, Message[]>` inside the running Route Handler. Zero infra for early testing. Migrate to Upstash Redis or xo-swarm-api Postgres when this leaves localhost. **Caveat**: in-memory state is wiped on every server restart and does not survive Vercel Fluid Compute scale-out across instances. Fine for local; not for shared dev or production. |
| 4 | Mid-gesture conflict on `os_open_app` | **User wins.** If the user is mid-gesture (pull-to-refresh, swipe, etc.), the agent's navigation tool call returns an error of kind `user-busy`. The agent sees the failure and can decide to retry or explain. We never queue actions behind the user. |
| 5 | Spotlight panel host | **Agent.** Spotlight is the always-available mini-AgentSurface. Plus: **the 4th dock pin becomes Chat (Ask XO)** instead of Sign up. Sign-up moves out of the dock (and therefore off the home screen, since `kind: "external"` is filtered out of the grid). The agent itself becomes the discovery surface for signup. |
| 6 | Per-app tool exposure | **Opt-in via `agent: {}` block on the manifest, handler implementation in a separate file.** Manifest declares; resolver implements. Mirrors how `kind: "api"` works (manifest has `endpoint`, page has the fetch). |
| 7 | Streaming format on SSE | **Full typed events** per the taxonomy in §5. Token deltas are one event type among several. |
| 8 | Rate limiting | **Deferred** with the persistence layer (no Upstash in v1 per #3). For local dev there is no rate limit; the moment we point a real domain at this, we add Vercel BotID + an Upstash rate-limit table (10 turns / day / IP for anon, 100 / day for Clerk-authed). |

---

## 14. Glossary

- **Action bus**: the client-side dispatcher that takes `client-action` SSE events from the backend and runs the matching effect (open app, fire notification, etc.).
- **Active app**: the app currently in `PhoneContext.current`. Used to scope which app tools are exposed to the agent on this turn.
- **OS snapshot**: a compact, serializable view of OS state included in the system prompt at each turn.
- **Per-app tool**: a function declared in an XOApp's `agent.tools` array. Either server-side (runs in the backend) or client-side (runs in the browser via the action bus).
- **Tier R / N / A / W**: the four levels of agent intrusion from §1: Read, Navigate, App-action, Write.

---

## 15. What this plan does NOT cover

- The character of the agent (tone, refusals, persona). See `CHARACTER_PLAN.md`.
- Animation choreography for incoming agent actions: see `LIFECYCLE.md`.
- The gesture for invoking the agent from any screen: see `GESTURE_PLAN.md` §X (Spotlight).
- Storybook coverage of `<AgentSurface>`: wired after the migration epoch closes.
- A multi-agent / multi-character setup (one phone, several distinct agents).

Pick those up in their own docs.

---

## 16. Pre-flight before Phase 1

Answer the eight questions in §13 (especially #1 language and #2 SDK choice). Once answered, the `/agent-sdk-dev:new-sdk-app` scaffold can land in ~30 minutes:

```
app/api/agent/turn/route.ts          ~80 lines
app/api/agent/stream/route.ts        ~60 lines
app/api/agent/ack/route.ts           ~30 lines
lib/agent/server.ts                  ~120 lines
lib/agent/transport.ts               ~40 lines
components/agent/AgentSurface.tsx    ~150 lines
components/agent/ActionBus.tsx       ~60 lines
```

That is Phase 1 only. Phases 2 through 6 each add a similar amount of focused code.
