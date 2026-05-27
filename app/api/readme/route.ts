import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { bigBang, toRel } from "@/lib/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The README is the universe's self-description. We look first at the root
// (BIG_BANG/README.md) and fall back to a shallow recursive search so a
// universe that lives one folder down (e.g. a chapter folder) is still found.
// The frontend's Visualize tab renders whatever we return.

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "__pycache__", "out", "dist", "build",
  ".turbo", ".cache", ".vercel", "coverage", ".idea", ".vscode",
]);

const MAX_DEPTH = 4;
const MAX_BYTES = 512 * 1024; // generous; READMEs are rarely huge

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function findReadme(absDir: string, depth: number): Promise<string | null> {
  // Prefer a case-insensitive match in the current directory before recursing.
  let dirents;
  try {
    dirents = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = dirents
    .filter((d) => d.isFile() && /^readme(\..+)?$/i.test(d.name))
    .map((d) => path.join(absDir, d.name));
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const am = /\.(md|markdown|mdx)$/i.test(a) ? 0 : 1;
      const bm = /\.(md|markdown|mdx)$/i.test(b) ? 0 : 1;
      return am - bm;
    });
    return candidates[0];
  }
  if (depth >= MAX_DEPTH) return null;
  const subdirs = dirents
    .filter(
      (d) =>
        d.isDirectory() &&
        !d.name.startsWith(".") &&
        !IGNORE_DIRS.has(d.name),
    )
    .map((d) => path.join(absDir, d.name))
    .sort();
  for (const sd of subdirs) {
    const hit = await findReadme(sd, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export async function GET() {
  const root = bigBang();
  const rootPick = path.join(root, "README.md");
  let abs: string | null = null;
  if (await fileExists(rootPick)) {
    abs = rootPick;
  } else {
    abs = await findReadme(root, 0);
  }
  if (!abs) {
    return NextResponse.json(
      {
        exists: false,
        root,
        error:
          "no README found at the universe root or within the first few levels",
      },
      { status: 404 },
    );
  }
  try {
    const buf = await fs.readFile(abs);
    const slice = buf.subarray(0, MAX_BYTES);
    const truncated = buf.byteLength > MAX_BYTES;
    return NextResponse.json({
      exists: true,
      root,
      path: abs,
      relPath: toRel(abs),
      bytes: buf.byteLength,
      truncated,
      content: slice.toString("utf8"),
    });
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message ?? String(e);
    return NextResponse.json(
      { exists: false, root, error: msg },
      { status: 500 },
    );
  }
}
