# Files API — frontend integration guide

For frontends building on top of `xo-cowork-api`. Covers exact request/response shapes for every filesystem endpoint, the home-clamp safety model, the project-scaffolding behavior of `/api/files/mkdir`, and edge cases.

**Base URL:** `http://${HOST:-localhost}:${PORT:-5002}`
**Auth:** none required at this surface — the workspace itself is the trust boundary.
**Content type:** `application/json` for non-upload bodies. `multipart/form-data` for `/api/files/upload` only.

---

## At a glance

| Endpoint | Purpose |
|---|---|
| `POST /api/files/upload` | Multipart file upload (≤100 MB), sha256 dedupe. |
| `POST /api/files/list-directory` | List entries at a path (dirs + files). |
| `POST /api/files/content` | Read text content of a file. |
| `POST /api/files/content-binary` | Stream binary content as a download response. |
| `POST /api/files/save` | Write text content to a file (creates parents). |
| `POST /api/files/mkdir` | Create a directory; with `scaffold:true`, build a canonical xo-project tree from `project_template/`. |

---

## 1. Universal safety model: home clamp

Every endpoint that takes a `path` runs the same check:

```
target = Path(raw_path).resolve()
if not str(target).startswith(str(Path.home())):
    return JSONResponse(status_code=403, content={"detail": "Access denied"})
```

This means:

