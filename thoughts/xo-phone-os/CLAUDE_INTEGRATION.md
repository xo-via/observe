# Claude integration in xo-phone-os

How the agent works **today**. This doc is the current-state reference: what's wired, what files participate, what the Next.js backend needs to run it. For where it's going, see [`AGENT_PLAN.md`](AGENT_PLAN.md). For the specific cowork-api side, see [`COWORK_WRAPPER.md`](COWORK_WRAPPER.md).

---

## 1. Status

What ships today (committable or already in tree):

| Capability | Status | Where |
|---|---|---|
| Chat surface (one-shot turn, SSE streaming) | ✅ Done | `app/ask`, `components/agent/AgentSurface.tsx`, `app/api/agent/turn` |
| Operator auth (OAuth `claude /login` or API key) | ✅ Done | `lib/agent/auth.ts` |
| In-memory session store | ✅ Done (dev only) | `lib/agent/session-store.ts` |
| Typed SSE event taxonomy | ✅ Done | `lib/agent/transport.ts` |
| OS Tier R tools (`os_list_apps`, `os_get_state`) | ✅ Done | `lib/agent/os-tools.ts` |
| OS Tier N tools (`os_open_app`, `os_go_home`, `os_pop_back`, `os_show_panel`, `os_close_overlays`) | ✅ Done | same + `components/agent/action-bus.ts` |
| Client action bridge (browser dispatches + acks) | ✅ Done | `components/agent/action-bus.ts`, `app/api/agent/ack` |
| Locked-device guard (server-side refusal) | ✅ Done | `lib/agent/os-tools.ts` |
| xo-cowork-api wrapper (6 read tools) | ✅ Done | `lib/cowork-api/`, `lib/agent/cowork-tools.ts` |
| OS Tier W tools (`os_notify`, `os_set_dock`, `os_set_wallpaper`) | ❌ Not started | Phase 4 |
| Per-XOApp `agent` block + tools | ❌ Not started | Phase 3 (we did one cross-cutting MCP server instead) |
| Subagents | ❌ Not started | Phase 5 |
| Persistent session store (Redis / Postgres) | ❌ Not started | Phase 6 prerequisite |
| Clerk identity / per-user grants | ❌ Not started | Phase 6 |
| Permission UX (sheets, grants) | ❌ Not started | Phase 4 prerequisite |
| Rate limiting | ❌ Not started | Pre-public ship requirement |

**Code volume**: ~1.8k LOC across 14 files, all server-side TypeScript except the two client files (`AgentSurface.tsx`, `action-bus.ts`).

**Live state**: typecheck clean. `pnpm dev` on :18002, `/api/agent/turn` returns 400 to empty POST (input validation), `/ask` 200 (chat tile). When `claude /login` is set up locally, the chat is fully functional and the agent can both read OS state and call into `xo-cowork-api`.

---

## 2. Architecture, one picture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Browser                                                              │
│                                                                      │
│  /ask page  ──renders──►  <AgentSurface>  (client)                   │
│                            │                                         │
│                            │ buildSnapshot()  ──┐                    │
│                            │                    │ {current,backStack,│
│                            │                    │  locked,dockPaths} │
│                            │                    │                    │
│                            ▼                    ▼                    │
│              POST /api/agent/turn  {sessionId, message, snapshot}   │
│              ◄────────────────────── SSE  AgentEvent stream          │
│                            │                                         │
│                            │ on { type:"client-action" }:            │
│                            │   useAgentActionBridge()                │
│                            │     ├ refuse if LockContext.locked      │
│                            │     ├ run via PhoneContext + router     │
│                            │     └ POST /api/agent/ack {id, ok,...}  │
└────────────────────────────│─────────────────────────────────────────┘
                             │
                             ▼  Next.js Route Handler (Node 24, Fluid Compute)
