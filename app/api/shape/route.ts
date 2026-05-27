import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { bigBang } from "@/lib/root";

// getshape: the recursive tree of files/folders under the given rel.
// Caps depth and total nodes so large repos don't lock the request.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DEPTH = 4;
const MAX_NODES = 500;
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

type Node = {
  name: string;
  type: "file" | "directory";
  rel: string;
  children?: Node[];
};

async function buildTree(
  dir: string,
  relBase: string,
  depth: number,
  budget: { count: number },
): Promise<Node[]> {
  if (depth >= MAX_DEPTH || budget.count >= MAX_NODES) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: Node[] = [];
  for (const e of entries) {
    if (budget.count >= MAX_NODES) break;
    if (e.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    budget.count++;
    const childRel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const children = await buildTree(
        path.join(dir, e.name),
        childRel,
        depth + 1,
        budget,
      );
      nodes.push({ name: e.name, type: "directory", rel: childRel, children });
    } else if (e.isFile()) {
      nodes.push({ name: e.name, type: "file", rel: childRel });
    }
  }
  return nodes;
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
  const budget = { count: 0 };
  const children = await buildTree(start, rel.replace(/^\/+|\/+$/g, ""), 0, budget);
  return NextResponse.json({
    rel: rel.replace(/^\/+|\/+$/g, ""),
    root,
    abs: start,
    children,
    nodes: budget.count,
    truncated: budget.count >= MAX_NODES,
  });
}
