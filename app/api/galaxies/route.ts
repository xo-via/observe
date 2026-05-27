import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { bigBang, toRel } from "@/lib/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The whole universe as a graph: every meaningful folder is a galaxy; its direct
// files are its particles; and a galaxy links to another when its files mention
// that other galaxy by name (derived cross-references).

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "__pycache__", "out", "dist", "build",
  ".turbo", ".cache", ".vercel", "coverage", ".idea", ".vscode",
]);

// Folder names too generic to be a meaningful link target (they'd match
// everywhere). Galaxies still exist for these; they just don't form name-edges.
const STOP_NAMES = new Set([
  "app", "src", "lib", "docs", "public", "components", "test", "tests",
  "scripts", "assets", "styles", "pages", "api", "content", "workspace",
  "instructions", "static", "images", "img", "fonts", "utils", "hooks",
  "types", "config", "data", "node_modules", "dist", "build", "out", "bin",
  "examples", "templates", "packages", "modules", "routes", "views", "store",
]);

const TEXT_RE = /\.(md|mdx|markdown|html?|txt|tsx?|jsx?|json|ya?ml|css|py)$/i;
const MAX_GALAXIES = 220;
const MAX_FILES = 2500;
const MAX_FILE_BYTES = 200_000;
const MAX_DEPTH = 7;
const MAX_EDGES = 800;

type Galaxy = {
  path: string; // relative to root ("" = the root galaxy)
  name: string;
  depth: number;
  parent: string | null; // relative path of parent galaxy
  fileCount: number;
  bytes: number;
};

export async function GET() {
  const root = bigBang();
  const galaxies: Galaxy[] = [];
  const textFiles: { dirAbs: string; abs: string }[] = [];

  async function walk(absDir: string, depth: number) {
    if (galaxies.length >= MAX_GALAXIES || depth > MAX_DEPTH) return;
    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    let fileCount = 0;
    let bytes = 0;
    const subdirs: string[] = [];
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (IGNORE_DIRS.has(d.name) || d.name.startsWith(".")) continue;
        subdirs.push(path.join(absDir, d.name));
      } else if (d.isFile()) {
        fileCount++;
        if (TEXT_RE.test(d.name) && textFiles.length < MAX_FILES) {
          textFiles.push({ dirAbs: absDir, abs: path.join(absDir, d.name) });
        }
        try {
          bytes += (await fs.stat(path.join(absDir, d.name))).size;
        } catch {
          /* ignore unreadable */
        }
      }
    }
    const rel = toRel(absDir);
    galaxies.push({
      path: rel,
      name: rel === "" ? "universe" : path.basename(absDir),
      depth,
      parent: rel === "" ? null : toRel(path.dirname(absDir)),
      fileCount,
      bytes,
    });
    for (const sd of subdirs) await walk(sd, depth + 1);
  }

  await walk(root, 0);

  // Link targets are *project* folders: distinctively named (hyphenated, so we
  // never match plain English words like "file" or "about"), length>=4, unique.
  const byName = new Map<string, string | null>(); // null = ambiguous/dropped
  for (const g of galaxies) {
    const n = g.name.toLowerCase();
    if (n.length < 4 || !n.includes("-") || STOP_NAMES.has(n)) continue;
    byName.set(n, byName.has(n) ? null : g.path);
  }
  const galaxyPaths = new Set(galaxies.map((g) => g.path));
  const projectPaths = new Set(
    galaxies.filter((g) => g.name.includes("-")).map((g) => g.path),
  );
  // Attribute a mention to the nearest project (hyphenated) ancestor of the file
  // — so "xo-os/docs/foo.md mentions xo-swarm" becomes the edge xo-os → xo-swarm.
  const projectAncestor = (rel: string): string | null => {
    let p = rel;
    while (p !== "") {
      if (projectPaths.has(p) && p.split("/").pop()!.includes("-")) return p;
      p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    }
    return null;
  };
  const targets = [...byName.entries()].filter(([, p]) => p !== null) as [string, string][];

  // One regex over each text file finds every distinctive name it mentions.
  const edgeWeights = new Map<string, number>(); // "source\ttarget" -> weight
  if (targets.length) {
    const alternation = targets
      .map(([n]) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const re = new RegExp(`(?<![\\w-])(${alternation})(?![\\w-])`, "gi");
    const nameToPath = new Map(targets);

    for (const f of textFiles) {
      let content = "";
      try {
        const buf = await fs.readFile(f.abs);
        content = buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
      } catch {
        continue;
      }
      const source = projectAncestor(toRel(f.dirAbs));
      if (!source) continue; // only count links that live inside a project
      const hits = new Set<string>();
      for (const m of content.matchAll(re)) hits.add(m[1].toLowerCase());
      for (const h of hits) {
        const target = nameToPath.get(h);
        if (!target || target === source) continue;
        const key = `${source}\t${target}`;
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
      }
    }
  }

  const edges = [...edgeWeights.entries()]
    .map(([k, weight]) => {
      const [source, target] = k.split("\t");
      return { source, target, weight };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_EDGES);

  return NextResponse.json({ root: toRel(root), galaxies, edges });
}
