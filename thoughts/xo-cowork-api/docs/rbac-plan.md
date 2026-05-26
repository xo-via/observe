# RBAC for filesystem endpoints — design plan (xo-auth backed)

## Context

Today every filesystem endpoint clamps to `$HOME` and otherwise lets anything through; there is no per-request identity. We want a multi-user "org" model: each user has a home folder, others get explicit grants beyond it.

We already have xo-auth (`routers/auth.py`, `routers/claude_setup_token.py`, `xo-swarm-api`'s Clerk poll-token flow). The plan is to **reuse that exact flow for request authentication** and key all RBAC decisions off the `user_id` that Clerk returns. No new identity scheme, no header invention.

Supersedes the earlier `X-Agent-Id` draft.

---

## What xo-auth already gives us

```
xo-cowork (Tauri)            xo-cowork-api                 xo-swarm-api
       │                           │                            │
       │ POST /xo-auth/start ─────►│ POST /auth/browser/start ─►│
       │                           │◄────── poll_token ─────────│
       │◄── authorize_url ─────────│                            │
       │                           │                            │
       │ user signs in via Clerk in browser ──────────────────►│
       │                           │                            │
       │ POST /xo-auth/consume ───►│ POST /auth/browser/consume►│
       │                           │◄── access_token, user_id ──│
       │◄── { user_id }  ──────────│   stored in auth_state     │
       │                           │                            │
       │  …later: outbound calls   │                            │
       │  use that token           │ Authorization: Bearer ────►│
       │                           │   /get-user-id  ───────────│
       │                           │◄── user_id ────────────────│
```

Today the workspace stores **one** `auth_state` and uses it for outbound calls. We will **invert** the use: the same Bearer token comes back **inbound** on every local request from the Tauri frontend, and the API validates it.

---

## Mental model

```
┌────────────────────────────────────────────────────────────────────────────┐
│                            workspace ($HOME)                                │
│                                                                              │
│   users.json:                                                                │
│     owner: "user_2bX9..."                                                   │
│     allowlist:                                                               │
│       - { user_id: "user_2bX9...", home: "~",         role: "owner"  }      │
│       - { user_id: "user_3kL7...", home: "~/research", role: "member" }     │
│       - { user_id: "user_5pQ2...", home: "~/writer",   role: "member" }     │
│                                                                              │
│   grants:                                                                    │
│     - { user_id: "user_5pQ2...", path: "~/research/sources",                │
│         actions: ["read","list"] }                                          │
│                                                                              │
│   global_read: ["~/shared"]                                                 │
└────────────────────────────────────────────────────────────────────────────┘

  every request carries:  Authorization: Bearer <clerk_access_token>
            │
            ▼
  resolve_caller(token)  →  user_id          (validated via /get-user-id, cached)
            │
            ▼
  is user_id in users.json.allowlist?  →  no  → 403 Forbidden (not provisioned)
            │ yes
            ▼
  authorize(user_id, path, action)  →  raise PermissionError or pass
```

---

## 1. Identity layer — Bearer token already in flight

**Inbound auth dependency** (FastAPI `Depends`):

```python
# services/cowork_agent/auth_dep.py
async def caller_user_id(authorization: str | None = Header(None)) -> str:
    token = parse_bearer(authorization)
    user_id = await resolve_user_id(token)        # cache hit avoids swarm round-trip
    if user_id not in users_store.allowlist():
        raise HTTPException(403, "user not provisioned in this workspace")
    return user_id
```

`resolve_user_id` does:
1. Lookup `(token → user_id)` in an in-memory TTL cache (e.g. 5 min).
2. On miss, `GET {CHAT_API_BASE_URL}/get-user-id` with the same Bearer (already implemented in `routers/auth.py:xo_auth_whoami`). Cache the result with TTL bounded by the token's `expires_at`.
3. Network failure → reuse the last successful result if still within freshness; otherwise 503.

**Tauri frontend change:** the desktop app already holds the access token after `/xo-auth/consume`. It needs to start sending `Authorization: Bearer <token>` on every local API request. This is a one-line change in the existing API client.

**Backwards compat for local dev:** if `RBAC_ENFORCE != "true"` or no `Authorization` header is present, fall through to the configured owner user_id from `users.json:owner_user_id` (env override: `LOCAL_DEV_USER_ID`). Behavior is identical to today.

---

## 2. The user list — `~/.cowork/users.json`

Single source of truth, edited only by owner via API or directly on disk.

```json
{
  "version": 1,
  "owner_user_id": "user_2bX9aB7cdEfGhI",
  "users": [
    { "user_id": "user_2bX9aB7cdEfGhI", "display": "Suraj",   "home": "~/",          "role": "owner"  },
    { "user_id": "user_3kL7mN4pqRsTuV", "display": "Researcher", "home": "~/research", "role": "member" },
    { "user_id": "user_5pQ2vW8xyZaBcD", "display": "Writer",   "home": "~/writer",    "role": "member" }
  ],
  "grants": [
    { "id": "g_abc",
      "user_id": "user_5pQ2vW8xyZaBcD",
      "path": "~/research/sources",
      "actions": ["read", "list"] }
  ],
  "global_read": ["~/shared"]
}
```

- `owner_user_id` is the workspace admin. Bypasses RBAC.
- `users[]` is the **allowlist**. Anyone whose Clerk `user_id` isn't here → 403, even if their token validates.
- Each entry pins a `home` directory; default rwx within it.
- `grants[]` and `global_read[]` work exactly as in the prior draft, keyed on `user_id`.
- `display` is just for the admin UI; never used in policy decisions.

---

## 3. Action vocabulary (unchanged)

| Action | Endpoints |
|---|---|
| `list`   | `/api/files/list-directory` |
| `read`   | `/api/files/content`, `/api/files/content-binary`, `/api/messages/{id}`, `/api/sessions/{id}` |
| `create` | `/api/files/upload` (new), `/api/files/save` (new), `/api/files/mkdir` |
| `write`  | `/api/files/upload` (overwrite), `/api/files/save` (existing), `PATCH /api/sessions/{id}` |
| `delete` | future |

**Owner-only scopes** (not folder-shaped):

| Scope | Endpoints |
|---|---|
| `secrets` | `GET/PUT /api/secrets/env` |
| `agents`  | `POST/PATCH /api/agents` |
| `connectors` | `/api/connectors/*` |
| `rbac` | `/api/rbac/*` (manage the user list itself) |

---

## 4. `authorize()` (unchanged shape)

```
authorize(user_id, target_path, action) -> None | PermissionError

1. target = Path(raw).expanduser().resolve()
2. owner check     → allow
3. inside user.home → allow
4. walk up the dir tree:
     - matching grant whose actions include action → allow
     - global_read covers and action in {read, list}  → allow
     - reach root → deny
5. audit-log decision either way
```

Audit line shape:

```json
{"ts":"...","user_id":"user_5pQ...","display":"Writer",
 "path":"/Users/x/research/sources/ref.md","action":"read",
 "decision":"allow","matched_grant":"g_abc","token_hash":"sha256:abcd…"}
```

`token_hash` is the SHA-256 of the bearer token (truncated) so we can correlate audit lines to a session without storing the token itself.

---

## 5. New / modified endpoints

### New router `routers/cowork_agent/rbac_routes.py`

All under `/api/rbac/`. Owner-only unless noted.

```
GET    /api/rbac/users               list users + homes + roles
POST   /api/rbac/users                add { user_id, display, home, role }
DELETE /api/rbac/users/{user_id}     remove (revokes all their grants too)

GET    /api/rbac/me                  caller-only: { user_id, display, home, grants[] }
GET    /api/rbac/grants               list all grants
POST   /api/rbac/grants               { user_id, path, actions }
DELETE /api/rbac/grants/{grant_id}    revoke

POST   /api/rbac/check               debug: { path, action } → { allowed, reason, matched }
GET    /api/rbac/audit?since=&limit=  tail of audit.jsonl (owner)
```

### Modified routers

Each filesystem router gets the `caller_user_id` dependency added and the home-clamp replaced by `authorize()`:

```python
# routers/cowork_agent/files.py (excerpt)
@router.post("/api/files/content")
async def file_content(request: Request, user_id: str = Depends(caller_user_id)):
    body = await request.json()
    target = Path(body["path"]).expanduser().resolve()
    authorize(user_id, target, "read")
    ...
```

Sessions endpoints also filter `GET /api/sessions` by ownership + grant — see §6.

---

## 6. Sessions ownership

Existing JSONL records gain an `owner_user_id` field (added on creation in `chat.py:chat_prompt`). For sessions created before this change, fall back to `owner_user_id` of the workspace (i.e. treat as legacy).

Visibility rules:
- `GET /api/sessions` returns sessions where caller is owner, **or** caller has `read` on the session's `directory`.
- Owner role (workspace admin) sees all.
- `POST /api/sessions/{id}/share` (new) is sugar over `POST /api/rbac/grants` for the session's directory.

Write rules:
- `PATCH /api/sessions/{id}` requires `write` on the (current and new) `directory` and either ownership or an explicit session-scoped write grant.

---

## 7. Token caching, refresh, and revocation

```
in-memory cache:
  token_hash → { user_id, expires_at, last_validated_at }

on request:
  hash = sha256(token)
  if cache hit and not stale:        return cached.user_id
  else:
    GET /get-user-id (Bearer token)  # one swarm round-trip
    if 200: cache with TTL = min(token.expires_at - now, 300s)
    if 401: drop cache entry, return 401 to caller
```

- Cache key is the SHA-256 of the token (we never store the raw token).
- TTL caps at 5 minutes even if `expires_at` is far in the future, so revocations on swarm propagate quickly.
- If the swarm round-trip fails and we have a fresh-enough cached entry, we reuse it (graceful degradation when offline). After `STALE_GRACE_SECONDS=120`, we hard-fail.

**Revoking a user** = either `DELETE /api/rbac/users/{user_id}` locally (effective immediately) or revoke the Clerk session on swarm (effective within the cache TTL). Both supported.

---

## 8. Endpoint-by-endpoint enforcement

| Endpoint | Auth required? | Action |
|---|---|---|
| `POST /xo-auth/start` | no | bootstrap |
| `POST /xo-auth/consume` | no | bootstrap |
| `GET  /xo-auth/whoami` | yes | passthrough |
| `POST /api/files/upload` | yes | `create`/`write` |
| `POST /api/files/list-directory` | yes | `list` |
| `POST /api/files/content` | yes | `read` |
| `POST /api/files/content-binary` | yes | `read` |
| `POST /api/files/save` | yes | `create`/`write` |
| `POST /api/files/mkdir` | yes | `create` on parent |
| `GET  /api/secrets/env` | yes | scope `secrets` (owner) |
| `GET  /api/secrets/env/keys` | yes | any provisioned user |
| `PUT  /api/secrets/env` | yes | scope `secrets` (owner) |
| `GET  /api/sessions` | yes | filter by ownership + grants |
| `GET  /api/sessions/{id}` | yes | `read` on `session.directory` |
| `GET  /api/messages/{id}` | yes | `read` on `session.directory` |
| `PATCH /api/sessions/{id}` | yes | `write` on session.directory |
| `POST /api/agents`, `PATCH /api/agents/{id}` | yes | scope `agents` (owner) |
| `GET  /api/agents` | yes | any provisioned user |
| `/api/connectors/*` | yes | scope `connectors` (owner initially) |
| `/api/chat/*` | yes | session-owner or grant on session.directory |
| `/api/rbac/*` | yes | mostly owner; `/me` and `/check` for any provisioned user |
| `/health` | no | infra |

---

## 9. Phasing

```
Phase 0 — Frontend sends Bearer token
   ─ Tauri client adds Authorization: Bearer <token> on every request
   ─ Server-side: parse but DON'T enforce yet (logged-only)

Phase 1 — Validation + user list, shadow mode
   ─ Implement caller_user_id with cache + /get-user-id round-trip
   ─ ~/.cowork/users.json with default { owner = current user_id, no grants }
   ─ /api/rbac/* read-only routes
   ─ authorize() in shadow mode: log decisions, never deny
   ─ Audit log shape stable

Phase 2 — Enforce on /api/files/*
   ─ Flip RBAC_ENFORCE=files
   ─ Owner exempt; non-allowlisted users 403
   ─ Frontend exposes a per-request "as user" indicator for debugging

Phase 3 — Sessions, agents, secrets, connectors
   ─ session.owner_user_id on new records
   ─ filter GET /api/sessions
   ─ scope-gate secrets / agents / connectors
   ─ RBAC_ENFORCE=all

Phase 4 — Hardening
   ─ session-scoped grant sugar (/api/sessions/{id}/share)
   ─ time-bounded grants (expires_at)
   ─ UI for grants in xo-cowork
   ─ rotate token cache on Clerk webhook (if/when added on swarm side)
```

---

## 10. Code surface

```
NEW
  services/cowork_agent/auth_dep.py        caller_user_id, parse_bearer, token cache
  services/cowork_agent/users_store.py     load/save users.json, allowlist accessor
  services/cowork_agent/rbac.py            authorize, authorize_scope, audit
  services/cowork_agent/rbac_policy.py     dataclasses: User, Grant, Policy
  routers/cowork_agent/rbac_routes.py      /api/rbac/* endpoints
  tests/rbac/                              unit + integration

MODIFIED
  routers/cowork_agent/files.py            add Depends(caller_user_id), authorize()
  routers/cowork_agent/secrets.py          gate by scope
  routers/cowork_agent/agents.py           gate by scope
  routers/cowork_agent/sessions.py         filter list, gate get/patch, write owner_user_id
  routers/cowork_agent/chat.py             stamp owner_user_id on new sessions
  routers/cowork_agent/gdrive.py           gate by scope (initially owner-only)
  routers/cowork_agent/onedrive.py         same
  routers/auth.py                          expose token validation as a reusable helper
  server.py                                init policy + cache on lifespan
  .env.example                             RBAC_ENFORCE, LOCAL_DEV_USER_ID, RBAC_TOKEN_CACHE_TTL
```

---

## 11. Backwards compatibility

- First boot: if `~/.cowork/users.json` is missing, lifespan creates a default with `owner_user_id` taken from the existing `auth_state.user_id` (whoever ran `/xo-auth/consume` first becomes owner). No grants, no other users.
- If frontend hasn't been updated to send Bearer, set `RBAC_ENFORCE=off` (default) and the API behaves identically to today.
- Once enforce is on, the **only** functional difference for a single-user workspace is that requests must include Authorization. That header is already present in everything that talks to swarm-api, so the Tauri client just has to forward its existing token to localhost.

---

## 12. Verification

Unit (`tests/rbac/`):
- `caller_user_id` cache hit, miss, expiry, swarm 401, swarm 5xx with grace
- `authorize` for: own home, sibling home (deny), grant match, grant action mismatch, parent of grant (deny), `global_read` for read but not write, owner exempt
- `users_store` allowlist add/remove/duplicate-id
- audit-log JSON shape

Integration (FastAPI TestClient):
- Two users provisioned. User A reads its home (200). User B reads A's home (403). Add grant. User B reads (200). Revoke. User B reads (403).
- Bearer-less request → 401.
- Token whose user_id is unknown → 403.
- `/api/rbac/check` matches `authorize` outcomes.

Manual:
- Add a second Clerk user on swarm, sign them into the Tauri app, confirm 403 on a foreign folder, owner adds a grant, retry, confirm 200.

---

## 13. Open decisions

These are smaller than before because using xo-auth removes most of the identity questions:

1. **Token cache TTL.** Hard cap at 5 min, or follow `expires_at` exactly? Recommendation: 5 min cap so revocations propagate quickly even when Clerk tokens are long-lived.
2. **Default home for a new user.** `~/users/{user_id}/`? `~/users/{display}/`? Recommendation: `~/users/{display}/` (or fallback to `~/users/{user_id_short}/`) — readable, but display is mutable; pin path on registration not on lookup.
3. **Session ownership on legacy records.** Treat as owner-only, or as `global_read`-friendly? Recommendation: owner-only — safest default.
4. **Connectors visibility.** Start owner-only. Open per-user later via grants? Recommendation: owner-only forever for `/oauth/start`; readonly listing maybe for members.
5. **Audit retention.** Daily-rotate `audit.jsonl`, keep N days? Or append-forever? Recommendation: daily-rotate, keep 30 days.
6. **Local-dev escape hatch.** Keep `LOCAL_DEV_USER_ID` env var so contributors don't need a real Clerk session to hit endpoints? Recommendation: yes, behind `RBAC_ENFORCE=off`.

---

## 14. One-paragraph TL;DR

> Use the existing xo-auth Bearer token as the per-request identity. Add a FastAPI dependency that validates the token via `xo-swarm-api/get-user-id` (cached for 5 min, keyed by SHA-256 of the token) and returns the Clerk `user_id`. Maintain a simple allowlist at `~/.cowork/users.json` mapping `user_id → home + role + grants`. Route every filesystem endpoint through `authorize(user_id, path, action)` that walks up from the target until it finds the user's home, a matching grant, or `global_read`. Owner is exempt. Audit every decision to a JSONL file. Roll out in shadow mode, then enforce per family. Default first-run policy makes the consuming user the owner so nothing breaks for single-user workspaces.

---

**Want me to break Phase 0 + Phase 1 into a concrete file-by-file ticket list (the Tauri header change + `auth_dep.py` + `users_store.py` + the shadow-mode `authorize` skeleton)?**
