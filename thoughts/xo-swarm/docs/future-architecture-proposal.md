# cowork-api: ideal future structure

A proposal based on the May 7 sync. This is one cohesive interpretation of where the team wants to go; reject any piece you disagree with and we'll iterate.

---

## What I heard you actually deciding

The thread that ties the meeting together, dropping the orchestrator/channel confusion:

> **Stop building an agent. Start building a project.**

Today's `cowork-api` runs OpenClaw, owns sessions, owns scaffolding, owns the chat. Project and agent are fused: open a different folder in Claude Code and the whole thing collapses.

Your proposal flips that:

| Layer | What it is | Where it lives |
|---|---|---|
| **Project** | The data layer. A folder full of work product, plus wiki/objectives/plan/progress/skills/hooks. **Portable, shareable, forkable.** | `~/projects/<project-id>/` |
| **Identity** | The agent's persona, memory, skills, OAuth credentials. **Stays with the user.** | `~/.openclaw/`, `~/.claude/`, `~/.codex/`, ... |
| **Runtime** | OpenClaw / Claude Code / Codex / Hermes. Picks up Project + Identity at attach time. | external binaries |
| **cowork-api** | A thin **project surface** + chat broker. Attaches a runtime to a project. Doesn't *contain* an agent. | this repo |

Everything else in your proposal falls out of this split: open-source friendliness, confidentiality guarantees, the fork/subtree sharing model, the no-orchestration position. The current code is mostly compatible with it — we just need to flip the center of gravity.

---

## The new core abstraction: Project

A project is a single folder. That's it. Anyone with the folder can do the work.

```
~/projects/<project-id>/                      ← the only thing that ships when you share
├── .xo/                                      ← project metadata (small, versioned)
│   ├── project.json                          {id, name, owner, created, signing_key_pub}
│   ├── manifest.json                         active runtime hint, allowed runtimes
│   ├── policy.json                           per-folder ACLs (rbac inside one project)
│   └── log.jsonl                             append-only audit (who did what, signed)
│
├── AGENTS.md                                 agent operating contract (existing scaffold)
├── PROJECT.md                                what this project is for
├── OBJECTIVES.md                             OKRs (existing)
├── PLAN.md                                   current plan
├── PROGRESS.md                               running progress log
├── TASKS.json                                machine-readable task list
├── wiki/                                     anything markdown the agent maintains
│
├── .skills/                                  project-scoped skills (project ships them)
│   └── <skill-name>/SKILL.md
├── .hooks/                                   project-scoped hooks (lint, cleanup, build)
│   └── *.sh
│
├── src/                                      actual code/work
└── ...
```

**Critical separation:**
- `~/projects/<project-id>/` is what gets `git push`'d, `git pull`'d, forked, shared, opened in plain Claude Code, or zipped into a sandbox.
- `~/.openclaw/`, `~/.claude/`, `~/.codex/` **never leave the user's machine.** Identity, billing, OAuth tokens, persona, memory — all stay there.

This is the confidentiality guarantee Ali asked for. You can give it in plain language to enterprise: *"Your agent's identity, memory, and credentials cannot leave your workspace by design — only the project folder is portable."*

---

## What cowork-api becomes

A **Project Surface** with a thin runtime adapter. Roughly:

```
                     ┌──────────────────────────────────────────┐
                     │                cowork-api                 │
                     │                                            │
                     │  /api/projects/*       ← NEW first-class  │
                     │     create / list / open / share /         │
                     │     fork / attach / detach                 │
                     │                                            │
                     │  /api/projects/{pid}/...                   │
                     │     files / sessions / chat / wiki /       │
                     │     skills / hooks / log / policy          │
                     │                                            │
                     │  /api/runtimes/*       ← NEW              │
                     │     list / status / install / health       │
                     │                                            │
                     │  /api/identity/*       ← NEW              │
                     │     who-am-i / oauth / .openclaw secrets   │
                     │                                            │
                     │  /api/sync/*           ← NEW              │
                     │     status / push / pull / fork (HUMAN)    │
                     │                                            │
                     │  /xo-auth/*            ← unchanged         │
                     └──────────┬───────────────────────────┬─────┘
                                │                           │
                                ▼                           ▼
                ┌────────────────────────┐    ┌────────────────────────┐
                │  Project Repository    │    │  Runtime Attachment     │
                │  ~/projects/<pid>/     │    │  (subprocess/process:    │
                │  + .xo/ + git          │    │   openclaw / claude /    │
                │                        │    │   codex / hermes)        │
                └────────────────────────┘    └────────────────────────┘
                                │                           │
                                └────────► subprocess cwd ◄─┘
```

