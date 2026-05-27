import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { resolveFromRoot, toRel } from "@/lib/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

type Entry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  itemCount?: number;
  error?: string;
};

type ScanResult = {
  root: string;
  ref: string | null;
  totalSize: number;
  entries: Entry[];
  hiddenFiltered: boolean;
};

const MAX_ENTRIES = 5000;

async function dirSize(dir: string, budget: { count: number }): Promise<number> {
  let total = 0;
  let dirents: any[] = [];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of dirents) {
    if (budget.count++ > MAX_ENTRIES) return total;
    const full = path.join(dir, d.name);
    try {
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        total += await dirSize(full, budget);
      } else if (d.isFile()) {
        const st = await fs.stat(full);
        total += st.size;
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return total;
}

async function shallowItemCount(dir: string): Promise<number> {
  try {
    const dirents = await fs.readdir(dir);
    return dirents.length;
  } catch {
    return 0;
  }
}

async function isInsideGitRepo(dir: string): Promise<boolean> {
  try {
    await exec("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function gitRepoTop(dir: string): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

async function scanFromGitRef(
  target: string,
  ref: string,
  showHidden: boolean,
): Promise<ScanResult> {
  const repoRoot = await gitRepoTop(target);
  const rel = path.relative(repoRoot, target);
  const subprefix = rel === "" ? "" : rel.replace(/\\/g, "/") + "/";

  const { stdout: topOut } = await exec("git", [
    "-C",
    repoRoot,
    "ls-tree",
    ref,
    subprefix || "./",
  ]);
  const topTypes = new Map<string, "blob" | "tree" | "other">();
  for (const line of topOut.split("\n")) {
    if (!line) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx < 0) continue;
    const meta = line.substring(0, tabIdx).trim().split(/\s+/);
    const fullPath = line.substring(tabIdx + 1);
    const type = meta[1];
    const name = subprefix ? fullPath.slice(subprefix.length) : fullPath;
    if (!name || name.includes("/")) continue;
    topTypes.set(
      name,
      type === "blob" ? "blob" : type === "tree" ? "tree" : "other",
    );
  }

  const { stdout: recOut } = await exec("git", [
    "-C",
    repoRoot,
    "ls-tree",
    "-r",
    "--long",
    ref,
    subprefix || "./",
  ]);
  const sizesByTop = new Map<string, number>();
  const countsByTop = new Map<string, number>();
  for (const line of recOut.split("\n")) {
    if (!line) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx < 0) continue;
    const meta = line.substring(0, tabIdx).trim().split(/\s+/);
    const fullPath = line.substring(tabIdx + 1);
    const sizeStr = meta[3];
    const size = sizeStr === "-" ? 0 : parseInt(sizeStr, 10) || 0;
    const rel = subprefix ? fullPath.slice(subprefix.length) : fullPath;
    const top = rel.split("/")[0];
    if (!top) continue;
    sizesByTop.set(top, (sizesByTop.get(top) ?? 0) + size);
    countsByTop.set(top, (countsByTop.get(top) ?? 0) + 1);
  }

  const entries: Entry[] = [];
  let hiddenFiltered = false;
  for (const [name, type] of topTypes) {
    if (name.startsWith(".") && !showHidden) {
      hiddenFiltered = true;
      continue;
    }
    const entry: Entry = {
      name,
      path: toRel(path.join(target, name)),
      type:
        type === "tree"
          ? "directory"
          : type === "blob"
            ? "file"
            : "other",
      size: sizesByTop.get(name) ?? 0,
    };
    if (type === "tree") entry.itemCount = countsByTop.get(name) ?? 0;
    entries.push(entry);
  }
  entries.sort((a, b) => b.size - a.size);
  return {
    root: toRel(target),
    ref,
    totalSize: entries.reduce((s, e) => s + e.size, 0),
    entries,
    hiddenFiltered,
  };
}

async function scanFromFs(
  target: string,
  showHidden: boolean,
): Promise<ScanResult> {
  const dirents = await fs.readdir(target, { withFileTypes: true });
  const entries: Entry[] = [];
  let hiddenFiltered = false;
  for (const d of dirents) {
    const isHidden = d.name.startsWith(".");
    if (isHidden && !showHidden) {
      hiddenFiltered = true;
      continue;
    }
    const full = path.join(target, d.name);
    const entry: Entry = {
      name: d.name,
      path: toRel(full),
      type: "other",
      size: 0,
    };
    try {
      if (d.isSymbolicLink()) {
        entry.type = "symlink";
      } else if (d.isDirectory()) {
        entry.type = "directory";
        const budget = { count: 0 };
        entry.size = await dirSize(full, budget);
        entry.itemCount = await shallowItemCount(full);
      } else if (d.isFile()) {
        entry.type = "file";
        const st = await fs.stat(full);
        entry.size = st.size;
      }
    } catch (e: any) {
      entry.error = e?.message ?? String(e);
    }
    entries.push(entry);
  }
  entries.sort((a, b) => b.size - a.size);
  return {
    root: toRel(target),
    ref: null,
    totalSize: entries.reduce((s, e) => s + e.size, 0),
    entries,
    hiddenFiltered,
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const relPath: string = typeof body.path === "string" ? body.path : "";
  const showHidden: boolean = !!body.showHidden;
  const ref: string | null =
    typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : null;

  // path is relative to the root (BIG_BANG); "" is the root itself.
  const target = resolveFromRoot(relPath);
  if (!target) {
    return NextResponse.json(
      { error: "path is outside the universe root" },
      { status: 400 },
    );
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch (e: any) {
    return NextResponse.json(
      { error: `cannot stat ${target}: ${e?.message ?? e}` },
      { status: 400 },
    );
  }
  if (!stat.isDirectory()) {
    return NextResponse.json(
      { error: `${target} is not a directory` },
      { status: 400 },
    );
  }

  try {
    if (ref) {
      const inRepo = await isInsideGitRepo(target);
      if (!inRepo) {
        return NextResponse.json(
          { error: `${target} is not inside a git repo` },
          { status: 400 },
        );
      }
      const out = await scanFromGitRef(target, ref, showHidden);
      return NextResponse.json(out);
    }
    const out = await scanFromFs(target, showHidden);
    return NextResponse.json(out);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? String(e) },
      { status: 500 },
    );
  }
}
