# XO project anatomy

What lives inside an XO project on disk, what writes each file, and how the frontend reads it via the cowork-api proxy. Ground truth pulled from the cowork-api repo:

- Scaffold template: `xo-cowork-api/services/cowork_agent/project_template/`
- Scaffold logic: `xo-cowork-api/services/cowork_agent/project_layout.py` (`scaffold_project()`, `_upsert_metadata()`, `list_projects()`)
- Operating contract: `project_template/AGENTS.md` (what each layer is for; who writes)

This doc is the layer of truth between the official endpoint docs ([`frontend-files-api.md`](frontend-files-api.md), [`visualizer-and-sync-plan.md`](visualizer-and-sync-plan.md)) and the on-disk reality. The endpoint docs describe the API; this one describes the schema your frontend will see when it reads each file.

---

## 1. What makes a folder "a project"

```
~/xo-projects/<id>/
├── AGENTS.md
├── CLAUDE.md
├── PROJECT.md
├── OBJECTIVES.md
├── PLAN.md
├── PROGRESS.md
├── memory/
│   ├── semantic/{constraints,preferences,project-facts}.md
│   ├── episodic/README.md
│   ├── procedural/README.md
│   └── working/.gitkeep
└── .xo/
    ├── project.json
    ├── todos.json
    ├── stats.json
    ├── timeline.jsonl
    ├── activity.json
    ├── sync.json
    ├── peers.json
    └── sessions/sessionslist.json
```

A directory under `xo-projects/` (i.e. under `roots[default]` from `/api/config/workspace`) is recognized as an XO project iff it contains `.xo/project.json`. `list_projects()` in `project_layout.py` skips:

- Hidden directories (`.xxx`)
- Anything missing `.xo/project.json`

Two persistence layers, distinct purposes (see `AGENTS.md`):

| Layer | Owner | Persists | Purpose |
|---|---|---|---|
| `memory/` and project-root markdown | Agent (+ human) | Committed to git | Shared cognition: distilled facts, OKRs, plan, progress narrative. |
| `.xo/` | **Watcher service only** | Gitignored | Ephemeral per-machine state. Identity, sessions, timeline, todos, stats, activity, sync, peers. |

**Agents read `.xo/`. Agents never write it.** Quoted from `AGENTS.md`: "A background watcher service owns this directory: identity, sessions, timeline, todos, stats, activity, sync, peers, schemas. It tails runtime logs (Claude Code's `~/.claude/projects/…`, OpenClaw's `~/.openclaw/agents/…`, etc.) and your in-flight todos. Agents only read `.xo/`. Never write."

> **As of today the watcher service is not yet built** (per [`visualizer-and-sync-plan.md`](visualizer-and-sync-plan.md) §6 Phase 1A). Most `.xo/*` files in real projects are still in their template-emptied state. The frontend renders empty-state panels in those cases.

---

## 2. Project-root files (agent-writable)

Stable on the order of weeks, edited by the agent in co-edit with the human.

| File | Purpose | Cadence |
|---|---|---|
| `AGENTS.md` | Operating contract every agent reads first. Don't edit casually. | Weeks |
| `CLAUDE.md` | One-line `@AGENTS.md` pointer Claude Code reads at boot. | n/a |
| `PROJECT.md` | Scope, audience, stack. Each section starts as `[TEMPLATE]` and the agent replaces on first boot. | Weeks |
| `OBJECTIVES.md` | North-star OKRs. Edit when objectives genuinely shift, not when tasks do. | Weeks |
| `PLAN.md` | Current plan. Agent-maintained. Updated when the plan changes, not at session boundaries. | Days |
| `PROGRESS.md` | Running narrative of what got done. **Append-only**; one paragraph per session at close. | Per session |

Every template file ships with `[TEMPLATE]` markers in the body so a freshly scaffolded project visibly screams "fresh" until the agent rewrites them.

---

## 3. `memory/` subdirectories (agent-writable)

| Path | Purpose | Visible to other agents? |
|---|---|---|
| `memory/semantic/` | Distilled facts, preferences, constraints. Three seed files: `constraints.md`, `preferences.md`, `project-facts.md`. | Yes (committed) |
| `memory/episodic/` | Per-session summaries of past episodes. Each session contributes one entry. | Yes (committed) |
| `memory/procedural/` | Reusable procedures the agent learned during this project. | Yes (committed) |
| `memory/working/` | In-flight scratch. `.gitkeep` keeps the dir tracked while contents are gitignored at the project level. | No (gitignored) |

