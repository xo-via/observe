# Chat API — frontend integration guide

For frontends building on top of `xo-cowork-api`. Covers exact request/response shapes for every chat endpoint, the SSE wire format, retry/reconnect semantics, and edge cases.

**Base URL:** `http://${HOST:-localhost}:${PORT:-5002}`
**Auth:** none required for local-only access. xo-cowork-api itself talks to swarm via Bearer; chat endpoints currently have no auth gate.
**Content type:** `application/json` for POST bodies. SSE responses are `text/event-stream`.

---

## At a glance

```
┌────────────────────────┬──────────────────────────────────────────────────────┐
│ Endpoint               │ Purpose                                              │
├────────────────────────┼──────────────────────────────────────────────────────┤
│ POST /api/chat/prompt  │ Start a new turn or resume an existing session.       │
│                        │ Returns {stream_id, session_id}.                     │
│ GET  /api/chat/stream/ │ Open the SSE stream for a stream_id. Yields           │
│      {stream_id}        │ session-created → text-delta* → done.                 │
│ POST /api/chat/abort   │ Drop an in-flight stream by id.                       │
│ POST /api/chat/respond │ No-op stub (returns {ok:true}). Don't rely on it.     │
│                        │                                                      │
│ POST /ask_question     │ LEGACY non-stream. Returns full response in one shot.│
│ POST /ask_question_    │ LEGACY SSE. Different event shape from /api/chat/*.  │
│      streaming         │                                                      │
└────────────────────────┴──────────────────────────────────────────────────────┘
```

**Use `/api/chat/*` for everything new.** The `/ask_question*` pair is preserved for backward compatibility but uses a different event vocabulary, a different session model, and bypasses the project-tied sessions tree.

---

## 1. The two-step turn flow

A single chat turn is **always** two HTTP calls:

```
client                         /api/chat/prompt                  /api/chat/stream/{id}
  │                                  │                                  │
  │  POST text + (session_id?)       │                                  │
  ├─────────────────────────────────►│                                  │
  │                                  │ enqueue stream_info into          │
  │                                  │ active_streams[stream_id]         │
  │ {stream_id, session_id}          │                                  │
  │◄─────────────────────────────────│                                  │
  │                                  │                                  │
  │  GET (EventSource)                                                  │
  ├─────────────────────────────────────────────────────────────────────►│
  │                                                                     │
  │  ◄══════ event: session-created (only on a brand-new turn) ═════════│
  │  ◄══════ event: text-delta (many)                          ═════════│
  │  ◄══════ event: heartbeat (during long tool calls)         ═════════│
  │  ◄══════ event: done                                       ═════════│
  │  (server closes stream)                                              │
```

The split is intentional:
- `prompt` is a fast operation that reserves a `stream_id` and (for new sessions) starts the bootstrap. It can return a real `session_id` even before the model has produced any tokens.
- `stream` does the actual long-poll. The frontend can use the `session_id` from `prompt` to navigate to `/c/{session_id}` immediately; the SSE replay continues in parallel.

---

## 2. `POST /api/chat/prompt`

### 2.1 Request body

```jsonc
{
  // REQUIRED
  "text": "Refactor the auth flow to use the new Clerk SDK",   // string, trimmed; empty → 400

  // OPTIONAL — to resume an existing session
  "session_id": "f3b1c2d4-...",                                 // string. Omit for a new session.

  // OPTIONAL — to override backend selection
  "agent_name": "claude_code",                                  // "openclaw" | "claude_code"
                                                                // (or any future registered adapter)

  // OPTIONAL — to scope the new session to a project / Claude-Code agent
  "agent_id": "blackhole",                                      // matches a folder under
                                                                // ~/xo-projects/<agent_id>/

  // OPTIONAL — workspace path hint (alternative to agent_id; see §2.4)
  "workspace": "/Users/me/xo-projects/blackhole",               // absolute path

  // OPTIONAL — for non-openclaw adapters: skill / persona prefix
  "agent_type": "research",                                     // claude_code uses this to map
                                                                // to a /skill-name from
                                                                // config/agents/claude_code/commands.json

  // OpenClaw-specific (only honored when agent_name == "openclaw")
  "model": "openclaw/research"                                  // <prefix>/<oc_agent>; defaults to "main"
}
```

