# xo-cowork-api architecture (current state)

Snapshot of `development @ a0269f7` (2026-05-12). This doc reflects what's *actually shipped*, not the future plan. For the future direction see [`visualizer-and-sync-plan.md`](visualizer-and-sync-plan.md).

**Delta since prior snapshot (`25cc0ab`):** one PR (#33) expanded the Google Drive connector with four new endpoints (`mkdir`, `folders`, `rmdir`, `upload`) and narrowed the OAuth scope from `drive` to `drive.file` — see §4 below and [`frontend-connectors-api.md`](frontend-connectors-api.md). OneDrive was deliberately NOT updated in parallel; the new folder/upload surface is gdrive-only for now.

---

## 1. What it is, in one paragraph

A Python 3.12 FastAPI app on port 5002 that the Cowork desktop UI talks to locally. It does five things, in order of how mature they are:

1. **Brokers chat** to a local coding runtime — Claude Code or OpenClaw — through a pluggable adapter layer (`AgentDispatcher` + `BaseAgentAdapter`).
2. **Manages auth** between the workspace and the cloud `xo-swarm-api` (Clerk poll-token flow).
3. **Owns the `~/xo-projects/` tree** — every project is a folder with the canonical layout (`AGENTS.md`, `PROJECT.md`, `OBJECTIVES.md`, `PLAN.md`, `PROGRESS.md`, `memory/{semantic,episodic,procedural,working}/`, `.xo/`). Sessions are project-tied via metadata, message content stays in the runtime's own storage.
4. **Wires connectors** (Google Drive, OneDrive, GitHub, Vercel, Manus) so agents can reach external systems.
5. **Reports unified usage** (`/api/usage`) by reading both Claude Code and OpenClaw native JSONL.

**The big architectural rule:** the project folder is sharing-safe by construction. Chat content is never written into it. `~/xo-projects/<pid>/` carries only metadata + project documents; messages live in `~/.claude/projects/...` or `~/.openclaw/agents/...`.

---

## 2. Top-level layout

```
xo-cowork-api/
│
├── server.py                              FastAPI app — lifespan, CORS, routers, legacy /ask_question*
├── claude_code_client.py                  LEGACY chat client — only /ask_question* uses it
├── codex_code_client.py                   LEGACY chat client — only /ask_question* uses it
│
├── routers/                               ◄── HTTP surface
│   ├── auth.py                            /xo-auth/*  — Clerk poll-token + token store
│   ├── claude_setup_token.py              /claude/*   — Claude CLI OAuth bootstrap
│   ├── codex_setup.py                     /codex/*    — Codex device-auth + openclaw.json upsert
│   ├── openclaw_usage.py                  /openclaw/usage/*  — telemetry
│   │
│   └── cowork_agent/                      ◄══ THE COWORK AGENT, ROUTE LAYER
│       ├── chat.py                        /api/chat/*           prompt + SSE stream + abort
│       ├── sessions.py                    /api/sessions/*       list/search/get/patch + messages
│       ├── agents.py                      /api/agents/*         openclaw.json CRUD
│       ├── config.py                      /api/config/*         provisioning, models, /config/workspace
│       ├── files.py                       /api/files/*          upload, list, content, save, mkdir(scaffold)
│       ├── secrets.py                     /api/secrets/env*     ~/.openclaw/.env CRUD
│       ├── channels.py                    /api/channels/*       Slack/Telegram/Discord tokens
│       ├── workspace_memory.py            /api/workspace-memory (stub)
│       ├── fts.py                         /api/fts/*            (stub)
│       ├── usage.py                       /api/usage            ⭐ unified across runtimes (rewritten)
│       ├── misc.py                        /api/tools, /skills, /chat/active, /mcp/status, /codex/status, …
│       ├── onboarding.py                  /api/onboarding/*
│       ├── gdrive.py                      /api/connectors/gdrive/*
│       ├── onedrive.py                    /api/connectors/onedrive/*
│       ├── github.py                      /api/connectors/github/*  (incl. ⭐ /cli/* device flow)
│       ├── vercel.py                      /api/connectors/vercel/*  (incl. ⭐ DCR + /callback)
│       └── manus.py                       /api/connectors/manus/*
│
├── services/
│   ├── usage_sync.py                      daily background → POST /usage/report on swarm
│   │
│   └── cowork_agent/                      ◄══ THE COWORK AGENT, LOGIC LAYER
│       ├── dispatcher.py                  AgentDispatcher (what routers import for chat)
│       ├── adapter_registry.py            {"openclaw": …, "claude_code": …}
│       ├── adapters/
│       │   ├── base.py                    BaseAgentAdapter abstract
│       │   ├── openclaw/
│       │   │   ├── adapter.py             OpenclawAdapter — HTTP gateway transport
│       │   │   ├── streaming.py           OpenAI-SSE → normalized events (+ tee_exchange call)
│       │   │   ├── transcript.py          ⭐ NEW — tee_exchange(): write project-side metadata
│       │   │   └── usage.py               OpenClaw usage parser
│       │   └── claude_code/
│       │       ├── adapter.py             ClaudeCodeAdapter — `claude` subprocess, writes
│       │       │                            xo-projects/<pid>/.xo/sessions/sessionslist.json
│       │       └── streaming.py           JSONL stdout → normalized events
│       │
│       ├── streaming.py                   OpenClaw "direct" streaming path (project-tied)
│       ├── chat_state.py                  in-memory active_streams dict
│       ├── sessions_io.py                 ⭐ rewritten — cross-runtime project-tied lookup
│       ├── messages.py                    ⭐ NEW — convert native JSONL → frontend message shape
│       ├── claude_sessions.py             Claude session helpers (some legacy paths still read)
│       │
│       ├── project_layout.py              ⭐ NEW — owns ~/xo-projects/ canonical layout
│       ├── project_template/              ⭐ NEW — bundled scaffold (copied on /api/files/mkdir)
│       │   ├── AGENTS.md, CLAUDE.md, PROJECT.md, OBJECTIVES.md, PLAN.md, PROGRESS.md
│       │   ├── memory/{semantic,episodic,procedural,working}/
│       │   └── .xo/{project,todos,stats,timeline,sync,peers,activity}.json
│       │       + .xo/sessions/sessionslist.json
│       │
│       ├── agent_registry.py              AgentManifest loader (config/agents/*/commands.json)
│       ├── settings.py                    path/env resolution, load_agent_config
│       ├── helpers.py                     pure utils (path safety, JSONL, redaction, title derivation)
│       ├── xo_cowork_state.py             ~/.xo-cowork/state.json (onboarding etc.)
│       │
│       ├── openclaw_env.py                ~/.openclaw/.env parser (deprecated wrapper)
│       ├── openclaw_store.py              ~/.openclaw/openclaw.json CRUD
│       │
│       ├── gdrive_rclone.py               Google Drive via rclone subprocess + OAuth
│       ├── onedrive_rclone.py             OneDrive via rclone subprocess + OAuth
│       ├── rclone_oauth_lock.py           single-flight lock on port :53682
│       ├── github_connector.py            GitHub PAT validation
│       ├── github_cli_auth.py             ⭐ NEW — `gh auth login` device-code flow
│       ├── vercel_connector.py            Vercel OAuth (PKCE) + REST + ⭐ DCR self-registration
│       └── manus_connector.py             Manus API
│
├── config/
│   └── agents/
│       ├── openclaw/{commands,settings}.json
│       └── claude_code/{commands,settings}.json
│
├── utils/{__init__,commands}.py           tiny shared helpers
│
├── docs/                                  gitignored (.gitignore:58)
│   └── (this file + the others)
│
├── cowork-api.sh                          start|stop|restart|status|logs (PID file in /tmp)
├── cowork-update.sh                       git pull + restart in background
├── openclaw.sh                            installs/launches OpenClaw gateway on :18789
├── hermes.sh                              hermes config setup
│
├── Dockerfile                             python:3.12-slim, runs python server.py
├── requirements.txt                       fastapi, uvicorn, pydantic, httpx, dotenv, …
└── .env.example                           full env reference (XO_PROJECTS_ROOT etc.)
```

---

## 3. Component diagram (logical view)

```
                   ┌──────────────────────────────────────────────┐
                   │              xo-cowork (Tauri UI)            │
                   │    talks only to localhost on this box       │
                   └────────────────────────┬─────────────────────┘
                                            │ HTTP/SSE :5002
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          xo-cowork-api  (FastAPI :5002)                              │
│                                                                                      │
│  ┌──────────────────────┐      ┌──────────────────────────────────────────────┐    │
│  │ Top-level routers    │      │             routers/cowork_agent/*            │    │
│  │  /xo-auth/*          │      │                                                │    │
│  │  /claude/*           │      │  chat   sessions   agents   config   files   │    │
│  │  /codex/*            │      │  secrets channels usage onboarding  misc      │    │
│  │  /openclaw/usage/*   │      │  workspace-memory  fts                         │    │
│  └──────────┬───────────┘      │  gdrive  onedrive  github  vercel  manus       │    │
│             │                  └──────┬───────────────────────┬─────────────────┘    │
│             │                         │                       │                       │
│             │                         ▼                       ▼                       │
│             │       ┌────────────────────────┐   ┌────────────────────────────┐    │
│             │       │   AgentDispatcher       │   │  Connector services         │    │
│             │       │   (dispatcher.py)        │   │                              │    │
│             │       └────┬─────────┬──────────┘   │  gdrive_rclone               │    │
│             │            │         │              │  onedrive_rclone             │    │
│             │            ▼         ▼              │  github_connector            │    │
│             │     ┌─────────┐  ┌────────┐         │  github_cli_auth             │    │
│             │     │openclaw │  │claude_ │         │  vercel_connector            │    │
│             │     │adapter  │  │code    │         │  manus_connector             │    │
│             │     │         │  │adapter │         │  rclone_oauth_lock           │    │
│             │     └────┬────┘  └────┬───┘         └────────────┬─────────────────┘    │
│             │          │            │                          │                       │
│             ▼          ▼            ▼                          ▼                       │
│  ┌──────────────┐ ┌───────────┐ ┌────────────────────┐ ┌──────────────────────────┐ │
│  │ in-memory    │ │ OpenClaw  │ │ `claude` CLI         │ │ rclone, gh, GitHub API,  │ │
│  │ auth_state,  │ │ HTTP      │ │ subprocess           │ │ Vercel API, Manus API    │ │
│  │ active_      │ │ gateway   │ │                      │ │                          │ │
│  │ streams      │ │ :18789    │ │                      │ │                          │ │
│  └──────────────┘ └─────┬─────┘ └────────┬─────────────┘ └────────────┬─────────────┘ │
│                         │                │                            │               │
│                  writes JSONL     writes JSONL                  writes credentials    │
│                         ▼                ▼                            ▼               │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                        On-disk state                                          │    │
│  │  ~/.openclaw/agents/<a>/sessions/<sid>.jsonl   (chat content)                 │    │
│  │  ~/.claude/projects/<encoded>/<sid>.jsonl       (chat content)                │    │
│  │                                                                                │    │
│  │  ~/xo-projects/<pid>/                                                         │    │
│  │    ├── AGENTS.md, PROJECT.md, OBJECTIVES.md, PLAN.md, PROGRESS.md            │    │
│  │    ├── memory/{semantic,episodic,procedural,working}/                        │    │
│  │    └── .xo/                                                                   │    │
│  │        ├── project.json    sessions/sessionslist.json   ← only metadata        │    │
│  │        ├── todos.json  stats.json  timeline.jsonl  activity.json             │    │
│  │        └── sync.json   peers.json   ← schema templates only, not yet          │    │
│  │                                                            populated by code   │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────┬─────────────────────────────────────────────────┘
                                     │ Bearer (XO_API_KEY or consumed token)
                                     ▼
                          ┌──────────────────────┐
                          │   xo-swarm-api       │
                          │ /auth/browser/*,     │
                          │ /get-user-id,        │
                          │ /chat/add_message,   │
                          │ /chat/get_messages,  │
                          │ /usage/report        │
                          └──────────────────────┘
```

---

## 4. Routes — the full inventory (~85 endpoints)

### Platform / setup

```
POST   /xo-auth/start                          start browser auth (forwards to swarm)
GET    /xo-auth/status/{auth_session_id}       poll auth state
POST   /xo-auth/consume                        exchange poll_token for access_token
GET    /xo-auth/whoami                         GET swarm /get-user-id w/ Bearer
GET    /xo-auth/state                          local auth_state inspection
POST   /xo-auth/logout                         clear auth_state

POST   /claude/setup-token                     start Claude CLI OAuth
POST   /claude/setup-token/callback            OAuth callback

POST   /codex/setup                            Codex device-auth + openclaw.json upsert

GET    /openclaw/usage/analytics               raw analytics
GET    /openclaw/usage/summary                 summary
GET    /openclaw/usage/summary/card            summary card
GET    /openclaw/usage/sessions                per-session
GET    /openclaw/usage/sessions/{session_id}   one session
```

### Chat

```
POST   /api/chat/prompt                        new/resume turn → {stream_id, session_id}
GET    /api/chat/stream/{stream_id}            SSE: text-delta / done / heartbeat /
                                                     agent-error / session-created
POST   /api/chat/abort                         drop active stream
POST   /api/chat/respond                       (no-op stub)

POST   /ask_question                           legacy non-stream (uses ClaudeCodeClient)
POST   /ask_question_streaming                 legacy SSE      (uses ClaudeCodeClient)
```

### Sessions / messages

```
GET    /api/sessions                           list across xo-projects + openclaw native
GET    /api/sessions/search?q=                 substring on title
GET    /api/sessions/{id}                      read one
POST   /api/sessions                           stub uuid (real creation = /chat/prompt)
PATCH  /api/sessions/{id}                      update directory binding
DELETE /api/sessions/{id}                      stub: ok
GET    /api/sessions/{id}/todos                stub: []
GET    /api/sessions/{id}/files                stub: []
GET    /api/messages/{id}                      JSONL read from native runtime path
                                                  (claude → ~/.claude/projects/<encoded>)
                                                  (openclaw → ~/.openclaw/agents/<a>/sessions)
```

### Agents / config / models

```
GET    /api/agents                             list openclaw.json agents
POST   /api/agents                             create
GET    /api/agents/{id}                        read
PATCH  /api/agents/{id}                        update

GET    /api/models                             models from active manifest
GET    /api/config/api-key                     active provider info
GET    /api/config/providers                   provider list (currently empty)
POST   /api/config/providers/{provider_id}/key provision provider key (line-level upsert)
GET    /api/config/openai-subscription
GET    /api/config/openyak-account
GET    /api/config/ollama
GET    /api/config/local
GET    /api/config/openclaw                    masked openclaw.json
GET    /api/config/workspace                   { roots: { backend: xo-projects-root }, default }
                                                ↑ what the frontend reads to know where to create projects
```

### Files (with project-aware scaffold)

```
POST   /api/files/upload                       multipart, 100 MB cap, sha256 dedupe
POST   /api/files/list-directory               iterdir clamped to $HOME
POST   /api/files/content                      read text
POST   /api/files/content-binary               FileResponse download
POST   /api/files/save                         write text
POST   /api/files/mkdir                        create dir;
                                                if scaffold:true → must be direct child of
                                                xo_projects_root(); copies project_template/
                                                tree; idempotent fill-in
```

### Secrets / memory / fts / usage / misc / onboarding / channels

```
GET    /api/secrets/env                        load_env_entries (with values)
GET    /api/secrets/env/keys                   names only
PUT    /api/secrets/env                        overwrite .env

GET    /api/workspace-memory                   stub
GET    /api/workspace-memory/list              stub
PUT    /api/workspace-memory                   stub
DELETE /api/workspace-memory                   stub
POST   /api/workspace-memory/refresh           stub
POST   /api/workspace-memory/export            stub

GET    /api/fts/index/{workspace:path}         stub: idle
POST   /api/fts/index/{workspace:path}         stub: idle

GET    /api/usage?days=30                      ⭐ unified usage across OpenClaw + Claude Code
                                                  (returns the UsageStats shape the frontend
                                                  expects — total_cost, by_model, by_session,
                                                  daily series, response_time percentiles)

GET    /api/tools                              [] (stub)
GET    /api/skills                             [] (stub)
GET    /api/chat/active                        [] (stub)
GET    /api/mcp/status                         stub
GET    /api/connectors                         stub
GET    /api/channels                           stub
GET    /api/automations                        stub
GET    /api/plugins/status                     stub
GET    /api/ollama/status                      stub
GET    /api/channels/openclaw/status           OpenClaw channel status
GET    /api/codex/status                       Codex auth/status

GET    /api/onboarding                         onboarding state from ~/.xo-cowork/state.json
POST   /api/onboarding/complete                persist completion

POST   /api/channels/add                       Slack/Telegram/Discord token write
```

### Connectors

```
gdrive
  GET    /api/connectors/gdrive/remotes
  POST   /api/connectors/gdrive/remotes
  GET    /api/connectors/gdrive/sessions/{session_id}
  DELETE /api/connectors/gdrive/remotes/{name}
  POST   /api/connectors/gdrive/sessions/{session_id}/cancel
  POST   /api/connectors/gdrive/sessions/{session_id}/submit
  POST   /api/connectors/gdrive/remotes/{name}/mkdir           ⭐ NEW (#33) — create folder
  GET    /api/connectors/gdrive/remotes/{name}/folders         ⭐ NEW (#33) — list top-level folders
  POST   /api/connectors/gdrive/remotes/{name}/rmdir           ⭐ NEW (#33) — purge folder
  POST   /api/connectors/gdrive/remotes/{name}/upload          ⭐ NEW (#33) — stream upload (≤500 MiB)

onedrive  (mirror of the original six gdrive routes; does NOT yet have the four NEW
           folder/upload endpoints — gdrive-only for now)

github
  POST   /api/connectors/github/token
  GET    /api/connectors/github/status
  POST   /api/connectors/github/disconnect
  POST   /api/connectors/github/reconnect
  POST   /api/connectors/github/cli/start          ⭐ gh device flow
  POST   /api/connectors/github/cli/poll           ⭐
  POST   /api/connectors/github/cli/cancel         ⭐

vercel
  POST   /api/connectors/vercel/token
  GET    /api/connectors/vercel/status
  POST   /api/connectors/vercel/disconnect
  POST   /api/connectors/vercel/reconnect
  GET    /api/connectors/vercel/oauth/start
  POST   /api/connectors/vercel/oauth/exchange
  GET    /callback                                  vercel OAuth callback
  GET    /.well-known/oauth-protected-resource     ⭐ Dynamic Client Registration

manus
  POST   /api/connectors/manus/token
  GET    /api/connectors/manus/status
  POST   /api/connectors/manus/disconnect
  POST   /api/connectors/manus/reconnect
```

### Server-direct

```
GET    /                                        info
GET    /health                                  health
GET    /debug/ai-auth                           debug
GET    /sessions                                legacy session_store dump
DELETE /sessions/{project_id}                   legacy session_store delete
POST   /gateway/restart                         restart OpenClaw gateway
POST   /app/restart                             restart cowork-api itself
POST   /app/update                              git pull + restart
```

---

## 5. The adapter layer — how `/api/chat/*` works

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  routers/cowork_agent/chat.py    POST /api/chat/prompt                          │
│                                                                                  │
│  1. body.agent_name             ────► explicit override                         │
│  2. body.session_id (existing)  ────► find_session_backend(session_id)          │
│                                       scans:                                    │
│                                       - ~/xo-projects/*/.xo/sessions/sessionslist│
│                                       - ~/.openclaw/agents/*/sessions/sessions  │
│  3. fallback: env AGENT_NAME (default "openclaw")                               │
│                                                                                  │
│  4. resolve agent_id from body.agent_id OR body.workspace hint                  │
│     (if path is under xo-projects/<x>, agent_id := x)                           │
│                                                                                  │
│  if agent_name == "openclaw":  → direct streaming path (chat.py inline)         │
│                                  → tee_exchange writes project-side metadata    │
│                                  → message JSONL stays in ~/.openclaw/agents/   │
│  else:                          → AgentDispatcher path (queue-based SSE)        │
└──────────────────────┬───────────────────────────────────────────────────┬─────┘
                       │                                                    │
                       │ openclaw                                           │ claude_code, ...
                       ▼                                                    ▼
       ┌─────────────────────────────────────┐          ┌──────────────────────────────────────┐
       │  services/cowork_agent/             │          │  AgentDispatcher (dispatcher.py)     │
       │  streaming.py                        │          │   ├─ load_agent_config(name)         │
       │   ├─ create_new_session              │          │   ├─ get_adapter(name, config)       │
       │   ├─ emit_prefetched_sse             │          │   └─ adapter.stream(question, ...)   │
       │   └─ stream_openclaw_to_sse          │          │                                      │
       │                                      │          │  _dispatcher_sse in chat.py wraps    │
       │  Posts to OPENCLAW_API_URL           │          │  it with a producer-task + Queue     │
       │  with X-OpenClaw-Session header      │          │  to keep heartbeat from corrupting   │
       │                                      │          │  the generator. Translates to named  │
       │  After turn:                          │          │  SSE events: text-delta /            │
       │   adapters/openclaw/transcript.py    │          │  session-created / agent-error /     │
       │   tee_exchange() writes              │          │  done / heartbeat.                   │
       │   <pid>/.xo/sessions/sessionslist.json│         │                                      │
       └─────────────────────────────────────┘          └──────────────────┬───────────────────┘
                                                                            │
                                                                            ▼
                                                    ┌─────────────────────────────────────┐
                                                    │   adapter_registry.get_adapter      │
                                                    │   {                                 │
                                                    │     "openclaw":    OpenclawAdapter, │
                                                    │     "claude_code": ClaudeCodeAdapter│
                                                    │   }                                 │
                                                    └────────────┬────────────────────────┘
                                                                 │
                                                                 ▼
                                                    ┌──────────────────────────────────┐
                                                    │  ClaudeCodeAdapter.stream()       │
                                                    │   spawns `claude --output-format │
                                                    │     stream-json -p "{prompt}"`    │
                                                    │   parses JSONL stdout             │
                                                    │   writes preliminary entry to     │
                                                    │     <pid>/.xo/sessions/           │
                                                    │     sessionslist.json before      │
                                                    │     subprocess starts (so any     │
                                                    │     mid-stream poll resolves)     │
                                                    │   writes nativeSessionId on       │
                                                    │     completion                    │
                                                    │   message JSONL stays in          │
                                                    │     ~/.claude/projects/<encoded>/ │
                                                    └──────────────────────────────────┘
```

**Adding a new runtime:** subclass `BaseAgentAdapter`, implement `run/stream/sessions_root/adapter_name`, register in `_REGISTRY`, drop a `commands.json`/`settings.json` in `config/agents/<name>/`. Routers don't change.

---

## 6. State on disk

### What cowork-api owns and writes

```
~/xo-projects/                              ⭐ canonical projects root
                                            (configurable: XO_PROJECTS_ROOT env var)
└── <project_id>/                           any folder here with .xo/ inside is a project
    ├── AGENTS.md                           ⊕ scaffolded from project_template
    ├── CLAUDE.md                           ⊕ "@AGENTS.md"
    ├── PROJECT.md                          ⊕ scope/audience/stack
    ├── OBJECTIVES.md                       ⊕ OKRs
    ├── PLAN.md                             ⊕ current plan
    ├── PROGRESS.md                         ⊕ append-only narrative
    ├── memory/
    │   ├── semantic/{preferences,project-facts,constraints}.md
    │   ├── episodic/                       ⊕ scaffolded with README
    │   ├── procedural/                     ⊕ scaffolded with README
    │   └── working/                        ⊕ session scratchpad
    └── .xo/                                ⊕ backend-owned (per skill doc)
        ├── project.json                    {pid, name, owner_user_id, created_at,
        │                                     _template:true initially}
        ├── sessions/sessionslist.json      ⭐ per-session metadata (NOT messages):
        │                                     {sessionId, nativeSessionId, directory,
        │                                      backend: "claude_code"|"openclaw",
        │                                      updatedAt, usage:{...}}
        ├── todos.json                      ⚠ template only — no watcher writes yet
        ├── stats.json                      ⚠ template only — no watcher writes yet
        ├── timeline.jsonl                  ⚠ template only — no watcher writes yet
        ├── activity.json                   ⚠ template only — no watcher writes yet
        ├── sync.json                       ⚠ template only — Phase 1 sync not built
        └── peers.json                      ⚠ template only — Phase 1 sync not built

~/.xo-cowork/                               machine-local UI state
├── state.json                              onboarding_completed, etc.
└── github_token.json                       cached gh CLI token

~/.openclaw/                                OpenClaw runtime home (existing read+write)
├── openclaw.json                           agent registry (CRUD via /api/agents)
├── .env                                    provider/channel secrets
└── agents/<a>/sessions/
    ├── sessions.json                       openclaw's own index
    └── <session_id>.jsonl                  ⭐ message content lives here

~/.claude/                                  Claude Code runtime — READ-ONLY for cowork
├── projects/<encoded-path>/<sid>.jsonl     ⭐ message content lives here
├── todos/<sid>-agent-<aid>.json            (not yet surfaced via API)
└── ... (untouched)

<repo>/data/openclaw/
└── usage_sync_state.json                   watermark for daily sync to swarm

<repo>/rclone.conf                          rclone remotes (gdrive + onedrive)
<repo>/mcp-tokens.json                      GitHub PAT, Vercel token, Manus key

/tmp/xo-cowork-api.{pid,log}                cowork-api.sh process manager artifacts
```

### Confidentiality guarantee

The split between `~/xo-projects/<pid>/` (sharable) and `~/.claude/`, `~/.openclaw/`, `~/.codex/` (machine-local) is **structural**:

- No code path writes chat content into a project folder. `tee_exchange` and `ClaudeCodeAdapter.stream` write metadata (sessionId, nativeSessionId, directory, usage totals) — never message text.
- A future sync feature can ship the entire `~/xo-projects/<pid>/` tree without leaking conversation history or runtime credentials.
- Documented explicitly in `services/cowork_agent/sessions_io.py` module docstring.

---

## 7. External integrations

```
                                      ┌──────────────────────┐
                                      │      xo-cowork-api   │
                                      └──────────┬───────────┘
                                                 │
   ┌────────────────────────┬─────────────┬──────┼──────┬──────────────┬──────────────┐
   │                        │             │      │      │              │              │
   ▼                        ▼             ▼      ▼      ▼              ▼              ▼
┌────────────┐  ┌──────────────────┐  ┌─────┐ ┌─────┐ ┌────────┐ ┌────────────┐ ┌─────────┐
│xo-swarm-api│  │OpenClaw gateway  │  │claude│ │codex│ │ rclone │ │GitHub /    │ │ Manus   │
│(cloud)     │  │(local :18789)    │  │ CLI  │ │ CLI │ │subproc │ │Vercel APIs │ │ API     │
│            │  │                  │  │subproc│ │subprc│ │+rclone.│ │            │ │         │
│Bearer:     │  │Bearer:           │  │      │ │     │ │conf   │ │GitHub:     │ │Bearer:  │
│ XO_API_KEY │  │OPENCLAW_GATEWAY_ │  │OAuth │ │OAuth│ │OAuth  │ │ PAT or gh  │ │mcp-     │
│ or consumed│  │ TOKEN            │  │token │ │token│ │       │ │ device flow│ │tokens.  │
│            │  │                  │  │      │ │     │ │       │ │Vercel:     │ │json     │
│ /auth/     │  │ POST /v1/chat/   │  │--print│ │exec │ │auth, │ │ OAuth+DCR  │ │ /v2/    │
│  browser/* │  │ completions      │  │      │ │     │ │lsf,  │ │            │ │ tasks   │
│ /chat/add_ │  │ (OpenAI-compat,  │  │      │ │     │ │mount │ │            │ │         │
│  message,  │  │  SSE stream)     │  │      │ │     │ │       │ │            │ │         │
│  get_msgs  │  │                  │  │      │ │     │ │       │ │            │ │         │
│ /usage/    │  │                  │  │      │ │     │ │       │ │            │ │         │
│  report    │  │                  │  │      │ │     │ │       │ │            │ │         │
└────────────┘  └──────────────────┘  └─────┘ └─────┘ └────────┘ └────────────┘ └─────────┘
```

All outbound. No external system calls back into cowork-api.

---

## 8. Lifespan / boot order

```
python server.py
   │
   ▼
load .env, resolve STAGE (local|beta), CLI paths
   │
   ▼
construct FastAPI(app), CORS=*
   │
   ▼
mount routers (auth, claude_setup_token, codex_setup, openclaw_usage, cowork_agent/*)
   │
   ▼
lifespan startup:
   │   1. print config summary
   │   2. if XO_AUTH_SESSION_ID + XO_POLL_TOKEN present → consume_auth_flow()
   │   3. start usage_sync background task (daily UTC hour from USAGE_SYNC_HOUR_UTC)
   │   4. (if AI_PROVIDER set) instantiate ClaudeCodeClient or CodexCodeClient
   │      for the legacy /ask_question* endpoints
   │
   ▼
listen on HOST:PORT (0.0.0.0:5002)
```

`cowork-api.sh start` wraps this with PID file management and log redirection. `cowork-update.sh` runs `git pull && restart` in the background.

---

## 9. Environment variables (current)

```
server         HOST, PORT, STAGE, AGENT_NAME (default openclaw),
               DEFAULT_AGENT, AI_PROVIDER, AI_WORKSPACE_ROOT,
               XO_PROJECTS_ROOT (default ~/xo-projects, created on first read),
               XO_PROJECT_TEMPLATE (override the bundled template dir)

swarm auth     CHAT_API_BASE_URL, XO_API_KEY,
               XO_AUTH_{SESSION_ID,POLL_TOKEN,START_PATH,STATUS_PATH,
                        CONSUME_PATH}, XO_GET_USER_ID_PATH

claude         CLAUDE_CLI_PATH, CLAUDE_TIMEOUT, CLAUDE_PERMISSION_MODE,
               CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY,
               CLAUDE_COWORK_DIR

codex          CODEX_CLI_PATH, CODEX_TIMEOUT, OPENAI_API_KEY,
               OPENAI_MODEL, CODEX_API_KEY

openclaw       OPENCLAW_API_URL, OPENCLAW_GATEWAY_TOKEN, OPENCLAW_MODEL,
               OPENCLAW_VERSION

usage sync     USAGE_SYNC_HOUR_UTC

connectors     VERCEL_OAUTH_REDIRECT_URI, RCLONE_CONFIG
```

---

## 10. Vision-achievement scorecard

Mapping the May-7 sync vision against shipped code:

| Capability | Status | Evidence |
|---|---|---|
| Project ↔ agent decoupling (project = data layer) | ✅ ~90% | `project_layout.py`, scaffolded template, `find_session_backend`, sessions are project-tied |
| Canonical project folder (AGENTS/PROJECT/PLAN/PROGRESS/OBJECTIVES + memory/ + .xo/) | ✅ ~95% | Complete `project_template/` shipped + scaffold enforces |
| Confidentiality (folder safe to share) | ✅ ~95% | Messages stay in runtime-native paths only; project folder is metadata-only |
| Open-source friendliness (open in plain Claude Code) | ✅ ~80% | `CLAUDE.md` is `@AGENTS.md`; skills convention; `[TEMPLATE]` markers communicate state |
| Memory subsystem (semantic / episodic / procedural / working) | ✅ ~90% | All four directories scaffolded with READMEs; convention documented in AGENTS.md |
| xo-projects skill | ✅ ~85% | `.agents/skills/xo-projects/SKILL.md` is canonical |
| Multi-runtime adapters (Claude Code + OpenClaw, Codex partial) | ✅ ~85% | `BaseAgentAdapter` + dispatcher + registry. Codex still legacy-only. |
| Unified usage / dashboard data | 🟡 ~40% | `/api/usage` unified. `sessionslist.json` populated. timeline/todos/stats/activity still empty. **No watcher service.** |
| Connectors (Drive, OneDrive, GitHub, Vercel, Manus) | ✅ ~88% | All wired. gh device flow, Vercel DCR, and gdrive folder mgmt + streaming uploads (#33) are recent polish. OneDrive still lacks the matching folder/upload surface. |
| Channels (Slack/Telegram/Discord) | 🟡 ~50% | `/api/channels/add` exists; runtime channel routing not wired |
| Sync between cowork instances | 🔴 0% | `.xo/sync.json`, `.xo/peers.json` are template stubs only |
| GitHub-backed snapshot sync (Phase 1 in plan) | 🔴 0% | Not started |
| B2B chat-proxy | 🔴 0% | Not started |
| RBAC across instances | 🔴 0% | xo-auth identity exists; no peer/grant code |
| Long-running agents | 🔴 0% | All chat is per-turn |

**Foundation: ~85%. Product features: ~10%. Overall: ~47% of the May-7 vision in code.**

---

## 11. Pending work, in priority order

1. **Watcher service** — populate `.xo/timeline.jsonl`, `.xo/todos.json`, `.xo/stats.json`, `.xo/activity.json` from runtime native files. Also: finalize `.xo/project.json` (replace `_template:true` with real `pid`/`owner_user_id`). The xo-projects skill explicitly says agents must wait for this.
2. **Project-level mutation endpoints** — list / rename / delete project. Currently the skill says "no API; do it via filesystem".
3. **Phase 1 sync** — GitHub-backed encrypted snapshots, modeled on the OpenClaw backup-restore skill. Plan locked in `visualizer-and-sync-plan.md`.
4. **Codex as a first-class adapter** — currently goes through `/codex/setup` only.
5. **`/api/messages/{id}` performance** — `find_session_file` is doing fallback searches across multiple roots; worth profiling once load grows.

---

## 12. Mental model — one sentence

> **A FastAPI router layer over a pluggable runtime adapter, owning the `~/xo-projects/` tree as a sharing-safe project model (metadata-only — chat content stays in `~/.claude/` and `~/.openclaw/`), with a sidecar pile of connector services for OAuth flows and a daily background task shipping usage to the cloud.**

Every other piece of code in this repo is in service of one of those clauses.