┌──────────────────────────────────────────────────────────────────────┐
│ app/api/agent/turn/route.ts                                          │
│                                                                      │
│   runWithTurnContext({                                               │
│     sessionId, snapshot,                                             │
│     emit: writes AgentEvent to SSE controller,                       │
│     awaitAck: registerAckSlot(id) -> Promise<AckResult>              │
│   }, async () => for await event of runChatTurn(...))                │
│                                                                      │
│           │                                                          │
│           ▼                                                          │
│   lib/agent/server.ts  runChatTurn()                                 │
│           │                                                          │
│           ├─ detectAuth() ──► OAuth (claude CLI) | API key | none    │
│           ├─ appendMessage(user) to in-memory store                  │
│           ├─ buildSystemPrompt(snapshotSummary)                      │
│           │                                                          │
│           ▼                                                          │
│   @anthropic-ai/claude-agent-sdk  query({                            │
│     prompt: history-as-transcript,                                   │
│     options: {                                                       │
│       systemPrompt, includePartialMessages: true,                    │
│       tools: [],   // disable built-in Bash/Read/Write/Edit          │
│       allowedTools: [mcp__xo-os__*, mcp__xo-cowork__*],              │
│       mcpServers: {                                                  │
│         "xo-os":     createOsMcpServer(),                            │
│         "xo-cowork": createCoworkMcpServer(),                        │
│       },                                                             │
│     },                                                               │
│   })                                                                 │
│           │                                                          │
│           │  spawns claude-code CLI subprocess; routes its           │
│           │  tool calls back to the in-process MCP server            │
│           ▼                                                          │
│   for await (msg of result):                                         │
│     toAgentEvent(msg) -> ctx.emit(event)                             │
│                                                                      │
│           when the model calls a tool:                               │
│           ┌──────────────────────────────────────────────┐           │
│           │ os_open_app({path}):                         │           │
│           │   id = nextActionId("os_open_app")           │           │
│           │   ctx.emit({type:"client-action",kind,args,id})          │
│           │   ack = await ctx.awaitAck(id, 10_000)       │           │
│           │   return ok | err(ack.error)                 │           │
│           └──────────────────────────────────────────────┘           │
│           ┌──────────────────────────────────────────────┐           │
│           │ cowork_read_file({path}):                    │           │
│           │   r = await coworkApi.readFile(path)         │           │
│           │   return ok(r.data) | err(r.error)           │           │
│           └──────────────────────────────────────────────┘           │
└────────────────────────────│─────────────────────────────────────────┘
                             │
        ┌────────────────────┴───────────────────────┐
        ▼                                            ▼
┌───────────────┐                       ┌────────────────────────┐
│ Anthropic API │                       │ xo-cowork-api          │
│ (via Claude   │                       │ POST /api/files/...    │
│  Code OAuth   │                       │ GET  /api/sessions/... │
│  or x-api-key)│                       │ etc.                   │
└───────────────┘                       └────────────────────────┘
```

Two key inversions worth internalizing:

1. **The browser owns OS state.** The server never tries to know what is on screen; the browser sends a fresh `OsSnapshot` with every turn. The server reads it to answer `os_get_state` and to gate navigate tools (the locked check happens server-side before any client round-trip).
2. **The server owns tool decisions.** Every tool runs in the Node Route Handler. OS tools call into the browser via SSE + ack; cowork tools go server-to-server. The Anthropic API only sees tool definitions and tool results, never our wire format.

---

## 3. Code flow, one turn

Walking the lifecycle of `"Open Coworker"`:

```
1.  User types "Open Coworker" → presses Send
                │
2.  AgentSurface.send()
      buildSnapshot() = {current:"/ask", backStack:[], locked:false, dockPaths:[...]}
      POST /api/agent/turn {sessionId:"s_...", message:"Open Coworker", snapshot}
                │
3.  Route Handler app/api/agent/turn/route.ts
      Validates body (400 if sessionId/message missing).
      Creates a TurnContext with emit + awaitAck closures.
      runWithTurnContext(ctx, () => for-await runChatTurn(...))
                │
4.  runChatTurn (lib/agent/server.ts)
      detectAuth() → "oauth" (claude CLI present)
      appendMessage("user", "Open Coworker") → in-memory store
      transcript = renderTranscript(getMessages(sessionId))
      systemPrompt = base + OS snapshot summary
      query({prompt: transcript, options: {mcpServers, allowedTools, ...}})
                │
