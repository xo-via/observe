# Filesystem-related endpoints

Every endpoint in this doc is one that **reads from or writes to the local filesystem inside the workspace container**. The API never serves files over WebDAV, S3, or any object store. Disk is the contract.

There are five families:

| Family | Prefix | Backing path |
|---|---|---|
| Generic files | `/api/files/*` | anywhere under `$HOME` |
| Secrets (env file) | `/api/secrets/*` | `~/.openclaw/.env` (active agent's env file) |
| Sessions / messages | `/api/sessions/*`, `/api/messages/{id}` | `~/.openclaw/agents/<a>/sessions/` + `~/claude-cowork/<a>/sessions/` |
| Agents (registry) | `/api/agents/*` | `~/.openclaw/openclaw.json` |
| Remote filesystems | `/api/connectors/gdrive/*`, `/api/connectors/onedrive/*` | `<repo>/rclone.conf` |
| Stubs | `/api/workspace-memory/*`, `/api/fts/index/*` | (nothing) |

All paths in request bodies are **resolved with `Path.resolve()` and clamped to `Path.home()`**. Anything outside `$HOME` returns `403 Access denied`. There is no per-user authn beyond that — the workspace is the trust boundary.

---

## 1. `/api/files/*` — generic filesystem operations

Defined in `routers/cowork_agent/files.py`. Six routes, all `POST`.

```
                      ┌─────────────────────────────────────────────┐
                      │   incoming request body has a `path` field  │
                      └─────────────────────┬───────────────────────┘
                                            │
                                            ▼
                            ┌──────────────────────────────┐
                            │ target = Path(raw).resolve() │
                            │                              │
                            │ if not str(target)           │
                            │   .startswith(str(home)):    │
                            │     → 403 Access denied      │
                            └──────────────┬───────────────┘
                                           │
                                           ▼
                                    actual operation
```

The home-clamp is the **only** safety layer. Symlink-traversal-out is technically possible if a symlink under `$HOME` points outward, since `Path.resolve()` follows symlinks; treat the workspace as the trust boundary.

### 1.1 `POST /api/files/upload`

Multipart upload. Saves to `workspace` form field if provided, else `~/uploads/`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `file` | UploadFile | yes | max 100 MB (`_MAX_UPLOAD_BYTES`) |
| `workspace` | str | no | absolute dir path; created if missing |

```
client                                   files.py                              disk
  │                                          │
  │ multipart upload                         │
  │ file=<...>, workspace="/Users/x/proj"    │
  ├─────────────────────────────────────────►│
  │                                          │ read up to 100MB+1
  │                                          │ if > 100MB → 413
  │                                          │
  │                                          │ content_hash = sha256(content)
  │                                          │ dest_dir = workspace or ~/uploads
  │                                          │ dest_dir.mkdir(parents=True)
  │                                          │
  │                                          │ if dest exists AND
  │                                          │   sha256(existing) != content_hash:
  │                                          │     dest = "{stem}_{hash[:8]}{suffix}"
  │                                          │
  │                                          │ dest.write_bytes(content) ────────►●
  │                                          │
  │   {file_id, name, path,                  │
  │    size, mime_type, source,              │
  │    content_hash}                         │
  │◄─────────────────────────────────────────│
```

**Notable:** identical files (same hash) silently overwrite. Different content with the same name auto-renames using the first 8 chars of the new content's hash.

### 1.2 `POST /api/files/list-directory`

Directory listing. Body: `{path?: string}`. If `path` omitted → lists `$HOME`.

```
{
  "path": "<resolved-path>",
  "parent": "<parent or null if at $HOME>",
  "dirs":  [{"name": ..., "path": ...}, ...],
  "files": [{"name": ..., "path": ...}, ...]
}
```

Sort order: directories first, then files, both alphabetic case-insensitive. `PermissionError` is silently swallowed (returns whatever was readable up to that point). Non-directory target → `404 Not a directory`.

### 1.3 `POST /api/files/content` — text read

Body: `{path: string}` (required). Reads with `read_text(errors="replace")` so binary garbage doesn't crash the route — you'll just get replacement chars. Returns `{content, path}`.

Errors:
- missing `path` → `400`
- outside `$HOME` → `403`
- not a file → `404`
- read failure → `500` with the exception message

### 1.4 `POST /api/files/content-binary` — binary download

Body: `{path: string}` (required). Returns `FileResponse(target, filename=target.name)` so the browser downloads it. Same 403/404 rules.

### 1.5 `POST /api/files/save` — text write

Body: `{path: string, content: string}`. **`content` must be a string** (not bytes, not a number) — anything else → `400 Content must be a string`.

```
target.parent.mkdir(parents=True, exist_ok=True)   # creates intermediate dirs
target.write_bytes(content.encode("utf-8"))         # always overwrites
```

No backup, no dirty-write detection, no append mode. For arbitrary uploads use `/api/files/upload` instead — `save` is intended for known scaffold files (`IDENTITY.md`, `SOUL.md`, etc.). Returns `{path, bytes}`.

### 1.6 `POST /api/files/mkdir`

Create a directory and optionally scaffold xo-cowork files into it.

| Field | Type | Required | Effect |
|---|---|---|---|
| `path` | str | yes | absolute target dir path |
| `scaffold` | bool | no (default `false`) | writes `WORKSPACE.md`, `AGENTS.md`, `OBJECTIVES.md`, `sessions.json` (`[]`) |
| `files` | list[str] | no | absolute paths under `$HOME` to copy in by basename |

```
validation:
  path must be absent (else 409 Already exists)
  every entry in `files` must be:
    - under $HOME (else 403)
    - an existing file (else 404)

execution (only after validation passes):
  target.mkdir(parents=True, exist_ok=False)
  if scaffold:
    write WORKSPACE.md, AGENTS.md, OBJECTIVES.md, sessions.json
  for src in resolved_files:
    if (target / src.name) doesn't exist:
      shutil.copy2(src, target / src.name)   # preserves mtime + perms
```

The scaffold templates are full markdown skeletons (mission statement, OKR table, agent operating contract). See `_PROJECT_SCAFFOLD` in `files.py:27` for the literal strings.

### Diagram: `/api/files/*` in one view

```
┌────────────────────────────────────────────────────────────────────────┐
│                          $HOME boundary                                │
│                                                                        │
│   /api/files/upload      ──►  multipart write   (100 MB cap)           │
│                               dedup by sha256                          │
│   /api/files/list-directory ─► iterdir(), sorted                       │
│   /api/files/content       ─► read_text                                │
│   /api/files/content-binary ─► FileResponse                            │
│   /api/files/save          ─► write_bytes                              │
│   /api/files/mkdir         ─► mkdir + scaffold + shutil.copy2          │
│                                                                        │
│   anything resolving outside $HOME → 403 immediately                   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. `/api/secrets/*` — env-file CRUD

Defined in `routers/cowork_agent/secrets.py`. Backed by `services/cowork_agent/openclaw_env.py`. Operates on the **active agent's `.env` file** (resolved via `agent_registry.get_default_agent().env_file`, typically `~/.openclaw/.env`).

```
                                  ~/.openclaw/.env    (or ~/claude-cowork/.env)
                                        ▲   ▲
                                        │   │
              ┌─────────────────────────┘   └────────────────────────┐
              │                                                       │
GET /api/secrets/env                       PUT /api/secrets/env
GET /api/secrets/env/keys                    body: {entries: [{key, value}, ...]}
              │                                                       │
              ▼                                                       ▼
load_env_entries()                              save_env_entries(entries)
  • parse_env_file: skip blank/`#`,             • truncate-and-rewrite the file
    split first `=`, strip both sides           • only writes lines with non-empty key
  • returns [{key, value}, ...]                 • does NOT preserve comments,
  • does NOT preserve comment lines               blanks, or original ordering
    or surrounding blank lines
```

### 2.1 `GET /api/secrets/env`
Returns `{entries: [{key, value}, ...]}`. **Plaintext values are sent**, including secrets. Used by the Settings → Env Vars UI.

### 2.2 `GET /api/secrets/env/keys`
Returns `{keys: [...]}` — only key names with non-empty values. **No secret material on the wire.** Used by onboarding to detect "is `ANTHROPIC_API_KEY` set?" without exposing it.

### 2.3 `PUT /api/secrets/env`
Body: `{entries: [{key, value}, ...]}`. Calls `save_env_entries`, which **overwrites the entire file**. Comments, blank lines, and any keys not in the request are lost.

### 2.4 The other code path — `upsert_env_entry` (not exposed on this route family)

`openclaw_env.upsert_env_entry(key, value)` does a **line-level edit** that preserves comments, blanks, ordering, and unrelated keys. It is used by the onboarding "Save Key" flow inside `routers/cowork_agent/config.py`, not by `/api/secrets/*`.

This split is intentional: the Settings UI has no UI for comments, so it round-trips through a normalized form. The onboarding flow does, so it preserves them.

---

## 3. `/api/sessions/*` and `/api/messages/{id}` — session-file readers

Defined in `routers/cowork_agent/sessions.py`. Backed by `services/cowork_agent/sessions_io.py`.

These don't take or write arbitrary paths — they walk a fixed set of directories looking for session JSONL files.

### 3.1 What's on disk

```
~/.openclaw/agents/                       ◄── OpenClaw adapter, scanned by AGENTS_DIR
└── <agent_name>/
    └── sessions/
        ├── sessions.json                 {session_key → {sessionId, updatedAt, directory, ...}}
        └── <session_id>.jsonl            line-per-record message log

~/claude-cowork/                          ◄── ClaudeCodeAdapter, scanned by CLAUDE_COWORK_DIR
└── <agent_id>/
    └── sessions/
        ├── sessions.json                 {session_key → {sessionId, nativeSessionId,
        │                                                  directory, directoryHistory}}
        └── <session_id>.jsonl

(legacy fallback, read-only:)
~/claude-cowork/<agent_id>/.sessions/<session_id>.json
~/claude-cowork/.sessions/<session_id>.json
```

`sessions_io.load_all_sessions()` walks both roots and merges. `seen_ids` dedupes (an OpenClaw entry wins if both report the same id).

### 3.2 The endpoints

```
GET /api/sessions?limit=&offset=
   → load_all_sessions(), sort by time_updated desc, slice [offset, offset+limit]

GET /api/sessions/search?q=&limit=&offset=
   → naive case-insensitive substring match on `title` only
     (no body / FTS yet — see /api/fts/index for the placeholder)

GET /api/sessions/{session_id}
   → linear scan of load_all_sessions() for matching id; 404 if not found

GET /api/messages/{session_id}?limit=&offset=
   → find_session_file(session_id) → Path | None
     parse_jsonl(path) → list[dict]
     convert_messages(session_id, records) → frontend shape
     pagination:
       offset == -1 (default) → start = max(0, total - limit)   # newest page
       otherwise              → start = offset
     returns {total, offset, messages}

GET /api/sessions/{session_id}/todos      → {"todos": []}      (stub)
GET /api/sessions/{session_id}/files      → {"files": []}      (stub)

POST   /api/sessions                  → returns a synthetic uuid; real creation
                                         happens in /api/chat/prompt
DELETE /api/sessions/{session_id}     → {"ok": true}            (no-op)

PATCH  /api/sessions/{session_id}
   body: {directory: string}
   → update_session_directory(session_id, directory):
       walk ~/.openclaw/agents/*/sessions/sessions.json,
       find entry where meta.sessionId == session_id,
       append {directory, selectedAt: now_ms} to meta.directoryHistory[-200:],
       set meta.directory + meta.updatedAt,
       json.dump back atomically.
   → if not found, fall through to update_claude_session_directory
     (same shape, ~/claude-cowork/* tree, with legacy `.sessions/{id}.json`
     fallback)
   → 404 if neither layout has it
```

### 3.3 Resolution diagram for a single message fetch

```
GET /api/messages/abc-123?limit=50&offset=-1
        │
        ▼
find_session_file("abc-123"):
        │
        ├── ~/.openclaw/agents/*/sessions/abc-123.jsonl    found? → return
        │
        ├── ~/claude-cowork/*/sessions/abc-123.jsonl       found? → return
        │
        └── claude_sessions.find_session_messages_path     legacy .sessions/<id>.json
                                                            with .messages.jsonl sidecar
        │
        ▼
parse_jsonl(path)            list[dict]
        │
        ▼
convert_messages(...)        normalize per-adapter record shape
                              → frontend chat-bubble shape
        │
        ▼
slice [start, start+limit]
        │
        ▼
{total, offset, messages}
```

The "newest page" default (`offset=-1`) is what the frontend uses on first load to render the tail of a long conversation without paging through old turns.

---

## 4. `/api/agents/*` — agent registry CRUD

Defined in `routers/cowork_agent/agents.py`. Backed by `services/cowork_agent/openclaw_store.py`. The single file is `~/.openclaw/openclaw.json`.

```
~/.openclaw/openclaw.json                   ◄── the only file these routes touch
{
  "agents": [
    {"id": "main", "name": "...", "model": "...", "systemPrompt": "...", ...},
    ...
  ],
  ...
}

GET    /api/agents                  list all
POST   /api/agents       body: {id?, name, model, systemPrompt?, ...}   create / upsert
GET    /api/agents/{id}             read one
PATCH  /api/agents/{id}  body: partial fields                          merge + save
```

Every write is a **full read-merge-write** of `openclaw.json`. There is no record-level locking, so two concurrent PATCH calls can race; the workspace's single-user assumption keeps this fine in practice.

---

## 5. Remote filesystems — `/api/connectors/{gdrive,onedrive}/*`

These are filesystem-shaped: they configure rclone "remotes" that the user can later list / mount / read. The API is the OAuth orchestrator; rclone holds the tokens.

### 5.1 What's on disk

```
<repo>/rclone.conf                ◄── single shared config for all rclone remotes
[gdrive-personal]
type = drive
token = {"access_token":"...","refresh_token":"...","expiry":"..."}
...
[onedrive-work]
type = onedrive
...
```

Path is `RCLONE_CONFIG` env var or `<repo>/rclone.conf` (fallback). One file holds every gdrive **and** onedrive remote. Both connector services (`gdrive_rclone.py`, `onedrive_rclone.py`) use the same file via `--config` on every `rclone` invocation. Concurrent OAuth flows are serialized by `services/cowork_agent/rclone_oauth_lock.py` because Google's bundled OAuth client embeds **port `:53682` as the only allowed callback** — only one rclone process can listen there at a time.

### 5.2 OAuth + rclone-conf life-cycle (gdrive shown — onedrive is identical shape)

```
client                       gdrive.py                gdrive_rclone.py            rclone CLI
  │                              │                          │                          │
  │ POST /api/connectors/        │                          │                          │
  │   gdrive/remotes             │                          │                          │
  │ {name: "personal"}           │                          │                          │
  ├─────────────────────────────►│                          │                          │
  │                              │ rclone_available?  ───── │                          │
  │                              │ validate_remote_name     │                          │
  │                              │ create_remote_session(name, force)                  │
  │                              ├─────────────────────────►│                          │
  │                              │                          │ acquire OAuth lock (RC) │
  │                              │                          │ spawn:                  │
  │                              │                          │ rclone authorize \      │
  │                              │                          │   --auth-no-open-browser│
  │                              │                          │   drive ────────────────►●
  │                              │                          │                          │
  │                              │                          │  ◄── stderr line with   │
  │                              │                          │       http://localhost: │
  │                              │                          │       53682/auth?...     │
  │                              │                          │  resolve auth URL via   │
  │                              │                          │  Google (cloudconsole)  │
  │                              │                          │                          │
  │ {session_id, status:pending} │                          │                          │
  │◄─────────────────────────────│                          │                          │
  │                              │                          │                          │
  │ GET /api/connectors/         │                          │                          │
  │   gdrive/sessions/{id}       │                          │                          │
  ├─────────────────────────────►│ get_session(session_id)  │                          │
  │ {status: awaiting_oauth,     │                          │                          │
  │  auth_url, needs_manual_code}│                          │                          │
  │◄─────────────────────────────│                          │                          │
  │                              │                          │                          │
  │  user opens auth_url in their browser, copies the redirect URL                     │
  │                                                                                     │
  │ POST /api/connectors/        │                          │                          │
  │   gdrive/sessions/{id}/submit│                          │                          │
  │ {code: "<full URL or bare>"} │                          │                          │
  ├─────────────────────────────►│ extract ?code= via regex │                          │
  │                              │ session.verification_input = code                   │
  │                              │                                                     │
  │                              │              GET http://localhost:53682/?code=...   │
  │                              │              + state from oauth_state ───────────────►●
  │                              │                          │                          │
  │                              │                          │  ◄── stdout: token JSON │
  │                              │                          │  write [name] section   │
  │                              │                          │  into rclone.conf       │
  │                              │                          │  status = completed     │
  │                              │                          │                          │
  │ GET /api/connectors/         │                          │                          │
  │   gdrive/sessions/{id}       │                          │                          │
  │ {status:completed,           │                          │                          │
  │  remote_name:"personal"}     │                          │                          │
  │◄─────────────────────────────│                          │                          │
```

If port `:53682` is already in use (another rclone, prior crashed flow), the service starts its **own** tiny HTTP listener on a free port, captures the code from the user's pasted URL, then forwards it to rclone's expected `:53682` endpoint. See `_run_oauth_flow` in `gdrive_rclone.py:333`.

### 5.3 The route surface (gdrive — onedrive mirrors)

| Route | Method | Purpose |
|---|---|---|
| `/api/connectors/gdrive/remotes` | GET | `rclone listremotes` filtered to type `drive` |
| `/api/connectors/gdrive/remotes` | POST | `{name, force?}` → starts OAuth, returns `{session_id, status: pending}` (HTTP 202) |
| `/api/connectors/gdrive/sessions/{session_id}` | GET | poll `{status, auth_url?, remote_name?, error?}` |
| `/api/connectors/gdrive/sessions/{session_id}/submit` | POST | `{code}` — accepts full redirect URL or bare `code=` |
| `/api/connectors/gdrive/sessions/{session_id}/cancel` | POST | abort flow, kill subprocess |
| `/api/connectors/gdrive/remotes/{name}` | DELETE | `rclone config delete {name}` (returns 204) |

Sessions live in-memory in `_sessions: dict[session_id, GDriveSession]`. TTL = 600 s (`SESSION_TTL`); the dataclass tracks `status`, `auth_url`, `verification_input`, `oauth_state`, `task`, etc. (`gdrive_rclone.py:82`).

### 5.4 Errors

- `503` — rclone binary missing / unreachable
- `409` — concurrent OAuth flow already running (single-flight lock across gdrive + onedrive)
- `400` — invalid remote name (rejected by `validate_remote_name`)
- `404` — session id unknown or expired

---

## 6. Stubs — `/api/workspace-memory/*`, `/api/fts/index/*`

Filesystem-adjacent in name only.

```
GET  /api/workspace-memory                  → {memory: null}
GET  /api/workspace-memory/list             → []
PUT  /api/workspace-memory                  → {ok: true}
DELETE /api/workspace-memory                → {ok: true}
POST /api/workspace-memory/refresh          → {ok: true}
POST /api/workspace-memory/export           → {ok: true}

GET  /api/fts/index/{workspace:path}        → {status: "idle", progress: 0}
POST /api/fts/index/{workspace:path}        → {status: "idle", progress: 0}
```

These exist so the frontend's wiring doesn't 404. None of them touch disk. When they're implemented, they'll likely write under each workspace dir (memory) and to a hidden index file (FTS), but that's not the case today.

---

## 7. Cheat sheet — every filesystem endpoint, one line each

```
POST   /api/files/upload                    multipart → workspace or ~/uploads/, 100MB cap, sha256 dedupe
POST   /api/files/list-directory            iterdir clamped to $HOME, dirs+files sorted
POST   /api/files/content                   read_text(errors="replace")
POST   /api/files/content-binary            FileResponse download
POST   /api/files/save                      write_bytes (string content, parent.mkdir)
POST   /api/files/mkdir                     mkdir(exist_ok=False) + scaffold + shutil.copy2

GET    /api/secrets/env                     load_env_entries() — plaintext values
GET    /api/secrets/env/keys                names only (non-empty values)
PUT    /api/secrets/env                     save_env_entries() — full overwrite

GET    /api/sessions                        load_all_sessions() across both adapter roots
GET    /api/sessions/search?q=              substring match on title only
GET    /api/sessions/{id}                   linear scan
GET    /api/sessions/{id}/todos             stub: []
GET    /api/sessions/{id}/files             stub: []
POST   /api/sessions                        stub uuid (real creation = /api/chat/prompt)
PATCH  /api/sessions/{id}                   {directory} → openclaw or claude_code sessions.json
DELETE /api/sessions/{id}                   stub: ok
GET    /api/messages/{id}                   find_session_file → parse_jsonl → convert_messages → page

GET    /api/agents                          read ~/.openclaw/openclaw.json
POST   /api/agents                          read-merge-write
GET    /api/agents/{id}                     read one
PATCH  /api/agents/{id}                     read-merge-write

GET    /api/connectors/gdrive/remotes       rclone listremotes (filtered)
POST   /api/connectors/gdrive/remotes       start OAuth + spawn rclone authorize
GET    /api/connectors/gdrive/sessions/{id} poll status
POST   /api/connectors/gdrive/sessions/{id}/submit  paste redirect URL/code
POST   /api/connectors/gdrive/sessions/{id}/cancel  abort
DELETE /api/connectors/gdrive/remotes/{n}   rclone config delete

(/api/connectors/onedrive/* mirrors gdrive)
```

---

## 8. Caller refs

- `routers/cowork_agent/files.py` — `_PROJECT_SCAFFOLD` (line 27), `upload_file` (155), `list_directory` (198), `file_content` (237), `file_content_binary` (262), `file_save` (282), `make_directory` (321)
- `routers/cowork_agent/secrets.py` — `get_env_secrets` (17), `get_env_keys` (26), `put_env_secrets` (43)
- `routers/cowork_agent/sessions.py` — list (30), search (36), get (47), messages (56), patch (89), per-session todos/files stubs (121, 126)
- `routers/cowork_agent/agents.py` — list (318), create (356), get (415), patch (423)
- `routers/cowork_agent/workspace_memory.py`, `fts.py` — full files, all stubs
- `routers/cowork_agent/gdrive.py`, `onedrive.py` — REST surface
- `services/cowork_agent/openclaw_env.py` — `parse_env_file`, `serialize_env_file`, `load_env_entries`, `save_env_entries`, `upsert_env_entry`
- `services/cowork_agent/sessions_io.py` — `load_all_sessions` (19), `find_session_file` (185), `find_session_key` (210), `find_session_backend` (249), `update_session_directory` (276), `update_claude_session_directory` (315)
- `services/cowork_agent/openclaw_store.py` — `~/.openclaw/openclaw.json` CRUD
- `services/cowork_agent/gdrive_rclone.py` — `_rclone_cli`, `create_remote_session`, `_run_oauth_flow`, `GDriveSession`
- `services/cowork_agent/rclone_oauth_lock.py` — single-flight lock across gdrive + onedrive (port `:53682`)