- All paths must resolve under the OS user's home directory (`$HOME`).
- Symlinks are followed by `Path.resolve()`. A symlink under `$HOME` pointing outside is a known leak (treat the workspace as the trust boundary, see warning below).
- Relative paths are resolved against the cowork-api process's CWD before the home check, so always send absolute paths.
- The check is `startswith($HOME)` byte-wise — equality is allowed (you can read `$HOME` itself), one-char-difference siblings are rejected (`/Users/me-other` won't match `/Users/me`).

**If you send a path outside `$HOME`, you always get `403 {"detail": "Access denied"}`.**

> [!WARNING]
> **Symlink leak.** A symlink that lives under `$HOME` but points outside it slips past the byte-wise `startswith($HOME)` check after `Path.resolve()`. The workspace itself is the trust boundary; do not treat the home clamp as a sandbox against locally-resident attackers.

---

## 2. `POST /api/files/upload`

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant A as cowork-api
  participant FS as Filesystem
  C->>A: POST /api/files/upload (multipart: file, workspace?)
  A->>A: read up to 100 MB + 1 byte
  alt size > 100 MB
    A-->>C: 413 {detail: "File exceeds 100 MB limit"}
  else
    A->>A: content_hash = sha256(bytes)
    A->>FS: mkdir(dest_dir, parents=True, exist_ok=True)
    A->>FS: stat dest = dest_dir / filename
    alt dest does not exist
      A->>FS: write bytes to dest
    else dest exists, same sha256
      Note over A,FS: idempotent re-upload<br/>silent overwrite
      A->>FS: write bytes to dest
    else dest exists, different sha256
      Note over A: auto-rename: stem_&lt;hash[:8]&gt;.suffix
      A->>FS: write bytes to renamed dest
    end
    A-->>C: 200 {file_id, name, path, size, mime_type, source: "uploaded", content_hash}
  end
```

Multipart file upload. Stores the file in either the explicit `workspace` directory or `~/uploads/` as a fallback.

### 2.1 Request

`Content-Type: multipart/form-data`

| Form field | Type | Required | Notes |
|---|---|---|---|
| `file` | `UploadFile` | yes | Max 100 MB after read; larger → 413. |
| `workspace` | `str` | no | Absolute destination directory. If empty → defaults to `~/uploads/`. Created with `mkdir(parents=True, exist_ok=True)` if missing. |

The `workspace` field is **NOT clamped to `$HOME`** in this endpoint (unlike all other file endpoints). It uses `Path(workspace).resolve()` directly. Practically speaking, on a typical desktop this is benign because the cowork-api process can only write where it has OS permission, but be aware that this endpoint has weaker validation than the JSON-body endpoints.

### 2.2 Behavior

```
1. Read up to (100 MB + 1 byte) of the upload.
   if size > 100 MB → 413 Payload Too Large.
2. Compute sha256 of the bytes.
3. dest_dir = workspace or ~/uploads/
4. dest_dir.mkdir(parents=True, exist_ok=True)
5. dest = dest_dir / file.filename   (or "upload" if filename missing)
6. If dest exists:
     existing_hash = sha256(dest.read_bytes())
     if existing_hash == content_hash:
         silently overwrite with the new bytes (idempotent re-upload)
     else:
         dest = dest_dir / f"{stem}_{content_hash[:8]}{suffix}"   (auto-rename)
7. dest.write_bytes(content)
```

### 2.3 Response

#### 200 OK

```jsonc
{
  "file_id":      "9f86d081884c7d65",            // first 16 chars of sha256
  "name":         "report.pdf",                  // dest.name (may include hash suffix)
  "path":         "/Users/me/uploads/report.pdf",
  "size":         48329,                         // bytes
  "mime_type":    "application/pdf",
  "source":       "uploaded",
  "content_hash": "9f86d081884c7d654f5b..."     // full sha256 hex
}
```

`mime_type` resolution order: explicit `Content-Type` from the multipart part → `mimetypes.guess_type(filename)` → `"application/octet-stream"`.

#### 413 Payload Too Large

```json
{ "detail": "File exceeds 100 MB limit" }
```

### 2.4 Frontend example (TS)

```typescript
async function uploadFile(file: File, workspace?: string) {
  const fd = new FormData();
  fd.append("file", file);
  if (workspace) fd.append("workspace", workspace);

  const res = await fetch("/api/files/upload", { method: "POST", body: fd });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{
    file_id: string;
    name: string;
    path: string;
    size: number;
    mime_type: string;
    source: "uploaded";
    content_hash: string;
  }>;
}
```

### 2.5 Idiosyncrasies

- **No content-type validation.** Anything multipart is accepted.
- **Same hash → silent overwrite.** Idempotent re-uploads of the exact same bytes leave a single file.
- **Different hash, same name → auto-rename.** The new file gets `<stem>_<8hash><suffix>` so the original isn't clobbered.
- **`workspace` not clamped.** Unique to this endpoint; everything else clamps to `$HOME`.

---

## 3. `POST /api/files/list-directory`

```mermaid
sequenceDiagram
  participant C as Client
  participant A as cowork-api
  participant FS as Filesystem
  C->>A: POST /api/files/list-directory {path?}
  alt path missing or empty
    A->>A: target = $HOME
  else
    A->>A: target = Path(path).resolve()
    Note over A: home-clamp: must startswith($HOME)
    alt outside $HOME
      A-->>C: 403 {detail: "Access denied"}
    end
  end
  A->>FS: iterdir(target)
  alt not a directory
    A-->>C: 404 {detail: "Not a directory"}
  else
    Note over A: sort dirs first then files,<br/>case-insensitive alphabetical;<br/>swallow PermissionError per child
    A-->>C: 200 {path, parent, dirs[], files[]}
  end
```

List the immediate children of a directory.

### 3.1 Request

```jsonc
{
  "path": "/Users/me/xo-projects/blackhole"   // optional. If omitted/empty → lists $HOME.
}
```

### 3.2 Behavior

```
1. If path missing → target = $HOME.
2. Else target = Path(path).resolve(); home-clamp.
3. If target is not a directory → 404.
4. iterdir(), sorted: directories first, then files, both case-insensitive alphabetical.
5. PermissionError on any single child is silently swallowed (returns whatever was readable).
```

### 3.3 Response

#### 200 OK

```jsonc
{
  "path":   "/Users/me/xo-projects/blackhole",
  "parent": "/Users/me/xo-projects",            // null when path == $HOME
  "dirs":  [
    { "name": ".xo",     "path": "/Users/me/xo-projects/blackhole/.xo" },
    { "name": "memory",  "path": "/Users/me/xo-projects/blackhole/memory" },
    { "name": "src",     "path": "/Users/me/xo-projects/blackhole/src" }
  ],
  "files": [
    { "name": "AGENTS.md",     "path": "/Users/me/xo-projects/blackhole/AGENTS.md" },
    { "name": "OBJECTIVES.md", "path": "/Users/me/xo-projects/blackhole/OBJECTIVES.md" },
    { "name": "PLAN.md",       "path": "/Users/me/xo-projects/blackhole/PLAN.md" },
    { "name": "PROGRESS.md",   "path": "/Users/me/xo-projects/blackhole/PROGRESS.md" },
    { "name": "PROJECT.md",    "path": "/Users/me/xo-projects/blackhole/PROJECT.md" }
  ]
}
```

#### 403 Forbidden

```json
{ "detail": "Access denied" }
```

Path resolves outside `$HOME`.

#### 404 Not Found

```json
{ "detail": "Not a directory" }
```

Path resolves to a file, missing entry, or anything other than a directory. (Not technically a 404 of "not exists" — it's 404 of "not a directory".)

### 3.4 What's missing

No file size, mtime, mime, or symlink target. If you need those, do a follow-up `/api/files/content-binary` or read the file metadata client-side via the absolute path. There's no recursive listing — call repeatedly per subdirectory.

---

## 4. `POST /api/files/content` (text)

```mermaid
sequenceDiagram
  participant C as Client
  participant A as cowork-api
  participant FS as Filesystem
  C->>A: POST /api/files/content {path}
  alt missing path
    A-->>C: 400 {detail: "Missing path"}
  else
    A->>A: target = Path(path).resolve(); home-clamp
    alt outside $HOME
      A-->>C: 403 {detail: "Access denied"}
    else not a file
      A-->>C: 404 {detail: "File not found"}
    else
      A->>FS: target.read_text(errors="replace")
      Note over A: non-UTF8 bytes -> U+FFFD
      A-->>C: 200 {content, path}
    end
  end
```

Read a file as UTF-8 text.

### 4.1 Request

```jsonc
{ "path": "/Users/me/xo-projects/blackhole/PLAN.md" }
```

### 4.2 Behavior

```
target = Path(path).resolve(); home-clamp.
if not target.is_file() → 404.
content = target.read_text(errors="replace")   ← non-UTF8 bytes become U+FFFD
```

`errors="replace"` means binary garbage doesn't crash — you'll get replacement characters. Don't use this endpoint to detect "is this binary"; use `content-binary` for known-binary paths.

### 4.3 Response

#### 200 OK

```jsonc
{
  "content": "# PLAN.md\n\n## Horizon\n\nDays, not weeks…",
  "path":    "/Users/me/xo-projects/blackhole/PLAN.md"
}
```

#### 400 / 403 / 404 / 500

| Code | Body | Cause |
|---|---|---|
| 400 | `{ "detail": "Missing path" }` | `path` field missing or empty |
| 403 | `{ "detail": "Access denied" }` | Path outside `$HOME` |
| 404 | `{ "detail": "File not found" }` | Path doesn't exist or isn't a file |
| 500 | `{ "detail": "<exception message>" }` | I/O error during read |

---

## 5. `POST /api/files/content-binary`

```mermaid
sequenceDiagram
  participant C as Client
  participant A as cowork-api
  participant FS as Filesystem
  C->>A: POST /api/files/content-binary {path}
  A->>A: home-clamp + is_file checks (same as /content)
  alt path invalid
    A-->>C: 400/403/404 JSON
  else
    A->>FS: stream FileResponse (64 KB chunks)
    Note over A: Content-Type from extension fallback octet-stream<br/>Content-Disposition: attachment; filename=...
    A-->>C: 200 raw bytes + Content-Length
  end
```

Stream a file as a downloadable binary response.

### 5.1 Request

```jsonc
{ "path": "/Users/me/Downloads/photo.jpg" }
```

### 5.2 Response

#### 200 OK

The body is the raw file bytes. Headers include:

```
Content-Type: <inferred from extension; falls back to application/octet-stream>
Content-Disposition: attachment; filename="photo.jpg"
Content-Length: <size>
```

This is a FastAPI `FileResponse` — it streams in 64 KB chunks rather than loading the whole file into memory.

#### 400 / 403 / 404

Same payloads as `/api/files/content`.

### 5.3 Frontend example

```typescript
async function downloadBinary(path: string): Promise<Blob> {
  const res = await fetch("/api/files/content-binary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Unknown" }));
    throw new Error(err.detail);
  }
  return res.blob();
}