5.  Claude Agent SDK
      Spawns Claude Code subprocess.
      Sends transcript + tool definitions to Anthropic.
      Streams back: tool_use (os_open_app), then text deltas.
                │
6.  toAgentEvent() converts SDK messages → AgentEvent union
      stream_event (content_block_delta) → {type:"text", delta:"..."}
      tool_use → triggers our MCP handler
      result → {type:"done", usage:{...}}
                │
7.  Tool handler: os_open_app({path: "/coworker"})  (lib/agent/os-tools.ts)
      ctx = requireTurnContext()
      if ctx.snapshot.locked → return err("device-locked")     ← never round-trips
      id = "act_..._os_open_app"
      ctx.emit({type:"client-action", kind:"os_open_app", args:{path}, id})
                │  SSE event written to controller
                ▼
8.  Browser receives SSE: {type:"client-action", ...}
      AgentSurface.consumeStream() callback
        → addActionBubble({...})    "Opening /coworker"
        → void dispatchClientAction(event)
                │
9.  useAgentActionBridge.dispatchClientAction
      if locked → POST /api/agent/ack {id, ok:false, error:"device-locked"}; return
      switch kind === "os_open_app":
        phone.openApp("/coworker")    ← PhoneContext state update
        router.push("/coworker")      ← Next URL navigation
      await 16ms (let state settle)
      POST /api/agent/ack {id, ok:true, snapshot:{current:"/coworker", ...}}
                │  Server side:
                ▼
10. app/api/agent/ack/route.ts
      resolveAck(id, {ok:true, snapshot})
        → pendingAcks.get(id)({ok:true, snapshot})
                │
11. Back in step 7's tool handler:
      ack resolves → return ok({actionId, snapshot})
                │
12. SDK feeds tool result back into the model loop.
      Model emits "Opened Coworker."  text deltas
                │
13. toAgentEvent → {type:"text", delta:"..."}  → SSE → browser
14. Final SDK message type:"result" → {type:"done", usage:{...}} → SSE
15. runChatTurn appends the assistant reply to in-memory store
16. Route Handler controller.close() → stream ends
17. Browser sees done; AgentSurface marks the assistant bubble non-pending
```

A pure-text turn (no tool call) skips steps 7-12. A cowork-tool turn skips steps 7-11's emit/ack dance entirely; the handler just calls `coworkApi.foo()` and returns the JSON inline.

---

## 4. File-by-file

The integration in one column:

```
xo-phone-os/
├── app/
│   ├── api/agent/
│   │   ├── turn/route.ts    (115)  POST entry, SSE stream, TurnContext build
│   │   └── ack/route.ts      (45)  POST to resolve a pending navigate-tool ack
│   └── ask/
│       ├── app.ts                  XO App manifest, dock pin "Chat"
│       └── page.tsx                Server Component, renders <AgentSurface/>
│
├── components/agent/
│   ├── AgentSurface.tsx    (374)  Chat UI (client). Sends snapshot, consumes SSE,
│   │                              dispatches client-actions, renders Via persona
│   └── action-bus.ts       (148)  useAgentActionBridge hook: buildSnapshot()
│                                  + dispatchClientAction(event) -> ack
│
└── lib/
    ├── agent/
    │   ├── server.ts       (249)  Main wrapper: runChatTurn(), SDK query() call,
    │   │                          system-prompt builder, SDK message → AgentEvent
    │   ├── auth.ts          (71)  detectAuth(): OAuth | API key | none probe
    │   ├── session-store.ts (56)  In-memory Map<sessionId, Message[]>
    │   ├── transport.ts     (26)  AgentEvent union + SSE encoders
    │   ├── turn-context.ts (115)  AsyncLocalStorage + pendingAcks registry
    │   ├── os-snapshot.ts   (32)  OsSnapshot type + EMPTY_SNAPSHOT fallback
    │   ├── os-tools.ts     (197)  xo-os MCP server (7 tools, R + N)
    │   └── cowork-tools.ts (157)  xo-cowork MCP server (6 read tools)
    │
    └── cowork-api/
        ├── client.ts       (166)  Typed fetch wrapper, COWORK_API_URL,
        │                          soft-fail with actionable errors
        └── types.ts         (68)  Narrow DTOs (only fields we use)