### 2.2 Backend selection logic

The server resolves which adapter handles this turn in this exact order:

```
1. body.agent_name           explicit override wins
2. body.session_id (if set)  → find_session_backend(session_id) scans:
                                  ~/xo-projects/<pid>/.xo/sessions/sessionslist.json
                                  ~/.openclaw/agents/<a>/sessions/sessions.json
                                returns "claude_code" or "openclaw" or None
3. AGENT_NAME env var        defaults to "openclaw"
```

If you're resuming an existing session, you can omit `agent_name` entirely and the backend is auto-detected.

### 2.3 `agent_id` resolution

If `agent_id` is missing AND it's a new session AND `workspace` is provided:

```
ws_path = Path(workspace).expanduser().resolve()
if   ws_path startswith ~/xo-projects/{X}/...   →  agent_id = X
elif ws_path startswith ~/claude-cowork/{X}/... →  agent_id = X
else                                             →  agent_id = None
```

For **OpenClaw**, `agent_id` becomes the `xo_agent_id` for the project transcript tee — it controls which `~/xo-projects/<pid>/.xo/sessions/sessionslist.json` gets the metadata write. If `None`, the OpenClaw turn still works but no project-side metadata is written (the gateway's own files remain the only record).

For **Claude Code**, `agent_id` is the project subfolder — the subprocess is spawned with `cwd = ~/xo-projects/<agent_id>/`.

### 2.4 Response

#### 200 OK

The shape is identical for all adapters:

```jsonc
{
  "stream_id":  "8f3a2b1c-...",     // UUID. Use for /api/chat/stream/{id} and /api/chat/abort.
  "session_id": "9d4e5f6a-..."      // UUID. The logical session id.
                                    // For new OpenClaw sessions: may be null (see below).
                                    // For new non-OpenClaw sessions: always populated.
                                    // For resumed sessions: equals the session_id you sent.
}
```

#### When `session_id` may be `null`

For **new OpenClaw sessions only**, `prompt` polls the gateway for up to 20 seconds (1s intervals) waiting for the session file to appear. If the gateway is slow, `session_id` may come back `null`. Recommended client behavior:

- Don't navigate to `/c/{session_id}` until you have a non-null id.
- Open the SSE stream anyway — the first `event: session-created` will carry the real id.
- All non-OpenClaw adapters generate the `session_id` synchronously, so this caveat doesn't apply to them.

#### 400 Bad Request

```json
{ "detail": "Empty message" }
```

Triggered when `text` is missing or whitespace-only after trim.

#### 404 Not Found

```json
{ "detail": "Session not found" }
```

Only returned for OpenClaw resume when `find_session_key(session_id)` finds no matching record. Other adapters don't validate session existence at prompt time — invalid session ids surface later as adapter errors during streaming.

### 2.5 Lifecycle of `stream_id`

The `stream_id` returned by `prompt` lives in an in-memory dict (`active_streams`) until either:

- `GET /api/chat/stream/{stream_id}` consumes it (most common), **or**
- `POST /api/chat/abort` drops it explicitly, **or**
- The server process restarts (in-memory only; no persistence)

There is **no TTL** on unconsumed entries. A frontend that calls `prompt` and never opens the stream leaks an entry. Cleanup happens implicitly on consumption.

---

## 3. `GET /api/chat/stream/{stream_id}`

### 3.1 Response headers

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` disables Nginx-level buffering; required for real-time delivery if a proxy is in front.

### 3.2 Event vocabulary

```
event: session-created
data:  {"session_id":"<uuid>"}

event: text-delta
data:  {"text":"<partial text>","session_id":"<uuid>"}        ← OpenClaw includes session_id
data:  {"text":"<partial text>"}                               ← non-OpenClaw omits session_id

event: heartbeat
data:  {}                                                       ← every 15–20s of silence

event: agent-error
data:  {"error_message":"<human readable>"}

event: done
data:  {"finish_reason":"stop","session_id":"<uuid>"}

event: error
data:  {"error_message":"Stream not found"}                    ← only on bad/expired stream_id
```

Every line uses standard SSE framing: `id: <int>\nevent: <name>\ndata: <json>\n\n`. The `id:` field is not strictly required by the frontend but is monotonic per stream and useful for debugging logs.

### 3.3 Event order

```
─── normal new-session turn ──────────────────────────────────────
[session-created]    once at start, before any text-delta
[text-delta]         many, accumulate to form the assistant message
[heartbeat]*         interleaved during silent gaps (tool calls etc.)
[done]               once at the end; server closes the stream

─── normal resume turn ──────────────────────────────────────────
[text-delta]+
[heartbeat]*
[done]

─── error path ──────────────────────────────────────────────────
(maybe a few text-delta first)
[agent-error]        terminal — server closes after this; no [done] follows
```

### 3.4 Concrete example trace

A typical 3-token response:

```
id: 1
event: session-created
data: {"session_id":"9d4e5f6a-1234-4567-89ab-cdef01234567"}

id: 2
event: text-delta
data: {"session_id":"9d4e5f6a-...","text":"Sure"}

id: 3
event: text-delta
data: {"session_id":"9d4e5f6a-...","text":", I can"}

id: 4
event: text-delta
data: {"session_id":"9d4e5f6a-...","text":" do that."}

event: heartbeat
data: {}

id: 5
event: done
data: {"finish_reason":"stop","session_id":"9d4e5f6a-..."}
```

### 3.5 Heartbeat semantics

Two different heartbeat cadences depending on backend:

| Backend | Interval | When it fires |
|---|---|---|
| OpenClaw direct (`stream_openclaw_to_sse`) | 15 s | No `data:` line received from gateway |
| OpenClaw new-session prefetch (`emit_prefetched_sse`) | 15 s | Bootstrap task still running |
| Non-OpenClaw via dispatcher | 20 s | No event from adapter generator |

Frontends should treat heartbeat as a no-op keepalive and reset their own dead-stream timer on receipt. **Don't** parse `data: {}` as any kind of token. Recommended client-side dead-stream timeout: ≥45 s (3× the longest interval).

### 3.6 React Strict Mode / double-mount safety

If the client opens the stream, navigates away, and re-opens it within 600 seconds, the second `GET /api/chat/stream/{stream_id}` does NOT start a new turn. Instead the server enters **reconnect mode**:

```
1. The first GET pops `stream_info` from active_streams and starts a producer task.
2. A bookkeeping entry lands in `_recently_started[stream_id]` with a `done_event`.
3. A second GET on the same stream_id finds active_streams empty but
   _recently_started populated.
4. It waits (up to 300s) on done_event.
5. Once the original turn finishes, it emits:
     event: session-created  data: {"session_id":...}
     event: done             data: {"session_id":...}
6. The frontend should refetch messages from /api/messages/{session_id} —
   no text-delta events are replayed.
```

This means **a second GET on the same stream_id is non-destructive**. Use this for React Strict Mode double-mounts without worrying about duplicate tokens.

After 600 seconds (`_RECENTLY_STARTED_TTL`), the bookkeeping entry is purged; subsequent GETs return:

```
event: error
data: {"error_message":"Stream not found"}
```

**Reconnect `done` is shaped differently.** The reconnect path emits:

```
event: done
data: {"session_id":"..."}
```

— **without** the `finish_reason` field that normal-path `done` events carry. If your client's `done` handler treats `finish_reason` as required, it will see `undefined` after a reconnect. The `id:` numbering on the reconnect events is also hardcoded (`id: 1` for `session-created`, `id: 2` for `done`) rather than monotonic from the original stream.

### 3.7 Errors the stream itself can emit

| `event:` | Meaning | Continues? |
|---|---|---|
| `error` | `stream_id` unknown or expired | No — server closes immediately |
| `agent-error` | The runtime (Claude/OpenClaw gateway) returned an error mid-turn | No — server closes; no `done` follows |

Recommended handling:

```typescript
const es = new EventSource(`/api/chat/stream/${streamId}`);

es.addEventListener("session-created", (e) => {
  const { session_id } = JSON.parse(e.data);
  if (!currentSessionId) router.push(`/c/${session_id}`);
});

es.addEventListener("text-delta", (e) => {
  const { text } = JSON.parse(e.data);
  appendToAssistantMessage(text);
});

es.addEventListener("heartbeat", () => {
  resetDeadStreamTimer();
});

es.addEventListener("agent-error", (e) => {
  const { error_message } = JSON.parse(e.data);
  showErrorBanner(error_message);
  es.close();
});

es.addEventListener("error", (e) => {
  // Either: native EventSource error (network), OR
  //         our custom event:error (stream_id unknown).
  // Distinguish by checking if e.data exists.
  if ((e as MessageEvent).data) {
    const { error_message } = JSON.parse((e as MessageEvent).data);
    if (error_message === "Stream not found") {
      // Stream expired — refetch messages from /api/messages/{id}
    }
  }
  es.close();
});

es.addEventListener("done", (e) => {
  const { session_id } = JSON.parse(e.data);
  finalizeAssistantMessage();
  es.close();
});
```

`EventSource` automatically reconnects on network drops; that reconnect hits the recently-started path in §3.6 and emits a graceful `done`.

---

## 4. `POST /api/chat/abort`

### Request

```jsonc
{ "stream_id": "8f3a2b1c-..." }
```

### Response

```json
{ "ok": true }
```

Always 200, even if the `stream_id` is unknown — the call is a best-effort drop. The handler simply does `active_streams.pop(stream_id, None)`.

### What abort actually does

- **Removes** the entry from `active_streams`. A subsequent `GET /api/chat/stream/{id}` with the same id will return `event: error data: {"error_message":"Stream not found"}` (unless reconnect-mode applies).
- **Does NOT** kill an in-flight runtime subprocess or HTTP call. If the SSE stream has already been opened, the underlying generator continues running until the runtime completes; the frontend's `EventSource.close()` is what stops bytes from being delivered to the client.
- **Does NOT** cancel the OpenClaw bootstrap task for new sessions. The task continues and writes its session metadata to disk regardless.

So `abort` is best understood as "client-side intent to forget about this stream." It's safe to call from `useEffect` cleanup, navigation handlers, or after errors.

---

## 5. `POST /api/chat/respond`

```jsonc
// request: any JSON body
// response:
{ "ok": true }
```

Stub. Currently a no-op. Don't depend on it. It exists to reserve the route for a future "agent response back to user" endpoint.

---

## 6. Legacy `/ask_question` endpoints

These predate the `/api/chat/*` design. They use a different event format, a `project_name` (not `session_id`) keyed session model, and bypass the project-tied sessions tree. **Don't use these for new code.**

### 6.1 `POST /ask_question` (non-streaming)

#### Request body

```jsonc
{
  "project_name": "my-project",        // string — this is the session key, NOT a path
  "question":     "Hello",             // string
  "user_id":      "user_2bX9...",      // optional, default "default_user"
  "message_type": "@xo",               // optional, default "@xo" — used by save_chat_messages
  "agent_type":   "debug-tool"         // optional, becomes /{agent_type} skill prefix for Claude
}
```

#### Response (200)

```jsonc
{
  "id":              null,                          // always null
  "message":         "Hello! How can I help...",   // full assistant text
  "project_id":      "my-project",
  "user_id":         "user_2bX9...",
  "session_id":      "9d4e5f6a-...",                // UUID; persisted in session_store on success
  "is_new_session":  true,                          // bool: was this the first turn for project_name?
  "timestamp":       "2026-05-10T12:34:56.789012"
}
```

#### Response (500)

```json
{
  "detail": { "error": "Failed to process question: <traceback root cause>" }
}
```

#### Side effects

- On success, stores `session_store[project_name] = session_id`. Subsequent calls with the same `project_name` resume the session.
- Calls `save_chat_messages` which posts the `(user_message, agent_response)` pair to `xo-swarm-api`'s `/chat/add_message` endpoint with the workspace's stored Bearer token. **No project-side `.xo/sessions/sessionslist.json` write happens for this path** — it's the legacy single-tenant model.

### 6.2 `POST /ask_question_streaming` (SSE)

Same request body as `/ask_question`. Returns SSE with these unkeyed events:

```
data: {"type":"token","token":"<partial text>"}

data: {"type":"error","error":"<message>"}

data: {"done":true}

data: {"error":"<exception message>"}
```

Note the difference from `/api/chat/stream/*`:

- **No `event:` prefix** — only `data:`. Frontends using `EventSource` need to listen on `onmessage` (the default channel), not specific named events.
- The "done" payload is `{"done":true}`, not `{"finish_reason":"stop","session_id":...}`.
- The "error" payload uses `error` key, not `error_message`.
- No `heartbeat` events at all. Stream is silent during long gaps.
- No `session-created` event — the session id is not surfaced through SSE; the client must already have it (via prior `/sessions` endpoint or its own state).

#### Side effects

- Same `session_store` and `save_chat_messages` behavior as `/ask_question`, but **only on successful completion**. If the stream errors mid-flight, neither the session id is stored nor the message is persisted to swarm.

### 6.3 Why these still exist

Keep using these only if:

- You're building against an older backend that doesn't have `/api/chat/*`.
- You explicitly want the swarm-side `add_message` write (the new path doesn't do that).
- You don't need session-tied projects on disk.

Anything new should use `/api/chat/*`.

---

## 7. Pitfalls / FAQ

**Q: My `text-delta` event has no `session_id` field for some sessions.**
A: Only OpenClaw includes `session_id` inside `text-delta` data. Non-OpenClaw adapters omit it because the same `session_id` is announced once via `event: session-created` and via the `done` payload. Track it in the client.

**Q: I get duplicate text after navigating away and back.**
A: You're probably not closing the previous `EventSource`. The reconnect mode in §3.6 only avoids duplicates if both opens are against the same `stream_id`. If the frontend issues a fresh `POST /api/chat/prompt` on remount, that's a new turn — abort the old `stream_id` first.

**Q: Can I call `/api/chat/prompt` twice on the same session_id concurrently?**
A: Don't. Each adapter assumes serial turns per session. The behavior is undefined.

**Q: How do I cancel a turn that's mid-flight?**
A: Close the EventSource client-side (stops byte delivery) and POST `/api/chat/abort` with the stream_id (drops the bookkeeping entry). The runtime subprocess / HTTP call cannot currently be killed mid-turn — it will run to completion server-side.

**Q: Does `/api/chat/prompt` validate that `text` fits a token budget?**
A: No. It just trims whitespace and rejects empty strings. The adapter / runtime will surface budget errors via `agent-error` mid-stream.

**Q: What's the `user_id` in `agent-error` payloads?**
A: There isn't one. The current API has no per-user identity at the chat layer — that lives in `/xo-auth/whoami`. If you need to attribute errors, log them client-side with the user context you already have.

**Q: How do I get the message history for a session_id?**
A: Use `GET /api/messages/{session_id}` (separate endpoint, not part of this doc). It reads native runtime JSONL and returns a normalized message list.

---

## 8. Quick reference

| Verb | Path | Use |
|---|---|---|
| `POST` | `/api/chat/prompt` | Start/resume a turn |
| `GET` | `/api/chat/stream/{stream_id}` | Open SSE stream |
| `POST` | `/api/chat/abort` | Drop a stream by id |
| `POST` | `/ask_question` | Legacy non-stream — avoid |
| `POST` | `/ask_question_streaming` | Legacy SSE — avoid |

| SSE event | Payload | Meaning |
|---|---|---|
| `session-created` | `{"session_id":"..."}` | Once per new turn, before any text |
| `text-delta` | `{"text":"...","session_id"?}` | Partial assistant text — accumulate |
| `heartbeat` | `{}` | Keepalive — ignore content, reset timeout |
| `agent-error` | `{"error_message":"..."}` | Terminal error mid-turn |
| `done` | `{"finish_reason":"stop","session_id":"..."}` | Turn complete |
| `error` | `{"error_message":"Stream not found"}` | Bad/expired stream_id |