// e.g. preview an image
const blob = await downloadBinary("/Users/me/Downloads/photo.jpg");
imgEl.src = URL.createObjectURL(blob);
```

---

## 6. `POST /api/files/save` (text write)

```mermaid
sequenceDiagram
  participant C as Client
  participant A as cowork-api
  participant FS as Filesystem
  C->>A: POST /api/files/save {path, content}
  alt missing path / content / wrong content type
    A-->>C: 400 {detail: "Missing path|Missing content|Content must be a string"}
  else
    A->>A: target = Path(path).resolve(); home-clamp
    alt outside $HOME
      A-->>C: 403 {detail: "Access denied"}
    else
      A->>FS: target.parent.mkdir(parents=True, exist_ok=True)
      A->>FS: target.write_bytes(content.encode("utf-8"))
      Note over A,FS: always overwrites; no backup, no atomic rename
      A-->>C: 200 {path, bytes}
    end
  end
```

Write a UTF-8 string to a file. Creates parent directories. **Always overwrites** if the file exists.

### 6.1 Request

```jsonc
{
  "path":    "/Users/me/xo-projects/blackhole/PROGRESS.md",   // required, absolute, under $HOME
  "content": "# PROGRESS.md\n\n2026-05-10 — initial …"        // required, MUST be a string
}
```

### 6.2 Behavior

```
target = Path(path).resolve(); home-clamp.
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(content.encode("utf-8"))
```

No backup, no atomic-rename, no conflict detection, no append mode. If two clients call `/save` on the same path concurrently, the last writer wins.

### 6.3 Response

#### 200 OK

```jsonc
{
  "path":  "/Users/me/xo-projects/blackhole/PROGRESS.md",
  "bytes": 248
}
```

#### 400 / 403 / 500

| Code | Body | Cause |
|---|---|---|
| 400 | `{ "detail": "Missing path" }` | No `path` |
| 400 | `{ "detail": "Missing content" }` | `content` is `null`/`undefined` |
| 400 | `{ "detail": "Content must be a string" }` | `content` is not a `str` (e.g., a number, an object) |
| 403 | `{ "detail": "Access denied" }` | Outside `$HOME` |
| 500 | `{ "detail": "<exception message>" }` | Disk write error |

### 6.4 When to use this vs `/api/files/upload`

| Use `save` | Use `upload` |
|---|---|
| Known target path inside `$HOME` | User-selected file from a `<input type="file">` |
| Editor-style flows (markdown, code, config) | Arbitrary attachments / binary content |
| You already have the content as a string | Multipart browser upload |
| You want parent dirs created | You want sha256 dedup + auto-rename |

`save` does not return a hash, dedup nothing, and will not auto-rename. It's a write-through.

---

## 7. `POST /api/files/mkdir`

```mermaid
flowchart TD
  in[POST /api/files/mkdir<br/>{path, scaffold?, display_name?, description?, files?}] --> v1{path<br/>missing?}
  v1 -- yes --> e400a([400 Missing path])
  v1 -- no --> v2{target exists?}
  v2 -- yes --> e409([409 Already exists])
  v2 -- no --> v3{target under<br/>$HOME?}
  v3 -- no --> e403a([403 Access denied])
  v3 -- yes --> v4{scaffold:true?}
  v4 -- yes --> v5{target.parent ==<br/>xo_projects_root?}
  v5 -- no --> e400b([400 scaffold:true requires<br/>direct child of projects root])
  v5 -- yes --> vf
  v4 -- no --> vf
  vf[validate every entry in files:<br/>under $HOME<br/>and is_file]
  vf --> vf1{any entry<br/>outside $HOME?}
  vf1 -- yes --> e403b([403 Access denied: path])
  vf1 -- no --> vf2{any entry<br/>missing?}
  vf2 -- yes --> e404([404 File not found: path])
  vf2 -- no --> mut{scaffold?}
  mut -- yes --> sc[scaffold_project name=target.name<br/>1. normalize id<br/>2. target = xo_projects_root / pid<br/>3. mkdir target + .xo/<br/>4. copy project_template/ NEVER overwrites<br/>5. ensure .xo/sessions/sessionslist.json<br/>6. update .xo/project.json<br/>   add display_name + description if provided<br/>   pid/name/created_at stay null;<br/>   _template:true stays]
  mut -- no --> mk[target.mkdir parents=True exist_ok=False]
  sc --> cp
  mk --> cp
  cp[for src in files:<br/>if not target/src.name exists:<br/>  shutil.copy2 src dest<br/>always copied.append src.name]
  cp --> ok([200 path, name normalized for scaffold, copied[]])
  e_io([500 I/O error during create/copy])
  mk -.-> e_io
  sc -.-> e_io
  cp -.-> e_io