```

Two files own the "what does the agent see" decisions:

- **`lib/agent/server.ts`** lines 22-105 build the system prompt that lists tools and rules. Edit here when adding a new tool kind.
- **`lib/agent/os-tools.ts` + `lib/agent/cowork-tools.ts`** are the actual tool implementations. Edit here when adding a new individual tool.

Two files own the "how does the server reach the browser" plumbing:

- **`lib/agent/turn-context.ts`** is the AsyncLocalStorage + ack registry. Both routes (`turn` and `ack`) share its module-scope state.
- **`components/agent/action-bus.ts`** is the browser side: it knows how to translate each `client-action` kind into a PhoneContext call.

---

## 5. What the backend needs

Concretely, to run Claude integration on a host:

### 5.1 Runtime + node

| Requirement | Value | Note |
|---|---|---|
| Runtime | Node.js | The Agent SDK spawns the Claude Code CLI; `executable: 'node'` is the default |
| Version | Node 20+ (24 LTS recommended) | Per Next 16 + Vercel Fluid Compute defaults |
| Function runtime hint | `export const runtime = "nodejs"` | Both `turn` and `ack` route handlers set this explicitly |
| Function timeout | `dynamic = "force-dynamic"` | SSE stream is long-lived |
| Subprocess capability | required | The SDK spawns `claude` (or its bundled copy). Vercel allows `child_process`; bare-metal too. |

### 5.2 Auth (one of)

Pick exactly one for any given deploy:

| Option | Env / setup | Use case |
|---|---|---|
| **OAuth via Claude Code** | Run `claude /login` once on the host; tokens persist in macOS Keychain / OS secret store | Local dev with a Claude Pro/Max/Team subscription |
| **API key** | `ANTHROPIC_API_KEY=sk-ant-...` | Anything hosted (Vercel, k8s, etc.) where you can't run an interactive login |

`lib/agent/auth.ts` probes both and reports `oauth | apikey | none`. If both are set, the env var wins (standard Unix precedence). If neither is set, the first turn returns a typed `error` event with a friendly hint.

**Operator-only, forever** (AGENT_PLAN.md §13 #2a). Per-user Anthropic accounts are out of scope; the phone-os is one app among many and per-user identity lives in xo-swarm-api + Clerk.

### 5.3 Optional integrations

| Env var | Default | Purpose |
|---|---|---|
| `COWORK_API_URL` | `http://localhost:5002` | Where the cowork wrapper points. Required if cowork-api lives off-host. |

### 5.4 NPM dependencies (already in `package.json`)

```
"@anthropic-ai/claude-agent-sdk": "0.3.144"
"@modelcontextprotocol/sdk": "1.29.0"      // peer dep of the Agent SDK
"zod": "4.4.3"                              // peer dep + tool input schemas
"next": "16.2.6"
"react": "19.2.6"
```

No other server-side deps. The SDK bundles Claude Code under the hood.

### 5.5 Network egress

| Destination | Why |
|---|---|
| `api.anthropic.com` (HTTPS) | Outbound from the SDK; required for any turn |
| `COWORK_API_URL` host | Whenever the agent calls a cowork tool |

### 5.6 What it does NOT need

- A database. Phase 1 session store is in-process; phase 6 introduces Redis/Postgres.
- Inbound auth. Phase 1 has none; rate-limit + abuse story is a pre-public-ship requirement.
- A websocket upgrade. We use SSE over a regular HTTP POST/response.
- Filesystem write access on the host. The SDK reads its own config; it does not write to your project unless you wire a tool to do so.
- A queue / worker. Turns finish in seconds; long-running tasks are a Phase 5 concern.

### 5.7 Vercel-specific notes (if deploying there)

