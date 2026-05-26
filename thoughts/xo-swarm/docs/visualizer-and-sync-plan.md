# cowork-api: visualizer + peer-sync server

## TL;DR

> **cowork-api stays as it is. Phase 1 adds (a) a visualizer that mirrors every runtime's session/todo/stats data into a per-project `.xo/` directory, and (b) GitHub-backed project sync modeled directly on the existing OpenClaw [backup-restore skill](https://docs.xo.builders/agents/openclaw/skills/backup-restore): each shared project has an **owner-owned private GitHub repo** as its origin; cowork-api creates encrypted (GPG AES-256) snapshots of `~/xo-projects/<pid>/`, commits and pushes them to that repo, and members restore by pulling and decrypting.** Linear history is enforced by git itself — non-fast-forward pushes get rejected, and the member runs `git pull --rebase` locally to resolve. Sharing = inviting a GitHub collaborator + passing the passphrase out-of-band. Identity files (`~/.claude/`, `~/.openclaw/`) never enter the repo. `/api/chat/*` stays untouched. Real-time bidirectional sync (the WebSocket / 409 NEEDS_REBASE design) is reserved for Phase 2, only if snapshot pushes turn out to be too coarse.

---

Supersedes the previous "future-architecture-proposal.md" framing in two ways:

1. **cowork-api stays as it is, plus visualizer features.** It surfaces sessions, todos, stats, and progress from the runtimes' own storage (`~/.claude/`, `~/.openclaw/`, etc). The existing chat (`/api/chat/*`) remains first-class — nothing is deleted. We're only adding.
2. **Phase 1 sync is GitHub-backed snapshots, not real-time.** Each shared project has an **owner-controlled private GitHub repo** as its origin. cowork-api ships a snapshot/restore subsystem that mirrors the OpenClaw [backup-restore skill](https://docs.xo.builders/agents/openclaw/skills/backup-restore) — encrypt the project folder with GPG AES-256, commit + push to the origin repo, restore on the other side by pulling and decrypting. Linear history is enforced by git. Real-time bidirectional sync (WebSocket relay, `409 NEEDS_REBASE` etc.) is Phase 2, only built if snapshot granularity proves too coarse in practice.

**Scope of this plan: API only.** The Tauri/desktop UI stays unchanged for now. Everything below is server-side surface and on-disk schemas.

---

## 1. Reframe: where the data lives, what cowork shows

```
                         data already on disk (NOT owned by cowork-api)
       ┌────────────────────────────────────────────────────────────────────────┐
       │                                                                          │
       │  ~/.claude/projects/<encoded-path>/<sid>.jsonl   ← Claude Code message log│
       │  ~/.claude/todos/<sid>-agent-<aid>.json          ← TodoWrite output       │
       │  ~/.claude/sessions/<id>.json                    ← session metadata        │
       │  ~/.claude/plans/*.md                            ← plan-mode artifacts     │
       │                                                                          │
       │  ~/.openclaw/agents/<a>/sessions/sessions.json    ← OpenClaw index         │
       │  ~/.openclaw/agents/<a>/sessions/<sid>.jsonl      ← OpenClaw message log   │
       │                                                                          │
       │  ~/.codex/...                                    ← Codex storage           │
       │                                                                          │
       │  <project>/                                      ← actual work product     │
       │    src/, docs/, files...                                                   │
       └────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼  (read-only, watch-mode)
       ┌────────────────────────────────────────────────────────────────────────┐
       │                          cowork-api                                      │
       │                          (visualizer)                                    │
       │                                                                          │
       │  /api/sessions             — merged view across all runtimes             │
       │  /api/todos                — read ~/.claude/todos/* + add per-runtime    │
       │  /api/stats                — aggregate: tokens, files, time, models      │
       │  /api/projects             — list project folders                        │
       │  /api/projects/{pid}/timeline — events: session, todo, file, sync         │
       │                                                                          │
       │  /api/chat/*               — secondary: chat broker (B2B-facing)         │
       │  /api/sync/*               — primary new feature: peer mesh              │
       └────────────────────────────────────────────────────────────────────────┘
```

cowork-api becomes the read-side over this data: any client (the existing Tauri app, a future custom UI, a B2B integration) can render whatever shape it wants on top of `/api/sessions`, `/api/todos`, `/api/stats`, `/api/projects/{pid}/timeline`. The API is the contract.

---

## 2. The per-project tracking files (mimicking `~/.claude/todos/*`)

Each project folder gets a `.xo/` directory (xo-cowork's equivalent of `.claude/`). These files are **derived/synced** — cowork-api watches the runtime's own storage and materializes them here so they ship with the project when shared.

```
<project>/
├── .xo/
│   ├── project.json          identity: pid, name, owner_user_id, created_at
│   ├── todos.json            aggregated todos from every active session in this project
│   ├── stats.json            rolling 7d/30d stats: tokens, models, files, sessions, time
│   ├── timeline.jsonl        append-only event log (sessions, todos, file edits, syncs)
│   ├── peers.json            who this project is shared with
│   ├── sync.json             last-sync state per peer (vector clock or hash manifest)
│   └── activity.json         live: which sessions are open right now, last activity ts
│
├── AGENTS.md                 (existing scaffold) operating contract + 3 logs
├── PROJECT.md                what this is for (replaces WORKSPACE.md)
├── PLAN.md                   current plan (NEW — agent-maintained)
├── PROGRESS.md               running progress narrative (NEW — agent-maintained)
├── OBJECTIVES.md             (existing scaffold) OKRs
├── TASKS.json                machine-readable task list (NEW; mirrors .xo/todos.json
│                              but with project-meaningful task IDs, not session-scoped)
└── ... (actual work files)
```

### Schema for `.xo/todos.json`

Mirrors Claude Code's todo file shape but **keyed per session**, since one project can have multiple concurrent sessions across runtimes:

```json
{
  "schema": 1,
  "updated_at": "2026-05-08T07:12:00Z",
  "sessions": {
    "ses_abc123": {
      "runtime": "claude_code",
      "source_file": "~/.claude/todos/ses_abc123-agent-aid.json",
      "session_started_at": "...",
      "todos": [
        { "id": "1", "content": "Plumb identity header", "status": "completed" },
        { "id": "2", "content": "Add authorize() shadow mode", "status": "in_progress" },
        { "id": "3", "content": "Wire RBAC routes",         "status": "pending"  }
      ]
    },
    "ses_def456": {
      "runtime": "openclaw",
      "todos": [...]
    }
  }
}
```

### Schema for `.xo/stats.json`

```json
{
  "schema": 1,
  "updated_at": "...",
  "rolling": {
    "7d":  { "tokens": {"input": 1234567, "output": 234567},
             "by_model": {"claude-sonnet-4.5": {...}, "gpt-5": {...}},
             "files_edited": 142, "sessions": 23, "active_minutes": 1456 },
    "30d": { ... }
  },
  "by_session": {
    "ses_abc123": { "tokens": {...}, "files": [...], "duration_ms": 3600000 }
  },
  "by_runtime": {
    "claude_code": {...}, "openclaw": {...}
  }
}
```

### Schema for `.xo/timeline.jsonl` (append-only)

```
{"ts":"...","type":"session.started","session_id":"...","runtime":"claude_code","user_id":"..."}
{"ts":"...","type":"todo.added","session_id":"...","todo":{"id":"1","content":"..."}}
{"ts":"...","type":"todo.completed","session_id":"...","todo_id":"1"}
{"ts":"...","type":"file.edited","path":"src/foo.py","session_id":"..."}
{"ts":"...","type":"file.created","path":"docs/new.md","session_id":"..."}
{"ts":"...","type":"plan.written","path":".claude/plans/abc.md","session_id":"..."}
{"ts":"...","type":"peer.sync.started","peer_user_id":"user_..."}
{"ts":"...","type":"peer.sync.applied","peer_user_id":"user_...","files":["src/foo.py"]}
{"ts":"...","type":"peer.sync.conflict","path":"src/bar.py","peers":["user_a","user_b"]}
```

This is the single source of truth for "what happened in this project". The dashboard renders it as a stream. The peer-sync server replicates new entries between cowork instances.

### How these files get populated (file-watcher service)

A new background task in cowork-api:

```
services/cowork_agent/watcher.py

watches:
  ~/.claude/projects/<encoded-path>/*.jsonl   → derive session events, file edits
  ~/.claude/todos/*.json                       → derive todo events
  ~/.openclaw/agents/*/sessions/*.jsonl        → same for OpenClaw
  <project>/**                                  → file-level edits (debounced)

writes:
  <project>/.xo/todos.json                 (rewritten on each todo file change)
  <project>/.xo/timeline.jsonl              (append per event)
  <project>/.xo/stats.json                 (rebuilt every 60s)
  <project>/.xo/activity.json              (heartbeat: last seen session, last edit)
```

Mapping a session ID to a project requires looking at the session's working directory. Claude Code already encodes the project path in `~/.claude/projects/<encoded-path>/`. OpenClaw stores it in `meta.directory` in `sessions.json`. The watcher uses both.

---

## 3. The sync layer — owner's GitHub repo as the trunk (Phase 1)

### 3.1 What you described, restated

> Use the OpenClaw [backup-restore](https://docs.xo.builders/agents/openclaw/skills/backup-restore) pattern: encrypt the folder, push it as a blob to GitHub. Owner's origin repo IS where changes go. Same shape, applied to project folders.

So: **GitHub IS the sync substrate**. No new transport, no rendezvous server, no NAT traversal. Each shared project has a private GitHub repo; cowork-api just ships a snapshot/restore pair around it. Linear history is whatever git already gives us.

### 3.2 Topology

```
┌─────────────────────────────┐                              ┌─────────────────────────────┐
│  cowork-api  (User A — OWNER)│                              │  cowork-api  (User B — MEMBER)│
│  Clerk user_id: user_2bX... │                              │  Clerk user_id: user_3kL... │
│  GitHub PAT (in .env)       │                              │  GitHub PAT (in .env)       │
│                             │                              │                             │
│  ~/xo-projects/proj-1/      │                              │  ~/xo-projects/proj-1/      │
│   .xo/origin.json {...}     │                              │   .xo/origin.json {...}     │
│   (work files)              │                              │   (work files)              │
└──────────────┬──────────────┘                              └──────────────┬──────────────┘
               │                                                             │
               │ git push  (encrypted blob commits)                          │ git pull → decrypt
               │ git pull                                                    │ git push (if member-write)
               ▼                                                             ▼
        ┌──────────────────────────────────────────────────────────────────────┐
        │              github.com/<owner>/cowork-project-proj-1                  │
        │              (private repo, owner-owned)                               │
        │                                                                        │
        │   commits on main:                                                     │
        │     "snapshot v0042 by user_2bX...  2026-05-08T07:30:00Z"             │
        │     ├── snapshot.tar.gz.gpg           ← whole project, encrypted       │
        │     ├── manifest.json                  ← version, author, size, hash    │
        │     └── README.md                      ← human-readable repo docs      │
        │                                                                        │
        │   collaborators: read|write per github (owner controls)               │
        │   passphrase: shared OUT OF BAND between owner and members             │
        └──────────────────────────────────────────────────────────────────────┘
```

This is git's existing model:
- **Linear history** because the only branch is `main` and pushes to `main` must be fast-forward (default GitHub setting).
- **Conflict resolution** is git's normal `pull --rebase` flow, which the human runs locally before retrying the push.
- **Auth** is whatever GitHub's PAT gives you — read-only members can clone+pull, write-capable members can push.
- **Confidentiality** comes from GPG encryption of the whole snapshot, so even if the GitHub repo's metadata leaks, the contents don't.

### 3.3 What's in the origin repo

```
github.com/<owner>/cowork-project-<pid>/        ← private; one repo per project
│
├── snapshots/
│   └── v0042-2026-05-08T07-30-00.tar.gz.gpg    ← full project, GPG AES-256
│       (chunked into v0042-...part-001, part-002 if > 90 MB —
│        same chunking algorithm as OpenClaw backup-restore)
│
├── manifest.json                                latest snapshot metadata
│   {
│     "schema": 1,
│     "project_id": "proj-1",
│     "owner_user_id": "user_2bX...",
│     "head_version": 42,
│     "head_snapshot": "v0042-2026-05-08T07-30-00",
│     "head_hash": "sha256:...",         (hash of the encrypted blob)
│     "head_size_bytes": 4287312,
│     "head_chunk_count": 1,
│     "history": [
│       {"version":42,"snapshot":"v0042-...","author":"user_2bX...","ts":"...","size":4287312},
│       {"version":41,"snapshot":"v0041-...","author":"user_3kL...","ts":"...","size":4280112},
│       ...                              (last 10 retained, older auto-pruned by sync.py)
│     ]
│   }
│
└── README.md                                    static docs explaining what this repo is
```

`manifest.json` is committed in plaintext so anyone with read access to the repo can see version history without decrypting. The actual project contents are inside the encrypted snapshots.

**Excluded from snapshots** (mirrors the OpenClaw backup-restore exclusion list, plus a few project-specifics):
- `.git/` (the project's own dev VCS, separate from the sync repo)
- `node_modules/`, `__pycache__/`, `.venv/`, `target/`, `dist/`, `build/`
- `*.sock`, `*.pid`
- `.env`, `.env.*`                 ← project secrets stay local
- `.xo/sync_state.json`            ← per-machine state, never shared
- the snapshot transport repo itself (so we never recursively snapshot ourselves)

### 3.4 Snapshot creation flow (push)

```
member or owner cowork-api                     git + GitHub
    │                                                │
    │  POST /api/sync/projects/proj-1/snapshot       │
    │  { message?: "..." }                            │
    │                                                │
    ▼                                                │
  read .xo/origin.json → {github_repo,               │
                          passphrase_source,         │
                          last_pulled_version}       │
    │                                                │
    ▼                                                │
  ensure local checkout exists at                    │
  ~/.xo-cowork/sync-checkouts/proj-1/                │
  (a bare-bones git clone of the origin repo,        │
   separate from the user's working ~/xo-projects/)  │
    │                                                │
    ▼                                                │
  git pull origin main ──fast-forward──────────────► │
  if not fast-forward:                               │
    return 409 NEEDS_PULL_FIRST                      │
    (member must restore local working tree from the │
     incoming snapshot before re-snapshotting)       │
    │                                                │
    ▼                                                │
  tar -cz from ~/xo-projects/proj-1/                 │
  (excludes per §3.3)                                │
    │                                                │
    ▼                                                │
  gpg --symmetric --cipher-algo AES256              │
       --batch --passphrase ${PASSPHRASE}            │
                                                     │
  optional: split into 90 MB chunks                  │
    │                                                │
    ▼                                                │
  bump version: head_version = N + 1                 │
  write snapshots/vNNNN-<ts>.tar.gz.gpg              │
  rewrite manifest.json with new history entry       │
  prune snapshots/* older than 10 entries            │
    │                                                │
    ▼                                                │
  git add . && git commit -m "snapshot vNNNN by <user_id>"
  git push origin main ──fast-forward───────────────►│
                                                     │
  if push rejected (someone else snapshotted first): │
    git pull --rebase                                │
    re-resolve conflicts on manifest.json            │
    (manifest is small structured JSON — sort        │
     history[] by version desc, dedupe; if two       │
     snapshots claim the same version, the one with  │
     earlier ts wins and the loser bumps to N+1)     │
    git push origin main                             │
    │                                                │
    ▼                                                │
  return { snapshot: "vNNNN-...", version: NNNN, size }
```

For Phase 1 we accept that two members snapshotting concurrently is unusual and the rebase-merge of `manifest.json` is the only auto-merge we do. Conflicts inside the encrypted blob never happen — each commit is a self-contained snapshot, not a delta.

### 3.5 Restore flow (pull)

```
member cowork-api                              git + GitHub
    │                                                │
    │  POST /api/sync/projects/proj-1/restore        │
    │  { snapshot_id?: "vNNNN-..." }                 │
    │  (default: latest in manifest.json)            │
    │                                                │
    ▼                                                │
  ensure ~/.xo-cowork/sync-checkouts/proj-1/         │
  git pull origin main ─────────────────────────────►│
    │                                                │
    ▼                                                │
  read manifest.json,                                │
  resolve snapshot_id (or use head_snapshot)         │
    │                                                │
    ▼                                                │
  reassemble chunks if multi-part                    │
    │                                                │
    ▼                                                │
  gpg --decrypt --passphrase ${PASSPHRASE}           │
                                                     │
  verify sha256 against manifest                     │
  if mismatch → 502 BAD_SNAPSHOT                     │
    │                                                │
    ▼                                                │
  if local working tree at ~/xo-projects/proj-1/ has │
  uncommitted local edits not in last_pulled:        │
    save them to .xo/restore-backup-<ts>/            │
    (the human can salvage manually)                 │
    │                                                │
    ▼                                                │
  extract tar into ~/xo-projects/proj-1/             │
  (overwrites matching files, adds new files,        │
   leaves untracked-by-snapshot files alone)         │
    │                                                │
    ▼                                                │
  update .xo/origin.json with last_pulled_version   │
  update .xo/sync_state.json                        │
  append .xo/timeline.jsonl event "snapshot.restored"│
    │                                                │
    ▼                                                │
  return { restored: "vNNNN-...", version: NNNN }
```

Default behavior on auto-poll (Phase 1.5 if we want it): on lifespan, every 60s, `git fetch` against each origin repo. If `head_version` advanced, optionally auto-restore (config flag); otherwise emit `event: snapshot.available` on `/api/sync/events` and let the user click "restore" in the UI.

### 3.6 Sharing flow

Almost completely offloaded to GitHub.

```
1. Owner first time on this project:
     POST /api/sync/projects/proj-1/init-origin
     { github_repo: "owner/cowork-project-proj-1",  // creates if missing
       passphrase_env_var: "BACKUP_PASSWORD" }       // or leave to default
   → cowork-api creates the repo via GitHub API (gh CLI under the hood),
     writes .xo/origin.json
   → first snapshot push happens automatically

2. Owner adds a member:
     POST /api/sync/projects/proj-1/share
     { github_username: "alice", role: "read"|"write" }
   → cowork-api calls GitHub API to add the collaborator
   → returns clone URL + reminder: "share the passphrase out-of-band"

3. Owner sends Alice the passphrase via Signal/Slack/etc.
   No invite token, no swarm-relay — GitHub already authenticates the pull.

4. Alice on her machine:
     POST /api/sync/projects/proj-1/clone
     { github_repo: "owner/cowork-project-proj-1",
       passphrase_env_var: "BACKUP_PASSWORD" }
   → cowork-api git-clones the repo to ~/.xo-cowork/sync-checkouts/proj-1/
   → reads manifest.json, finds head_snapshot
   → decrypts, extracts to ~/xo-projects/proj-1/
   → writes .xo/origin.json on Alice's side

5. From here on:
   • Either side calls /snapshot to push
   • Either side calls /restore to pull
   • Conflicts handled by `git pull --rebase` semantics on the manifest
   • Project file conflicts impossible because each commit is a full encrypted snapshot
```

### 3.7 Endpoint surface (Phase 1)

Five core endpoints. Everything else is optional polish.

```
─── origin setup ──────────────────────────────────────
POST   /api/sync/projects/{pid}/init-origin
       owner-only. Body: { github_repo, passphrase_env_var? }
       Creates the GitHub repo (private) + first snapshot.
       Writes .xo/origin.json.

POST   /api/sync/projects/{pid}/clone
       member side. Body: { github_repo, passphrase_env_var? }
       Clones origin, restores latest snapshot into ~/xo-projects/{pid}/.

DELETE /api/sync/projects/{pid}/origin
       owner-only. Detaches local project from origin.
       Does NOT delete the GitHub repo (do that via gh manually).

─── push / pull ───────────────────────────────────────
POST   /api/sync/projects/{pid}/snapshot
       Body: { message?: "..." }
       Returns:
         200 { snapshot, version, size, ts, encrypted_hash }
         409 NEEDS_PULL_FIRST { remote_head_version }
              — origin is ahead; restore first, then re-snapshot
         403 — no write access on the GitHub repo
         500 — gpg / git / github error (with actionable message)

POST   /api/sync/projects/{pid}/restore
       Body: { snapshot_id?: "vNNNN-..." }   default: latest
       Returns:
         200 { restored, version, ts }
         404 NO_SUCH_SNAPSHOT
         502 BAD_SNAPSHOT (checksum mismatch / decryption fail)

─── browse history ────────────────────────────────────
GET    /api/sync/projects/{pid}/snapshots
       Returns manifest.json contents (history list).
       No decryption. Cheap.

GET    /api/sync/projects/{pid}/status
       { role: "owner"|"member"|"none",
         origin: "github.com/...",
         local_version, remote_head_version, behind, ahead,
         dirty: bool,                             (working tree has uncommitted local edits)
         last_snapshot_at, last_restore_at }

─── sharing ───────────────────────────────────────────
POST   /api/sync/projects/{pid}/share
       owner-only. Body: { github_username, role }
       Adds GitHub collaborator. Returns reminder to share passphrase.

DELETE /api/sync/projects/{pid}/share/{github_username}
       owner-only. Removes GitHub collaborator.

─── live (optional, Phase 1.5) ────────────────────────
GET    /api/sync/events
       SSE: snapshot.created (mine), snapshot.available (remote advanced),
            restore.applied, conflict.manifest_rebased, error.
```

**No invite tokens, no swarm-relay endpoints, no peer registry, no WebSocket.** GitHub is the entire transport.

### 3.8 Auth + secrets

| Concern | How |
|---|---|
| Who is calling cowork-api? | xo-auth Bearer token, validated as before — gates which user_id is performing the action locally. |
| Who can write to the origin repo? | GitHub's own PAT-based authz. Owner adds collaborators via `/api/sync/projects/{pid}/share`. |
| Where is the GitHub PAT stored? | `~/.openclaw/.env` (existing), under `GITHUB_PAT` — same env var the OpenClaw backup-restore skill already uses. |
| Where is the encryption passphrase stored? | Env var named in `.xo/origin.json:passphrase_env_var` (default `BACKUP_PASSWORD`). cowork-api never persists it on disk except via the user's existing `.env`. |
| Cross-project passphrase? | Default: same `BACKUP_PASSWORD` for every project (matches OpenClaw skill). Override per-project by setting `passphrase_env_var: "XO_PROJECT_PROJ1_PASSPHRASE"`. |
| Can a member rotate the owner's passphrase? | No. Passphrase rotation = owner re-snapshots with a new passphrase, distributes new passphrase out-of-band, members `restore` with new passphrase. Old snapshots in history become unreadable for new members (acceptable). |
| RBAC inside one project (file-level grants)? | **Out of scope for Phase 1.** GitHub's read/write is the only granularity. Future Phase 2 with the WebSocket protocol can layer file-level ACLs via `<project>/.xo/policy.json` — that's where the prior RBAC plan kicks back in. |

### 3.9 Why this is dramatically simpler than the previous draft

| Aspect | Old (WebSocket-rebase) | New (GitHub-snapshot) |
|---|---|---|
| Transport to build | Custom WebSocket protocol over swarm relay | None — `git` + `gh` CLI subprocess calls |
| Conflict semantics | 409 NEEDS_REBASE + intersection detection + `<path>.local.<ts>` sidecars + retry queue | Whatever `git pull --rebase` does locally; manifest.json is the only file that ever auto-merges |
| Auth model | Clerk Bearer for cowork ↔ swarm + peer-grant table on swarm | Clerk Bearer for cowork (local auth) + GitHub PAT + GitHub collaborators (network auth) |
| Discovery | Need to invent invite tokens, peer-online state, offline message queue | None — GitHub repo URL is the discovery mechanism |
| Server-side work on swarm | New WebSocket relay endpoints, online-peer tracking, ADVANCE broadcast | **Zero changes to swarm-api** |
| Lines of code (rough) | ~2000 across cowork-api + swarm-api | ~500 in cowork-api, none in swarm-api |
| Real-time? | Yes, sub-second propagation | No — push/pull is on demand or polled. Acceptable for Phase 1. |
| Granularity? | Per-file deltas | Whole-project snapshots |
| Reuses existing code? | No | Yes — extend the OpenClaw backup-restore skill's encryption + chunking logic |

The cost is loss of real-time and per-file granularity. If Phase 1 ships and that proves limiting in practice, Phase 2 layers the WebSocket protocol on top of the same `<project>/.xo/` state. The visualizer Phase 1 work and the data on disk don't change.

---

## 4. The B2B chat-proxy angle

Same cowork-api binary, with `/api/chat/*` exposed as a public-ish surface for B2B clients building their own UI. Concretely:

- `/api/runtimes` — list of available runtimes (claude_code, openclaw, codex, custom-anthropic, custom-openai, ...)
- `/api/chat/prompt` and `/api/chat/stream/{id}` — already exist, already runtime-agnostic via the dispatcher
- New: `/api/chat/route` body field `runtime: "..."` to override the default per-request
- New: `/api/chat/keys` — manage per-tenant API keys for the chat path (separate from a B2B operator's own Clerk credentials)

The B2B client's stack:

```
[ Client's custom UI ]  ──HTTP──►  [ cowork-api on client's machine ]  ──CLI──►  [ runtime ]
                                          │
                                          └──optional sync──►  [ another cowork-api ]
```

Same architecture, different framing: instead of a power-user collaboration tool, it's a self-hostable agent gateway. Same code path.

---

## 5. Proposed repo structure

Two views — the **full tree** as it would look after Phase 1 + Phase 2 land, and the **minimal diff** against today's tree (purely additive, nothing deleted, chat untouched).

### 5.1 Full tree after Phase 1 + Phase 2

New code goes inside the existing `services/cowork_agent/` package and `routers/cowork_agent/` package — no new top-level packages — to follow the established convention (see also `architecture.md`).

```
xo-cowork-api/
│
├── server.py                                 ⚡ modified — start visualizer + sync transport on lifespan
├── claude_code_client.py                     unchanged — legacy /ask_question* only
├── codex_code_client.py                      unchanged — legacy /ask_question* only
│
├── routers/
│   ├── auth.py                               unchanged
│   ├── claude_setup_token.py                 unchanged
│   ├── codex_setup.py                        unchanged
│   ├── openclaw_usage.py                     unchanged
│   │
│   └── cowork_agent/
│       ├── chat.py                           UNCHANGED — first-class, no removal
│       ├── sessions.py                       ⚡ modified — also read ~/.claude/projects/*
│       ├── files.py                          ⚡ modified — .xo/* scaffold + PROJECT.md/PLAN.md/PROGRESS.md/TASKS.json
│       ├── agents.py                         unchanged
│       ├── config.py                         unchanged
│       ├── secrets.py                        unchanged
│       ├── channels.py                       unchanged
│       ├── workspace_memory.py               unchanged (still a stub)
│       ├── fts.py                            unchanged (still a stub)
│       ├── usage.py                          unchanged
│       ├── misc.py                           unchanged
│       ├── onboarding.py                     unchanged
│       ├── gdrive.py / onedrive.py / github.py / vercel.py / manus.py  unchanged
│       │
│       ├── sync.py                           ✨ NEW — /api/sync/*
│       ├── projects.py                       ✨ NEW — /api/projects/*
│       ├── todos.py                          ✨ NEW — /api/todos      (replaces /sessions/{id}/todos stub)
│       └── stats.py                          ✨ NEW — /api/stats
│
├── services/
│   ├── usage_sync.py                         unchanged
│   │
│   └── cowork_agent/
│       ├── dispatcher.py                     unchanged
│       ├── adapter_registry.py               unchanged
│       ├── adapters/                         unchanged
│       │   ├── base.py
│       │   ├── openclaw/{adapter,streaming,usage}.py
│       │   └── claude_code/{adapter,streaming}.py
│       ├── streaming.py                      unchanged
│       ├── chat_state.py                     unchanged
│       ├── sessions_io.py                    ⚡ modified — scan ~/.claude/projects/* too
│       ├── claude_sessions.py                unchanged
│       ├── messages.py                       unchanged
│       ├── agent_registry.py                 unchanged
│       ├── settings.py                       ⚡ modified — add PROJECTS_ROOT, CLAUDE_PROJECTS_DIR
│       ├── helpers.py                        unchanged
│       ├── xo_cowork_state.py                unchanged
│       ├── openclaw_env.py / openclaw_store.py    unchanged
│       ├── *_connector.py / rclone_oauth_lock.py  unchanged
│       │
│       ├── visualizer/                       ✨ NEW PACKAGE
│       │   ├── __init__.py
│       │   ├── watcher.py                       fs-watch over:
│       │   │                                      ~/.claude/projects/<encoded>/*.jsonl
│       │   │                                      ~/.claude/todos/*.json
│       │   │                                      ~/.openclaw/agents/*/sessions/*.jsonl
│       │   │                                      <project>/** (debounced)
│       │   ├── project_index.py                 session_id → project_root resolver
│       │   ├── todos.py                         mirror ~/.claude/todos/*.json → <proj>/.xo/todos.json
│       │   ├── stats.py                         rolling 7d/30d aggregations → <proj>/.xo/stats.json
│       │   ├── timeline.py                      append events → <proj>/.xo/timeline.jsonl
│       │   └── activity.py                      live "what's open right now" → <proj>/.xo/activity.json
│       │
│       └── sync/                              ✨ NEW PACKAGE — Phase 1, GitHub-backed snapshots
│           ├── __init__.py
│           ├── origin.py                        read/write <proj>/.xo/origin.json
│           │                                     (github_repo, passphrase_env_var, last_pulled_version)
│           ├── snapshot.py                      tar+gpg encrypt, chunk if >90 MB
│           │                                     (lifts the OpenClaw backup-restore algorithm,
│           │                                      pointed at <proj>/ instead of ~/.openclaw/)
│           ├── restore.py                       reverse direction: chunks → gpg decrypt → tar -x
│           │                                     into <proj>/, with checksum verify and local-edit
│           │                                     backup to <proj>/.xo/restore-backup-<ts>/
│           ├── github_repo.py                   thin wrapper around `gh` CLI for repo create,
│           │                                     collaborator add/remove, repo URL resolution
│           ├── git_ops.py                       subprocess wrapper for git clone/fetch/pull --rebase
│           │                                     /add/commit/push against the sync-checkouts dir
│           ├── manifest.py                      read/write/merge the manifest.json inside the
│           │                                     origin repo (history[] dedupe + sort on rebase)
│           └── exclude.py                       project-folder exclusion list (mirrors backup-restore)
│
├── config/
│   └── agents/
│       ├── openclaw/{commands,settings}.json
│       └── claude_code/{commands,settings}.json
│
├── utils/
│   ├── __init__.py
│   └── commands.py
│
├── docs/                                     gitignored (see .gitignore:58 — fix separately)
│   ├── architecture.md
│   ├── claude-vs-openclaw.md
│   ├── cowork-swarm-interactions.md
│   ├── filesystem-endpoints.md
│   ├── future-architecture-proposal.md       (superseded by this file)
│   ├── rbac-plan.md
│   ├── streaming-claude-vs-openclaw.md
│   └── visualizer-and-sync-plan.md           THIS FILE
│
├── cowork-api.sh                            unchanged — only top-level startup script (start|stop|restart|status|logs)
├── scripts/                                  ✨ NEW — relocated setup/update scripts
│   ├── update.sh                              ↩ moved from cowork-update.sh
│   ├── openclaw.sh                            ↩ moved from top-level
│   └── hermes.sh                              ↩ moved from top-level
├── Dockerfile / requirements.txt             unchanged (Dockerfile path refs may need bump)
├── .env.example                              ⚡ modified — sync env vars (XO_SYNC_RELAY_URL, XO_PROJECTS_ROOT, etc.)
├── .gitignore                                unchanged
├── README.md                                 unchanged
├── AGENTS.md / CLAUDE.md                     unchanged
└── .agents/skills/ / .claude/skills/         unchanged (skills used by THIS repo's AI dev agent)
```

### 5.2 On-disk state at runtime

The repo creates and reads these paths on the user's machine. Nothing here is in the git tree.

```
$HOME/
├── .claude/                                  Claude Code runtime — READ-ONLY for cowork
│   ├── projects/<encoded-path>/<sid>.jsonl     ← visualizer reads
│   ├── todos/<sid>-agent-<aid>.json            ← visualizer reads + mirrors to <proj>/.xo/todos.json
│   └── ... (untouched)
│
├── .openclaw/                                OpenClaw runtime — existing read/write paths
│   ├── openclaw.json
│   ├── .env
│   └── agents/<a>/sessions/...                 ← visualizer reads (existing)
│
├── .codex/                                   Codex runtime — READ-ONLY for cowork
│
├── .xo-cowork/
│   ├── state.json                            unchanged (onboarding etc.)
│   └── sync-checkouts/                       ✨ NEW — bare-bones git clones of each project's
│       └── <project_id>/                       origin repo. Used as the staging area for
│         ├── snapshots/*.tar.gz.gpg            push/pull. NEVER mixed with the user's
│         ├── manifest.json                     working ~/xo-projects/<pid>/ tree.
│         └── .git/
│
└── xo-projects/                              ✨ NEW canonical root — every cowork project lives here
    └── <project_id>/                          any folder under xo-projects/ that has a .xo/ inside
        │                                         is recognized as a cowork project; folders without
        │                                         .xo/ are ignored by the visualizer + sync
        ├── .xo/                                ✨ NEW per-project metadata (the marker that makes
        │                                         this folder "a project")
        │   ├── project.json                      identity: pid, name, owner_user_id, created_at
        │   ├── todos.json                        Phase 1 — aggregated session todos
        │   ├── stats.json                        Phase 1 — rolling stats
        │   ├── timeline.jsonl                    Phase 1 — append-only event log
        │   ├── activity.json                     Phase 1 — live activity heartbeat
        │   ├── origin.json                       Phase 1 — { github_repo, passphrase_env_var,
        │   │                                                  last_pulled_version, last_pushed_version }
        │   ├── restore-backup-<ts>/              Phase 1 — only present when local edits were
        │   │                                       displaced by a restore (manual recovery)
        │   ├── sync_state.json                   Phase 2 — per-machine state for live sync
        │   └── policy.json                       Phase 2 — per-project ACL (RBAC subset)
        ├── AGENTS.md                             existing scaffold (operating contract + 3 logs)
        ├── PROJECT.md                            ✨ NEW scaffold — what this project is for
        ├── PLAN.md                               ✨ NEW scaffold — current plan
        ├── PROGRESS.md                           ✨ NEW scaffold — running progress narrative
        ├── OBJECTIVES.md                         existing scaffold (OKRs)
        ├── TASKS.json                            ✨ NEW scaffold — machine-readable task list
        └── ... (work files: src/, docs/, etc.)
```

### 5.3 Diff view — code changes only

```
✨ NEW
  routers/cowork_agent/sync.py                  /api/sync/*   (peers, projects, push, pull, status, events)
  routers/cowork_agent/projects.py              /api/projects/*  (list, create, status, timeline)
  routers/cowork_agent/todos.py                 /api/todos       (replaces /sessions/{id}/todos stub)
  routers/cowork_agent/stats.py                 /api/stats

  services/cowork_agent/visualizer/__init__.py
  services/cowork_agent/visualizer/watcher.py
  services/cowork_agent/visualizer/project_index.py
  services/cowork_agent/visualizer/todos.py
  services/cowork_agent/visualizer/stats.py
  services/cowork_agent/visualizer/timeline.py
  services/cowork_agent/visualizer/activity.py

  services/cowork_agent/sync/__init__.py
  services/cowork_agent/sync/origin.py            .xo/origin.json read/write
  services/cowork_agent/sync/snapshot.py          tar + gpg encrypt + chunk
  services/cowork_agent/sync/restore.py           tar -x + gpg decrypt + verify
  services/cowork_agent/sync/github_repo.py       gh CLI wrapper (create, collaborate)
  services/cowork_agent/sync/git_ops.py           git CLI wrapper (clone/pull/push)
  services/cowork_agent/sync/manifest.py          repo-side manifest.json merge
  services/cowork_agent/sync/exclude.py           project-folder exclusion list

⚡ MODIFIED
  server.py                                     start visualizer watcher + sync transport on lifespan
  routers/cowork_agent/sessions.py              also scan ~/.claude/projects/*
  routers/cowork_agent/files.py                 .xo/ scaffold + PROJECT.md/PLAN.md/PROGRESS.md/TASKS.json
  services/cowork_agent/sessions_io.py          claude_code-projects scanner
  services/cowork_agent/settings.py             add XO_PROJECTS_ROOT, CLAUDE_PROJECTS_DIR
  .env.example                                  XO_SYNC_RELAY_URL, XO_PROJECTS_ROOT, sync defaults

📁 RELOCATED
  cowork-update.sh   →   scripts/update.sh
  openclaw.sh        →   scripts/openclaw.sh
  hermes.sh          →   scripts/hermes.sh
  (cowork-api.sh stays at top level — it's the only startup script)
  + Dockerfile path refs may need a one-line bump if any of these are invoked during build

🚫 NOT TOUCHED
  routers/cowork_agent/chat.py                  chat stays first-class, untouched
  routers/cowork_agent/agents.py / config.py / secrets.py / channels.py / usage.py / misc.py / onboarding.py /
    gdrive.py / onedrive.py / github.py / vercel.py / manus.py / fts.py / workspace_memory.py
  services/cowork_agent/dispatcher.py / adapter_registry.py / adapters/ / streaming.py / chat_state.py /
    claude_sessions.py / messages.py / agent_registry.py / helpers.py / xo_cowork_state.py /
    openclaw_env.py / openclaw_store.py / *_connector.py / rclone_oauth_lock.py
  claude_code_client.py / codex_code_client.py  legacy chat clients, kept
  config/agents/**                              runtime manifests, no changes
  utils/**                                      no changes
```

Net additions: **2 packages, ~15 modules, 4 new routers**. Net deletions: **zero**.

---

## 6. Phasing

API-only. UI work is out of scope.

```
Phase 1A — Visualizer foundation
   - services/cowork_agent/visualizer/watcher.py — fs watch over
     ~/.claude/projects/*, ~/.claude/todos/*, ~/.openclaw/agents/*, project trees
   - services/cowork_agent/visualizer/project_index.py — session_id → project_root
   - .xo/ folder scaffold (todos.json, stats.json, timeline.jsonl, activity.json,
     project.json)
   - routers/cowork_agent/todos.py, stats.py, projects.py — replace stubs with real data
   - routers/cowork_agent/sessions.py extended to scan ~/.claude/projects/*
   - Existing /api/chat/* untouched

Phase 1B — GitHub-backed snapshot sync
   - services/cowork_agent/sync/{origin,snapshot,restore,github_repo,
                                  git_ops,manifest,exclude}.py
   - routers/cowork_agent/sync.py with the 8 endpoints from §3.7:
       init-origin, clone, snapshot, restore, snapshots, status, share, share-revoke
   - .xo/origin.json schema defined
   - ~/.xo-cowork/sync-checkouts/<pid>/ as the staging area
   - Encryption: GPG AES-256, BACKUP_PASSWORD env (lifted from OpenClaw skill)
   - Chunking: 90 MB cap, identical algorithm to the OpenClaw skill
   - Exclusion list: per §3.3
   - History retention: last 10 snapshots in origin repo
   - swarm-api: ZERO changes
   - Existing /api/chat/* still untouched

Phase 1C (optional, ship if time permits) — Auto-poll
   - background task: every N seconds, `git fetch` each origin repo
   - if remote head_version > local last_pulled_version: emit
     `event: snapshot.available` on /api/sync/events
   - leave the actual restore as a user click

Phase 2 — Real-time WebSocket sync (only if Phase 1 proves too coarse)
   This is the previous draft's design, deferred:
   - swarm-api side: /sync/connect WebSocket + peer-grant table + ADVANCE relay
   - cowork-api side: per-file delta protocol + 409 NEEDS_REBASE
   - <project>/.xo/sync_state.json as authoritative per-machine state
   - Layered ON TOP of Phase 1 — GitHub origin remains as the durable backstop
     and onboarding mechanism; WebSocket is just the fast path between peers
     who are both online
   - Existing /api/chat/* still untouched

Phase 3 — Direct peer (NAT traversal) [deferred indefinitely]
   - Only relevant if Phase 2 ships and swarm-relay bandwidth becomes a cost issue

Phase 4 — B2B chat-proxy hardening [deferred until a real client]
   - /api/runtimes, per-tenant API keys, rate limiting, integration guide
```

---

## 7. Locked decisions

| # | Decision | Resolution |
|---|---|---|
| 1 | Pivot away from chat? | **No.** `/api/chat/*` stays first-class and untouched. New work is purely additive. |
| 2 | Sync transport for Phase 1? | **GitHub-backed encrypted snapshots.** Each shared project has an owner-owned private GitHub repo as origin. Push = create a GPG-AES-256 snapshot, commit, `git push`. Pull = `git pull`, decrypt, extract. Modeled on the existing OpenClaw [backup-restore skill](https://docs.xo.builders/agents/openclaw/skills/backup-restore). Real-time WebSocket sync is Phase 2, only if needed. |
| 3 | Conflict policy? | **Whatever git enforces.** Pushes to `main` must be fast-forward (GitHub's default branch protection). If rejected, member runs `git pull --rebase` locally; the only file that ever auto-merges is `manifest.json` (sort `history[]` by version, dedupe). Project content conflicts are impossible because each commit is a self-contained encrypted snapshot, not a delta. |
| 4 | Tauri dashboard view? | **Out of scope.** This plan is API-only. The desktop app is untouched. |
| 5 | B2B chat-proxy timing? | Phase 4. Triggered only by a real prospect. |
| 6 | What counts as a "project" on disk? | **Any folder under `~/xo-projects/` that contains a `.xo/` directory.** `~/xo-projects/` is the canonical root for every cowork project. Folders without `.xo/` are ignored. Drop a `.xo/` in to mark a folder as a project. |
| 7 | Owner identity rotation? | **Identity is bound to XO (Clerk `user_id`).** If the owner's machine dies, they can re-install cowork-api on a new machine, sign in with the same Clerk identity, and re-claim ownership of every project they previously owned. Identity ≠ machine. |
| 8 | Append-only timeline merge? | Confirmed: cowork-api auto-rebases `*.jsonl` files by sorted-by-timestamp concatenation **before** evaluating fast-forward, so members never see a conflict on `timeline.jsonl`. The protocol stays generic; the special case is local to the rebase implementation. |