Today's `/api/files`, `/api/sessions`, `/api/agents`, `/api/secrets`, `/api/connectors` mostly stay — they just **move under `/api/projects/{project_id}/...`** so they're project-scoped. Nothing is ambient anymore.

The current adapter layer (`services/cowork_agent/adapters/{openclaw, claude_code}`) is on the right track but agent-centric. It needs to flip: the adapter doesn't "own" sessions — it's stateless and attaches to a Project.

---

## Endpoint reshape (keep what works, scope it)

```
LEGACY (ambient)                       FUTURE (project-scoped)
─────────────────────                  ───────────────────────
GET  /api/sessions                     GET  /api/projects/{pid}/sessions
GET  /api/messages/{sid}               GET  /api/projects/{pid}/sessions/{sid}/messages
POST /api/files/upload                 POST /api/projects/{pid}/files/upload
POST /api/files/list-directory         POST /api/projects/{pid}/files/list-directory
POST /api/files/save                   POST /api/projects/{pid}/files/save
POST /api/files/mkdir                  POST /api/projects/{pid}/files/mkdir
GET  /api/secrets/env                  GET  /api/identity/secrets        (user-scope)
POST /api/agents                       (deleted — agents aren't a thing here anymore)
POST /api/chat/prompt                  POST /api/projects/{pid}/chat/prompt
GET  /api/chat/stream/{sid}            GET  /api/projects/{pid}/chat/stream/{sid}
/api/connectors/*                      /api/identity/connectors/*
                                       (connectors belong to user, not project)
```

New routes that follow from the proposal:

```
POST   /api/projects                       create new project (scaffolds .xo/, AGENTS.md, ...)
GET    /api/projects                       list projects this user can see
POST   /api/projects/{pid}/attach          attach a runtime: {runtime: "openclaw"|"claude_code"|...}
POST   /api/projects/{pid}/detach          detach (kill subprocess if running)
POST   /api/projects/{pid}/fork             local fork: copy to new project_id
POST   /api/projects/{pid}/share/grant     local ACL grant (RBAC inside the project)
POST   /api/projects/{pid}/sync/push       human-initiated git push to the channel remote
POST   /api/projects/{pid}/sync/pull       human-initiated git pull from the channel remote
POST   /api/projects/{pid}/sync/status     dirty/clean/ahead/behind
GET    /api/projects/{pid}/log             tail the .xo/log.jsonl (signed audit)
GET    /api/runtimes                       which runtimes are installed locally
```

Sync routes are explicitly human-only. The agent has a *skill* that says **"suggest pushing now"** and writes a row in `PROGRESS.md`, but it never calls `/sync/push` itself. Push/pull stays a human accountability point exactly as you said in the meeting.

---

## Sharing model (Sagar + Rohini's git thread, resolved)

```
                   "Channel" = shared git remote
                           ▲
                           │
              ┌────────────┴────────────┐
              │                         │
┌──────────────────────┐    ┌──────────────────────┐
│ User A               │    │ User B               │
│ ~/projects/proj-1/   │    │ ~/projects/proj-1/   │
│ + .xo/               │    │ + .xo/               │
│ + AGENTS.md          │    │ + AGENTS.md          │
│ + PLAN.md            │    │ + PLAN.md            │
│ ...                  │    │ ...                  │
│                      │    │                      │
│ ~/.openclaw/         │    │ ~/.openclaw/         │
│  identity, memory    │    │  identity, memory    │
│  STAYS LOCAL ────────┘    │  STAYS LOCAL ────────┘
│                                                  │
│ git push/pull is HUMAN-ONLY                      │
│ (button in Tauri, /api/projects/{pid}/sync/push)│
│                                                  │
│ commits are signed via .xo identity              │
│ → every change attributable to a user_id         │
```