- Default 300s function timeout is plenty for chat turns.
- Fluid Compute reuses instances; cold starts are sub-second.
- Multiple Fluid Compute instances each have their own in-memory session Map; **do not run multi-instance until you swap to Redis** or sessions will split. For early demos, pin to one instance.
- BotID + a small Upstash rate-limit table is the recommended pre-ship rate-limit story (deferred per AGENT_PLAN §13 #8).

---

## 6. Wire format reference

### 6.1 Request

```http
POST /api/agent/turn
Content-Type: application/json

{
  "sessionId": "s_<base36>_<base36>",
  "message": "Open Coworker",
  "snapshot": {
    "current": "/ask",
    "backStack": [],
    "locked": false,
    "dockPaths": ["/coworker","/example","/api-demo","/ask"]
  }
}
```

`snapshot` is optional; absent or partial values fall through to `EMPTY_SNAPSHOT`.

### 6.2 Response (SSE)

`Content-Type: text/event-stream`. Each event is a single `data:` line containing one JSON object, followed by a blank line. Heartbeat comments (`: ping`) come every 15s to keep proxies awake.

Event union from `lib/agent/transport.ts`:

```ts
type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool-call-start"; name: string; args: unknown; id: string }
  | { type: "tool-call-end"; id: string; ok: boolean; result?: unknown }
  | { type: "client-action"; kind: string; args: unknown; id: string }
  | { type: "permission-request"; id: string; what: string; risk: "low"|"medium"|"high" }
  | { type: "notification"; title: string; body: string; intent?: string }
  | { type: "done"; usage?: { input?: number; output?: number; cost_usd?: number } }
  | { type: "error"; message: string; code?: "missing-key"|"user-busy"|"internal" }
```

Phase 2 actively emits: `text`, `client-action`, `done`, `error`. The rest are reserved so the client and server agreed on the format from day one and later phases add events without renegotiation.

### 6.3 Client → server ack (only for navigate tools)

```http
POST /api/agent/ack
Content-Type: application/json

{
  "id": "act_<base36>_<n>_os_open_app",
  "ok": true,
  "error": null,
  "snapshot": { /* OsSnapshot post-action */ }
}
```

Returns `200 { ok: true }` if a tool was waiting; `404 { ok: false }` if the ack is stale (tool already timed out). Both are harmless.

---

## 7. Tool surface, today

Two MCP servers register at every turn:

### 7.1 `xo-os` (7 tools, in-process)

| Tool | Tier | Effect |
|---|---|---|
| `os_list_apps()` | R | Server-resolved: returns `apps` from `data/apps.ts` |
| `os_get_state()` | R | Returns the snapshot the browser sent |
| `os_open_app(path)` | N | Emits `client-action`, awaits ack |
| `os_go_home()` | N | Emits, awaits |
| `os_pop_back()` | N | Emits, awaits |
| `os_show_panel(panel)` | N | Emits, awaits |
| `os_close_overlays()` | N | Emits, awaits |

All N tools refuse server-side if `snapshot.locked === true` (no round-trip).

### 7.2 `xo-cowork` (6 tools, HTTP to cowork-api)

| Tool | cowork-api endpoint |
|---|---|
| `cowork_health()` | `GET /health` |
| `cowork_workspace_info()` | `GET /api/config/workspace` |
| `cowork_list_sessions(limit?, offset?)` | `GET /api/sessions/` |
| `cowork_list_agents()` | `GET /api/agents/` |
| `cowork_list_files(path?)` | `POST /api/files/list-directory` |
| `cowork_read_file(path)` | `POST /api/files/content` |

All soft-fail; the SDK sees the error as a tool-result the agent can describe to the user.

Tool name mapping inside the SDK / Anthropic API: `mcp__<servername>__<toolname>`. The model sees `mcp__xo-os__os_open_app`, etc. `allowedTools` in `lib/agent/server.ts` uses those fully qualified names; everything else (Bash, Read, Write, file edits, etc.) is disabled via `tools: []`.

---

## 8. Failure modes and how they surface

Categorized by where they originate. Each is surfaced as an `AgentEvent` with `type: "error"` (or as a tool error the model handles inline):

| Origin | Symptom | Surfaced as |
|---|---|---|
| No Claude auth | First turn returns immediately | `{type:"error", code:"missing-key", message:"... claude /login ... or set ANTHROPIC_API_KEY ..."}` |
| Anthropic API down | SDK throws | `{type:"error", code:"internal"}` with the error message |
| Device locked, agent calls a navigate tool | Tool refuses server-side | Tool result `{ok:false, error:"device-locked"}`; agent typically says "unlock first" |
| User navigates away from `/ask` mid-turn | AgentSurface unmounts, AbortController fires | Server-side ack times out (10s) → tool returns `{ok:false, error:"ack timeout"}`; the final text deltas are lost to the user |
| cowork-api unreachable | `ECONNREFUSED` | Tool result `{ok:false, error:"cowork-api unreachable at ... Is xo-cowork-api running?"}` |
| cowork-api endpoint shape drift | 404/422/etc. from cowork | Tool result with the HTTP status + first 240 chars of body; the agent can adapt or tell the user |
| Browser refuses an unknown client-action kind | client-side switch default | POST ack `{ok:false, error:"unknown action: ..."}`  |
| Server restart mid-conversation | Session Map wiped | Next turn starts a new logical session; no error, but no recall of prior turns |

---

## 9. Things to know before you ship this past localhost

In rough priority order:

1. **Switch session store to Upstash Redis (or similar).** In-memory state is fine on localhost; on Vercel Fluid Compute (multi-instance) or any restart-prone host it loses turns silently. Swap target is `lib/agent/session-store.ts`; the interface is intentionally small.
2. **Add rate limiting.** No throttle today. A single client can fire any number of turns and run up your Anthropic bill (or burn your subscription quota). Pre-ship requirement.
3. **Lock the cowork tools behind a `COWORK_API_URL` reachability + intent check** if you ever point this at a remote cowork-api. Today the only safety is that cowork-api lives on localhost where only the developer can reach it.
4. **Add basic abuse signals.** BotID + a per-IP daily ceiling. The Anthropic SDK does not throttle; only the operator can.
5. **Persistent chat UI.** Today, navigating away from `/ask` aborts the SSE stream; the agent's confirmation message disappears. Move AgentSurface to a persistent overlay (Spotlight panel or a Siri-style sheet) or load history on `/ask` mount.
6. **Permission UX for write tools.** Phase 4 (`os_notify`, `os_set_dock`) is harmless-feeling but you still want a per-app grant model before agents can rearrange the user's dock.
7. **Loud failure for cost overrun.** The `done` event carries `cost_usd`; today nothing acts on it. Surface a daily-budget indicator before this goes anywhere with real traffic.

---

## 10. Quick verification recipe

Anything you change in `lib/agent/` should pass these three gates before commit:

```bash
# 1. Types
pnpm typecheck

# 2. Endpoints reachable
curl -s -o /dev/null -w "/ %{http_code}\n" http://localhost:18002/
curl -s -X POST http://localhost:18002/api/agent/turn -H "content-type: application/json" -d '{}' \
  | head -1  # expect 400 / "sessionId is required" or similar

# 3. End-to-end with a real turn (requires claude /login OR ANTHROPIC_API_KEY)
curl -s -X POST http://localhost:18002/api/agent/turn \
  -H "content-type: application/json" \
  -d '{
    "sessionId":"smoke-'"$(date +%s)"'",
    "message":"Reply with just the word PONG.",
    "snapshot":{"current":"/","backStack":[],"locked":false,"dockPaths":[]}
  }' --max-time 60 | grep -v "^: ping"
# expect: data: {"type":"text","delta":"P"} ... data: {"type":"done",...}
```

For OS-tool tests:
- Add `"Open Coworker"` as the message → expect a `client-action` event with `kind:"os_open_app"`.
- Set `snapshot.locked: true` → expect no client-action and the agent verbally refusing.

For cowork-tool tests (requires `xo-cowork-api` running on 5002):
- `"Quick: call cowork_health and tell me if my workspace is up."` → expect a one-line health summary.
- `"Find my projects root via cowork_workspace_info, then list it."` → expect chained tool calls and a summary.