```

Create a directory. The killer feature is `scaffold: true` — when enabled, the target must be a direct child of `~/xo-projects/` and the canonical project tree is materialized from the bundled `project_template/` directory.

### 7.1 Request

```jsonc
{
  // REQUIRED
  "path":         "/Users/me/xo-projects/blackhole",   // absolute, under $HOME

  // OPTIONAL
  "scaffold":     true,                                // default false
                                                        // when true: must be direct child of
                                                        // xo_projects_root() (XO_PROJECTS_ROOT env
                                                        // var, default ~/xo-projects)
  "display_name": "Blackhole",                         // only meaningful with scaffold:true;
                                                        // seeds .xo/project.json
  "description":  "Internal research project",         // only meaningful with scaffold:true;
                                                        // seeds .xo/project.json

  "files": [                                           // optional list of absolute paths
    "/Users/me/Downloads/spec.md",                     //   to copy into the new directory
    "/Users/me/Downloads/diagram.png"                   //   (preserves mtime/perms via shutil.copy2)
  ]
}
```

### 7.2 Validation

```
1. path exists already → 409 Already exists.
2. path resolves outside $HOME → 403 Access denied.
3. If scaffold:true:
       target.parent.resolve() must exactly equal xo_projects_root()
       Otherwise → 400 Bad Request with detail explaining the constraint.