Frontend rarely reads these directly; they're rendered if the project page ships a "knowledge" surface later. The visualizer doesn't read them today.

---

## 4. `.xo/*` sidecar files (watcher-written)

All eight files are present immediately after `scaffold_project()` runs. The watcher updates them over time; until it ships, most stay in the initial-empty state shown below.

### 4.1 `.xo/project.json`

**Scaffold template** (`project_template/.xo/project.json`):

```jsonc
{
  "$schema": "./schema/project.schema.json",
  "schema": 1,
  "_template": true,
  "pid": null,
  "name": null,
  "owner_user_id": null,
  "created_at": null
}
```

After `_upsert_metadata()` runs at scaffold time:

```jsonc
{
  "$schema": "./schema/project.schema.json",
  "schema": 1,
  "_template": true,                       // STAYS true until the watcher clears it
  "pid": null,                              // never set by scaffold
  "name": "blackhole",                      // set to the normalized directory name
  "owner_user_id": null,                    // never set by scaffold
  "created_at": "2026-05-12T07:01:23+00:00", // UTC ISO from scaffold time
  "display_name": "Blackhole",              // from the create body, else falls back to name
  "description": "Internal research…"      // from the create body, else ""
}
```

Notes:

- **`pid`** is never written by the current scaffold. Use **`name`** as the canonical id for lookups; it equals the directory name on disk.
- **`_template: true` stays true forever** until the (unbuilt) watcher service finalizes the project. The visualizer surfaces this with a "Template" chip.
- **`$schema`** points to a `schema/` directory next to `.xo/` which does not currently exist in the cowork-api repo. Treat the field as a forward-looking hint; don't validate against it.
- **`owner_user_id`** is reserved for the sync layer (Phase 1, [`visualizer-and-sync-plan.md`](visualizer-and-sync-plan.md) §3.8); not used today.

### 4.2 `.xo/todos.json`

**Scaffold:**

```jsonc
{ "$schema": "./schema/todos.schema.json", "schema": 1, "updated_at": null, "sessions": {} }
```

**Populated shape** (per [`visualizer-and-sync-plan.md`](visualizer-and-sync-plan.md) §2):

```jsonc
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
        { "id": "3", "content": "Wire RBAC routes", "status": "pending" }
      ]
    },
    "ses_def456": { "runtime": "openclaw", "todos": [...] }
  }
}
```

`status` is one of `pending` / `in_progress` / `completed`. Watcher mirrors `~/.claude/todos/*.json` and `~/.openclaw/agents/*/sessions/*.jsonl` here per session, keyed by session id.

### 4.3 `.xo/stats.json`

**Scaffold** (zero-initialized, not absent):

```jsonc
{
  "$schema": "./schema/stats.schema.json",
  "schema": 1,
  "updated_at": null,
  "rolling": {
    "7d":  { "tokens": { "input": 0, "output": 0 }, "by_model": {}, "files_edited": 0, "sessions": 0, "active_minutes": 0 },
    "30d": { "tokens": { "input": 0, "output": 0 }, "by_model": {}, "files_edited": 0, "sessions": 0, "active_minutes": 0 }
  },
  "by_session": {},
  "by_runtime": {}
}
```

**Populated shape:**

```jsonc
{
  "schema": 1,
  "updated_at": "...",
  "rolling": {
    "7d":  { "tokens": {"input": 1234567, "output": 234567},
             "by_model": {"claude-sonnet-4.5": {...}, "gpt-5": {...}},
             "files_edited": 142, "sessions": 23, "active_minutes": 1456 },
    "30d": { ... }
  },
  "by_session": { "ses_abc123": { "tokens": {...}, "files": [...], "duration_ms": 3600000 } },
  "by_runtime": { "claude_code": {...}, "openclaw": {...} }
}
```

Watcher rebuilds the whole file every ~60s (per [`visualizer-and-sync-plan.md`](visualizer-and-sync-plan.md) §2.5).

### 4.4 `.xo/timeline.jsonl`

**Scaffold:** empty 0-byte file.

**Populated:** append-only, one JSON object per line. The doc lists nine event types:

