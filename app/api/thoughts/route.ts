import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { bigBang } from "@/lib/root";

// getthoughts: every folder under `rel` whose xo.json has kind === "thought".
// Walks the tree (capped) reusing the same skip rules as getshape.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DEPTH = 6;
const MAX_THOUGHTS = 200;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
  ".venv",
]);

type Thought = {
  rel: string;
  name: string;
  identity: string;
  purpose: string;
  outcome: string;
  state: string;
  createdAt: string | null;
};

async function walk(
  dir: string,
  relBase: string,
  root: string,
  depth: number,
  out: Thought[],
): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_THOUGHTS) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Inspect this folder's xo.json (if any) — at any depth except the root scope
  if (entries.some((e) => e.name === "xo.json" && e.isFile())) {
    try {
      const raw = await fs.readFile(path.join(dir, "xo.json"), "utf-8");
      const xo = JSON.parse(raw);
      if (xo?.kind === "thought") {
        out.push({
          rel: relBase,
          name: xo.name ?? path.basename(dir),
          identity: xo.self?.identity ?? xo.name ?? path.basename(dir),
          purpose: xo.self?.purpose ?? "",
          outcome: xo.self?.outcome ?? "",
          state: xo.track?.state ?? "thought",
          createdAt: xo.ts?.created ?? null,
        });
        if (out.length >= MAX_THOUGHTS) return;
      }
    } catch {
      // ignore unreadable / malformed xo.json
    }
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const childRel = relBase ? `${relBase}/${e.name}` : e.name;
    await walk(path.join(dir, e.name), childRel, root, depth + 1, out);
    if (out.length >= MAX_THOUGHTS) return;
  }
}

function resolveUnderRoot(root: string, rel: string): string | null {
  const clean = rel.replace(/^\/+|\/+$/g, "");
  if (!clean) return root;
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

export async function GET(req: NextRequest) {
  let root: string;
  try {
    root = await bigBang();
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "cowork-api unreachable" },
      { status: 502 },
    );
  }
  const rel = req.nextUrl.searchParams.get("rel") ?? "";
  const start = resolveUnderRoot(root, rel);
  if (!start) {
    return NextResponse.json(
      { error: "rel escapes root" },
      { status: 400 },
    );
  }
  const cleanRel = rel.replace(/^\/+|\/+$/g, "");
  const thoughts: Thought[] = [];
  try {
    await walk(start, cleanRel, root, 0, thoughts);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "scan failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({
    rel: cleanRel,
    root,
    count: thoughts.length,
    truncated: thoughts.length >= MAX_THOUGHTS,
    thoughts,
  });
}