4. Every entry in `files`:
       - must resolve under $HOME → else 403
       - must exist and be a file → else 404
   Validation runs BEFORE any directory is created. If any fails, nothing
   is mutated on disk.
```

### 7.3 Behavior — `scaffold: false` (default)

```
target.mkdir(parents=True, exist_ok=False)
for src in files:
    if not (target / src.name).exists():
        shutil.copy2(src, target / src.name)
```

### 7.4 Behavior — `scaffold: true`

This is the project-creation flow. It runs `services.cowork_agent.project_layout.scaffold_project(name, display_name=..., description=...)`:

```
1. pid = normalize_agent_id(target.name)
2. project_dir = xo_projects_root() / pid                     ← note: NORMALIZED path,
                                                                 which may differ from `target`
3. project_dir.mkdir(parents=True, exist_ok=True)
4. xo_dir = project_dir / ".xo"; xo_dir.mkdir(...)
5. Recursively copy every file from the bundled project_template/ → project_dir/.
   NEVER overwrites existing files (idempotent — re-running fills in only the
   missing pieces). The template ships with all .xo/* schemas + the markdown
   scaffold files; see §7.5 below.
6. Ensure project_dir/.xo/sessions/sessionslist.json exists (always empty `{}` if new);
   this is system-required and NOT in the template itself.
7. Read or create project_dir/.xo/project.json. The TEMPLATE file copied in step 5
   starts as:
     {
       "$schema":      "./schema/project.schema.json",
       "schema":       1,
       "_template":    true,
       "pid":          null,
       "name":         null,
       "owner_user_id": null,
       "created_at":   null
     }
   `scaffold_project` then *adds* `display_name` and `description` if the
   request supplied them (writing the actual strings) — but does NOT
   fill in `pid` / `name` / `created_at` / `owner_user_id` (they stay null) and
   does NOT clear `_template: true`. That finalization is the watcher
   service's job (not yet built — see architecture.md scorecard).

   Resulting file after the call when display_name="Blackhole":
     {
       "$schema":      "./schema/project.schema.json",
       "schema":       1,
       "_template":    true,
       "pid":          null,
       "name":         null,
       "owner_user_id": null,
       "created_at":   null,
       "display_name": "Blackhole",
       "description":  "Internal research project"
     }

   Agents are explicitly instructed not to write to .xo/ — only the watcher
   service should mutate it.

8. (back in the route) Copy each entry from `files` into project_dir/,
   skipping name collisions with the just-scaffolded files (won't overwrite
   AGENTS.md etc.).
```

**The mutated `target`.** Step 2 means that if the request was for `path: /Users/me/xo-projects/My Project`, the actual created dir is `/Users/me/xo-projects/my-project` (normalized). The `path` in the response reflects this normalized path, not the requested one.

The full scaffolded tree:

```
~/xo-projects/<id>/
├── AGENTS.md                             operating contract — read first by agents
├── CLAUDE.md                             single line: "@AGENTS.md"
├── PROJECT.md                            scope/audience/stack — [TEMPLATE] markers
├── OBJECTIVES.md                         OKRs — [TEMPLATE] markers
├── PLAN.md                               current plan — [TEMPLATE] markers
├── PROGRESS.md                           append-only narrative — [TEMPLATE] markers
├── memory/
│   ├── semantic/
│   │   ├── preferences.md
│   │   ├── project-facts.md
│   │   └── constraints.md
│   ├── episodic/README.md
│   ├── procedural/README.md
│   └── working/.gitkeep
└── .xo/
    ├── project.json                      identity: pid, name, display_name, _template:true
    ├── todos.json                        empty schema
    ├── stats.json                        empty schema
    ├── timeline.jsonl                    empty
    ├── activity.json                     empty schema
    ├── sync.json                         empty schema
    ├── peers.json                        empty schema
    └── sessions/sessionslist.json        {}  (system-required, not in template)
```

### 7.5 Response

#### 200 OK (non-scaffold)

```jsonc
{
  "path":   "/Users/me/some-folder",
  "name":   "some-folder",
  "copied": ["spec.md", "diagram.png"]   // basenames of EVERY entry from request body's `files`
                                          //   (regardless of whether overwrite was skipped)
}
```

#### 200 OK (scaffold)

```jsonc
{
  "path":   "/Users/me/xo-projects/blackhole",
  "name":   "blackhole",                    // normalized (lowercased, dashed)
  "copied": []                              // [] when no `files` were passed; otherwise every
                                             //   basename from request's `files`
}
```

Two subtleties to note:

1. `copied` is the request's `files` list reflected back as basenames — **including names that collided with an existing file in the target and were silently skipped**. If you need to know which copies actually wrote bytes, compare timestamps before/after.
2. For `scaffold:true` the response `path` reflects the **normalized** project directory (per §7.4 step 2) — not necessarily the path you sent. If the request used `/Users/me/xo-projects/My Project`, the response will show `/Users/me/xo-projects/my-project`.

#### 400 / 403 / 404 / 409 / 500

| Code | Body | Cause |
|---|---|---|
| 400 | `{ "detail": "Missing path" }` | No `path` |
| 400 | `{ "detail": "scaffold:true requires path to be a direct child of /Users/me/xo-projects; got /elsewhere/foo" }` | Scaffold path not under projects root |
| 403 | `{ "detail": "Access denied" }` | Path outside `$HOME` |
| 403 | `{ "detail": "Access denied: /etc/secret" }` | One of `files` outside `$HOME` |
| 404 | `{ "detail": "File not found: /Users/me/missing.md" }` | One of `files` doesn't exist |
| 409 | `{ "detail": "Already exists" }` | Target path already exists |
| 500 | `{ "detail": "<exception>" }` | I/O error during create or copy |

### 7.6 Project-creation flow (canonical)

The xo-projects skill instructs agents to use this exact two-call sequence to create a new project:

```typescript
// Step 1: discover the projects root
const cfg = await fetch("/api/config/workspace").then(r => r.json());
//   → { roots: { openclaw: "/Users/me/xo-projects" }, default: "openclaw" }
const projectsRoot = cfg.roots[cfg.default];

// Step 2: create the project with scaffold
const res = await fetch("/api/files/mkdir", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    path:          `${projectsRoot}/blackhole`,
    scaffold:      true,
    display_name:  "Blackhole",
    description:   "Internal research on event-horizon stuff",
  }),
});

if (!res.ok) {
  const err = await res.json();
  if (res.status === 409) /* project exists, navigate to it */;
  else throw new Error(err.detail);
}

