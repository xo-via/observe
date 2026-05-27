import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import { bigBang } from "@/lib/root";

// A spark is an atomic idea — either:
//   (A) a thought-folder: a directory with xo.json (kind="thought") + README.md
//   (B) a loose markdown file (.md / .mdx / .markdown)
//
// Returns 404 if the path is neither. The frontend uses this to decide
// whether to render the SparkView or fall back to a cluster (folder) view.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MD_EXT = new Set(["md", "mdx", "markdown"]);

function resolveUnder(root: string, rel: string): string | null {
  const clean = (rel ?? "").replace(/^\/+|\/+$/g, "");
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
  const abs = resolveUnder(root, rel);
  if (!abs) {
    return NextResponse.json({ error: "rel escapes root" }, { status: 400 });
  }

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: e?.message ?? "stat failed" },
      { status: 500 },
    );
  }

  // Case A: thought-folder
  if (stat.isDirectory()) {
    let xo: any = null;
    try {
      const xoRaw = await fs.readFile(path.join(abs, "xo.json"), "utf-8");
      xo = JSON.parse(xoRaw);
    } catch {
      return NextResponse.json(
        { error: "not a thought (no xo.json)" },
        { status: 404 },
      );
    }
    if (xo?.kind !== "thought") {
      return NextResponse.json(
        { error: "not a thought" },
        { status: 404 },
      );
    }
    let bodyRaw = "";
    try {
      bodyRaw = await fs.readFile(path.join(abs, "README.md"), "utf-8");
    } catch {
      // no README — empty body is fine
    }
    const html = await marked.parse(bodyRaw, { async: true });
    return NextResponse.json({
      shape: "spark",
      origin: "thought-folder",
      rel,
      abs,
      root,
      thought: {
        name: xo?.name ?? path.basename(abs),
        identity: xo?.self?.identity ?? xo?.name ?? path.basename(abs),
        purpose: xo?.self?.purpose ?? "",
        outcome: xo?.self?.outcome ?? "",
        state: xo?.track?.state ?? "thought",
        evolution: xo?.track?.evolution ?? null,
        log: xo?.track?.log ?? [],
        kin: xo?.kin ?? null,
        createdAt: xo?.ts?.created ?? null,
        updatedAt: xo?.ts?.updated ?? null,
      },
      body: { raw: bodyRaw, html },
    });
  }

  // Case B: loose markdown file
  if (stat.isFile()) {
    const name = path.basename(abs);
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    if (!MD_EXT.has(ext)) {
      return NextResponse.json({ error: "not markdown" }, { status: 404 });
    }
    const bodyRaw = await fs.readFile(abs, "utf-8");
    const html = await marked.parse(bodyRaw, { async: true });
    return NextResponse.json({
      shape: "spark",
      origin: "md-file",
      rel,
      abs,
      root,
      thought: {
        name,
        identity: name.replace(/\.[^.]+$/, ""),
        purpose: "",
        outcome: "",
        state: null,
        evolution: null,
        log: [],
        kin: null,
        createdAt: null,
        updatedAt: null,
      },
      body: { raw: bodyRaw, html },
    });
  }

  return NextResponse.json({ error: "not a spark" }, { status: 404 });
}