```
{"ts":"...","type":"session.started","session_id":"...","runtime":"claude_code","user_id":"..."}
{"ts":"...","type":"todo.added","session_id":"...","todo":{"id":"1","content":"..."}}
{"ts":"...","type":"todo.completed","session_id":"...","todo_id":"1"}
{"ts":"...","type":"file.edited","path":"src/foo.py","session_id":"..."}
{"ts":"...","type":"file.created","path":"docs/new.md","session_id":"..."}
{"ts":"...","type":"plan.written","path":".claude/plans/abc.md","session_id":"..."}
{"ts":"...","type":"peer.sync.started","peer_user_id":"..."}
{"ts":"...","type":"peer.sync.applied","peer_user_id":"...","files":["src/foo.py"]}
{"ts":"...","type":"peer.sync.conflict","path":"src/bar.py","peers":["user_a","user_b"]}
```

Frontends should tolerate torn / malformed lines (append-only file may be read mid-write). `lib/cowork-client.ts:files.jsonl()` already does this.

### 4.5 `.xo/activity.json`

**Scaffold:**

```jsonc
{ "$schema": "./schema/activity.schema.json", "schema": 1, "updated_at": null, "open_sessions": [] }
```

**Populated:**

```jsonc
{
  "schema": 1,
  "updated_at": "2026-05-12T...",
  "open_sessions": [
    { "session_id": "ses_abc123", "runtime": "claude_code", "last_activity": "..." }
  ]
}
```

> **Gotcha:** [`visualizer-and-sync-plan.md`](visualizer-and-sync-plan.md) §2 describes this file vaguely as "live: which sessions are open right now". The actual field is **`open_sessions`** (array), **not** `sessions`. Don't be fooled by the doc wording; the scaffold + watcher use `open_sessions`. The visualizer was buggy on this for one revision before being corrected against the template.

### 4.6 `.xo/sync.json`

**Scaffold:**

```jsonc
{ "$schema": "./schema/sync.schema.json", "schema": 1, "last_sync_at": null, "peers": {} }
```

Owned by the sync subsystem (see [`visualizer-and-sync-plan.md`](visualizer-and-sync-plan.md) §3). `peers` is keyed by peer user id, value opaque to the visualizer today. Not surfaced in the UI yet.

### 4.7 `.xo/peers.json`

**Scaffold:**

```jsonc
{ "$schema": "./schema/peers.schema.json", "schema": 1, "updated_at": null, "peers": [] }
```

Array of collaborators. Per-entry shape (github_username, role, added_at, ...) isn't pinned down yet. Owned by the sync subsystem. Not surfaced in the UI yet.

### 4.8 `.xo/sessions/sessionslist.json`

**Scaffold:** the template ships a 0-byte file; `scaffold_project()` then writes `{}` so it's always at least an empty JSON object. Comment in `project_layout.py`: *"sessionslist.json is a system file the harness reads/writes; not in the template. It holds session metadata only; messages stay in the provider's own storage."*

Frontend doesn't read this today; it's an internal harness file. Surfaced here for completeness so nobody accidentally treats it like one of the visualizer sidecars.

---

## 5. Reading `.xo/*` from the frontend

All access goes through the same generic cowork proxy used by the connectors UI:

```
GET  /api/cowork/{projectId}/config/workspace        → projects root
POST /api/cowork/{projectId}/files/list-directory    → top-level dirs under root
POST /api/cowork/{projectId}/files/content           → read .xo/<file>.json
```

Typed client: [`lib/cowork-client.ts`](../lib/cowork-client.ts). Two purpose-built helpers do the JSON/JSONL parsing so call sites stay clean:

```typescript
const c = cowork(projectId);

// JSON file → parsed `T`
const manifest = await c.files.json<XoProjectManifest>(
  `${projectsRoot}/${name}/.xo/project.json`,
);

// JSONL file → parsed `T[]` (skips torn lines), optional tail slice
const events = await c.files.jsonl<XoTimelineEvent>(
  `${projectsRoot}/${name}/.xo/timeline.jsonl`,
  { limit: 100 },
);
```

Both helpers throw `CoworkError` (with the upstream status) on read failure. The visualizer wraps every `.xo/*` read in a per-file try/catch that maps 404 to `null` so each panel can render its empty state independently.

### Path conventions

| What | How |
|---|---|
| Projects root | `cfg.roots[cfg.default]` from `/api/config/workspace`. **Never hardcode `~/xo-projects/`**; it's overridable via `XO_PROJECTS_ROOT`. |
| Project root | `${projectsRoot}/${dirName}`. `dirName` is what `list-directory` returns under `dirs[].name`. |
| `.xo/` paths | `${projectsRoot}/${dirName}/.xo/<file>` |
| Path safety | Every `path` is home-clamped server-side. Always pass absolute paths the cowork-api resolved against `roots[default]`. Symlink-out is a known leak ([`frontend-files-api.md`](frontend-files-api.md) §1). |