Two physical patterns work; pick later:

**(a) One repo per channel.** Simple. `~/projects/<pid>/` is its own git repo. `git remote = <channel-url>`. Push/pull is whole-project.

**(b) Subtrees (Chromium model you brought up).** One umbrella repo with a subtree per shared subfolder. Lets a project be partially-shared (some folders private, some channel'd). Heavier; defer until single-repo-per-channel is too restrictive.

Either way the agent identity files **never enter git** (`.gitignore` for `~/.openclaw/`, `~/.claude/`).

---

## Identity model (what your `.xo` proposal becomes concretely)

Tying Ankit's earlier signing thread to the project model:

```
~/.xo/identity.json
{
  "user_id":      "user_2bX9aB7cdEfGhI",      // Clerk user_id from xo-swarm-api
  "display":      "Suraj",
  "signing_key":  <ed25519 keypair>,           // generated locally, never leaves
  "issued_at":    "...",
  "issued_by":    "xo-swarm-api"               // attestation only
}
```

- xo-auth Bearer token (Clerk) authenticates at the **HTTP layer** (everything we already documented).
- `signing_key` signs **every project log entry** (`.xo/log.jsonl`) and every commit, so when User B pulls User A's work, User B can cryptographically verify what changed and by whom.
- Other agents read each other's commits, never each other's identity files.

This is a clean superset of the RBAC plan: the workspace user list (`~/.cowork/users.json`) becomes a list of `user_id`s with their public signing keys. Project-internal grants live in `<project>/.xo/policy.json`.

---

## Runtime adapter contract (revised)

Keep the existing `BaseAgentAdapter` but change semantics. Today an adapter owns a sessions tree under its own root. Tomorrow:

```python
class RuntimeAdapter(ABC):
    name: str
    def is_installed(self) -> bool: ...
    def health(self) -> dict: ...

    # The adapter does NOT own sessions or the project tree.
    # It is attached to a project root and given a session_id.

    async def stream(
        self,
        project_root: Path,
        session_id: str,         # generated by cowork-api, not the runtime
        question: str,
        skill: str | None,
    ) -> AsyncIterator[Event]: ...

    # Persistence is *project-side*. cowork-api writes the JSONL,
    # not the runtime's own conf dir.
```

What changes:
- `~/.openclaw/agents/<a>/sessions/`, `~/claude-cowork/<a>/sessions/` go away **as the canonical session store**. They become runtime-internal cache only. The truth lives in `<project>/.xo/sessions/{session_id}.jsonl`.
- Session lookup (`find_session_backend`) collapses: the project owns the session, and the project knows which runtime created it. No more cross-tree scanning.
- Skills move from `config/agents/<runtime>/commands.json` to `<project>/.skills/<name>/SKILL.md`. cowork-api injects them into the runtime invocation.
- Hooks move similarly to `<project>/.hooks/`.

This makes "open this folder in plain Claude Code" actually work — the skills and hooks are right there, no cowork-api needed.

---

## Lifecycle: per-turn now, long-running later

You explicitly want long-running agents (self-pruning memory, evolving skills). The honest staging:

```
Phase A — what we have now
   Per-turn: POST /api/chat/prompt → spawn → stream → exit
   (current ClaudeCodeAdapter / OpenclawAdapter behavior)

Phase B — long-lived process per (project, runtime)
   POST /api/projects/{pid}/attach starts a long-running subprocess
   Subsequent /chat/prompt sends a message into the running process via stdin/IPC
   Process persists across requests until /detach or idle-timeout
   Memory pruning, self-evolution, all become possible because the process
   has continuity

Phase C — agent-initiated activity
   The long-running process can emit events (proactive PROGRESS.md updates,
   suggested pushes, etc.) via SSE on a project event channel.
   Still no autonomous git push — those events go to a human inbox.
```

The Phase A → B step is mostly a process-management problem and a Tauri UI problem, not an architecture rewrite. The structure above already accommodates it.

---

## What ports cleanly, what gets cut

**Ports cleanly:**
- xo-auth flow (already user-scoped — perfect for the new model)
- Adapter dispatcher pattern (rescope from agents to runtimes)
- File endpoints (move under `/api/projects/{pid}/files/*`)
- Streaming SSE format (keep `event: text-delta`/`done`/`heartbeat`/`session-created`)
- Connectors (rescope to user-identity, not project)

**Gets cut or hidden:**
- `/api/agents/*` (agents-as-records-in-openclaw.json) — that data is now `~/.openclaw/` runtime config, not a cowork concept
- Cross-tree session scanning in `sessions_io.py` — replaced by project-local `<project>/.xo/sessions/`
- The OpenClaw-specific bootstrap-prefetch dance in `chat.py` — once sessions live in the project, the new-vs-existing branching gets simpler
- Direct ambient `/api/files/*` (no project context) — only allowed in legacy/migration mode

**New code you don't have yet:**
- `services/projects/` — project CRUD, scaffold, `.xo/` writes
- `services/projects/sync.py` — git push/pull wrapping
- `services/projects/policy.py` — `.xo/policy.json` reader (subset of the RBAC plan, scoped per-project)
- `services/identity/` — user-scoped key + connector home

---

## Migration path (keep prod working)

Six steps, each independently shippable:

```
Step 1   Add /api/projects + project_root concept; existing routes accept
         ?project_id= as a query/body field. Default project = "legacy"
         pointing at $HOME so today's frontend keeps working.

Step 2   Move skills + hooks into <project>/.skills + .hooks. Adapters read
         them from there instead of config/agents/.

Step 3   Move sessions JSONL writes into <project>/.xo/sessions/ alongside
         the existing locations (dual-write). Reads still fall back to old
         paths.

Step 4   Add /api/identity/* routes; rescope /api/connectors/* + /api/secrets/*
         underneath. Migrate frontend calls.

Step 5   Add /api/sync/{push,pull,status} backed by per-project git remote.
         Add the corresponding Tauri buttons. Agents gain a "suggest push"
         skill but cannot call sync routes.

Step 6   Add long-running attach mode behind a feature flag.
         Keep per-turn as default until Tauri UI catches up.

Step 7   Cleanup: remove the legacy ambient endpoints, drop dual-write,
         delete /api/agents.
```

The RBAC plan we already wrote slots in at Step 4: project-internal `.xo/policy.json` is the per-project version of `~/.cowork/users.json`.

---

## What I'd want you to confirm before any code moves

These are the decisions where I don't want to guess:

1. **Project granularity.** Is "project" the right unit, or do you also want sub-projects (channels-within-projects, à la subtrees)? Recommendation: ship single-level projects first, add subtrees only if a real channel needs it.
2. **Project location on disk.** `~/projects/<id>/` (clean), or honor whatever folder the user already has and let cowork-api just *adopt* it? The latter is more open-source-friendly (any folder becomes a project by getting a `.xo/`).
3. **Sessions: project-bound or user-bound?** Today they're agent-bound. Project-bound is cleaner for sharing; user-bound is cleaner for identity. Recommendation: project-bound, with the user_id stamped on each turn.
4. **Skills shipping with the project.** Do shared projects ship their skills, or do recipients use only their own? Recommendation: ship skills *as suggestions* — recipients have to opt-in by copying into their own skill folder.
5. **Long-running agents in the architecture today, or strictly later?** I've put them in Phase B/C. If you want them as a Phase A constraint, the runtime adapter contract needs another revision.
6. **What happens to existing OpenClaw `/api/chat/*` consumers** during the migration. Recommendation: keep them on the legacy path until Step 7; new clients use the project-scoped routes.

---

## TL;DR for this proposal

> **Stop being an agent host. Become a project surface.** Make `Project` the first-class entity, give it a single folder with `.xo/` metadata, route every existing endpoint under `/api/projects/{pid}/`, keep agent identity in `~/.openclaw/` (never shared), make sharing a human-initiated git push/pull on a per-project remote, and let any runtime — OpenClaw, Claude Code, Codex, Hermes, future ones — attach to the same project folder without modification. The RBAC plan we wrote slots in unchanged but per-project. Long-running agents become a runtime-attach mode in Phase B. The whole shift is iterative; nothing requires a rewrite.