const { path } = await res.json();
//   → /Users/me/xo-projects/blackhole
//   project is fully scaffolded; navigate the user there
```

**Always discover the projects root first.** Do not hardcode `~/xo-projects/` — it's overrideable via the `XO_PROJECTS_ROOT` env var on the server side.

### 7.7 Idempotence

`scaffold_project()` is idempotent — re-running it on an existing project folder fills in any missing template files and missing `.xo/sessions/sessionslist.json`, never overwrites existing files. So calling `mkdir` with `scaffold: true` on a path that already exists returns **409**, but `scaffold_project` itself is safe to invoke separately. (The HTTP layer adds the existence check; the underlying scaffold function tolerates pre-existing directories.)

---

## 8. Endpoint capability matrix

| Endpoint | Path required | Body type | Home-clamped | Idempotent | Side effects |
|---|---|---|---|---|---|
| `/api/files/upload` | no (workspace optional) | `multipart/form-data` | partial (`workspace` not clamped) | yes (sha256 dedup) | writes to filesystem |
| `/api/files/list-directory` | optional | JSON | yes | yes | none |
| `/api/files/content` | yes | JSON | yes | yes | none |
| `/api/files/content-binary` | yes | JSON | yes | yes | none |
| `/api/files/save` | yes | JSON | yes | no (overwrites) | writes to filesystem |
| `/api/files/mkdir` | yes | JSON | yes | partial (409 on existing) | creates dir + scaffolds + copies |

---

## 9. Common error envelope

Every JSON error follows this shape:

```jsonc
{ "detail": "<human-readable string OR object>" }
```

Status codes used:

| Code | When |
|---|---|
| 400 | Missing or malformed request body field |
| 403 | Path resolves outside `$HOME` (or one of `files` does) |
| 404 | Target doesn't exist or has wrong type |
| 409 | Target already exists (mkdir only) |
| 413 | Upload exceeds 100 MB |
| 500 | Unhandled I/O error; `detail` carries the exception message |

Always JSON, always `detail` keyed, always parseable.

---

## 10. Quick reference

### Endpoints

```
POST /api/files/upload          multipart  → {file_id,name,path,size,mime_type,source,content_hash}
POST /api/files/list-directory  {path?}    → {path,parent,dirs[],files[]}
POST /api/files/content         {path}     → {content,path}
POST /api/files/content-binary  {path}     → binary stream + Content-Disposition: attachment
POST /api/files/save            {path,content} → {path,bytes}
POST /api/files/mkdir           {path,scaffold?,display_name?,description?,files?}
                                            → {path,name,copied[]}
```

### Project-creation idiom

```javascript
const { roots, default: backend } = await get("/api/config/workspace");
await post("/api/files/mkdir", {
  path: `${roots[backend]}/${slug}`,
  scaffold: true,
  display_name: nameFromUser,
});
```

### Universal validation rules

- Every JSON body must be valid JSON.
- Every `path` must be absolute and resolve under `$HOME` (except `/upload`'s `workspace`).
- Every `content` for `/save` must be a string.
- Every entry in `mkdir.files` must exist and be under `$HOME`.
- Failed validation never partially mutates disk.