---

## 6. Visualizer mapping

What the per-XO-project page at `/projects/[projectId]/work/projects/[xoProjectName]` reads, and which panel renders it:

| Panel | Source file | Empty-state trigger |
|---|---|---|
| Identity | `.xo/project.json` | Always present after scaffold. Falls back to directory name + "(no description)" if the file is missing. |
| Activity | `.xo/activity.json` `open_sessions[]` | Watcher hasn't populated. Shows "No active sessions". |
| Stats | `.xo/stats.json` `rolling.7d` | All zeros until the watcher runs. Shows zero tiles or an empty hint. |
| Todos | `.xo/todos.json` `sessions{}` | No sessions tracked yet. Shows "No todos tracked". |
| Timeline | `.xo/timeline.jsonl` (newest first, last 30 of 100 lines pulled) | File is empty. Shows "No events recorded". |

`sync.json`, `peers.json`, and `sessions/sessionslist.json` are not surfaced yet; they're plumbed types in [`lib/cowork-client.ts`](../lib/cowork-client.ts) (`XoSyncFile`, `XoPeersFile`) for when the sync UI lands.

---

## 7. Slug rules (for create-project)

`scaffold_project(name)` normalizes the directory name via `normalize_agent_id()` (in `services/cowork_agent/helpers.py`):

```python
1. None or empty → "main"
2. Trim, lowercase.
3. If matches /^[a-z0-9][a-z0-9_-]*$/ → return as-is.
4. Otherwise:
   a. Replace any non-[a-z0-9_-] run with a single "-".
   b. Strip leading + trailing dashes.
   c. Truncate to 64 chars.
   d. If empty after cleanup → "main".
```

The on-disk directory will be the normalized form, even if the create call sent something different. The response's `path` field reflects the normalized path. Use the same algorithm client-side if you want to preview the slug before submit (`NewProjectDialog` does, with a stricter `[^a-z0-9]+` rule that produces the same result for the inputs the user is likely to type).

---

## 8. Things that surprised me

A short list so future me doesn't have to rediscover them by reading source.

1. **`pid` is never written by the scaffold.** Always `null`. Use `name` as the project id.
2. **`_template: true` is sticky.** It only flips when the (unbuilt) watcher finalizes the project.
3. **`activity.json` field is `open_sessions`, not `sessions`.** The plan doc is vaguely worded.
4. **`stats.json` is zero-initialized, not absent.** A freshly scaffolded project shows real zeros, not "no data". The empty-state hint in the visualizer should key on `updated_at == null` to distinguish.
5. **`timeline.jsonl` and `sessionslist.json` ship as 0-byte files** in the bundled template. `scaffold_project()` writes `{}` to `sessionslist.json` after the copy; `timeline.jsonl` stays empty.
6. **The `$schema` field is aspirational.** No `schema/` directory exists yet in the cowork-api repo.
7. **`memory/` is at the PROJECT ROOT, not inside `.xo/`.** The top-of-file docstring in `project_layout.py` shows them under `.xo/`; the actual template puts them at the project root, and that's what the scaffold copies.
8. **The whole `.xo/` directory is watcher-only.** Anything that writes to it from the frontend or an agent corrupts sync state. The frontend only reads.

---

## 9. References

- [`frontend-files-api.md`](frontend-files-api.md): `/api/files/*` HTTP surface (`mkdir` with `scaffold:true`, `content`, `list-directory`, `upload`)
- [`frontend-agents-config-api.md`](frontend-agents-config-api.md) §14: `/api/config/workspace` (projects root discovery)
- [`visualizer-and-sync-plan.md`](visualizer-and-sync-plan.md): original schema spec + watcher design + Phase 1 sync
- `xo-cowork-api/services/cowork_agent/project_layout.py`: Python source of truth for the scaffold
- `xo-cowork-api/services/cowork_agent/project_template/`: bundled template the scaffold copies from
- `xo-cowork-api/services/cowork_agent/project_template/AGENTS.md`: the operating contract every agent reads
- [`lib/cowork-client.ts`](../lib/cowork-client.ts): typed frontend client; `cowork(projectId).files.{json,jsonl,content,list-directory,…}`
- [`components/projects/work/CoworkProjectVisualizer.tsx`](../components/projects/work/CoworkProjectVisualizer.tsx): the visualizer this doc was written alongside
