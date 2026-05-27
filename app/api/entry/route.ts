import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { bigBang } from "@/lib/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveFromRoot(
  root: string,
  rel: string,
): { abs: string; root: string } | null {
  let clean = rel ?? "";
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // already decoded or malformed; use as-is
  }
  clean = clean.replace(/^\/+/, "").replace(/\/+$/, "");
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return { abs, root };
}

export async function GET(req: NextRequest) {
  const rel = req.nextUrl.searchParams.get("rel") ?? "";
  let root: string;
  try {
    root = await bigBang();
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "cowork-api unreachable" },
      { status: 502 },
    );
  }
  const r = resolveFromRoot(root, rel);
  if (!r) {
    return NextResponse.json(
      { error: "path escapes universe root" },
      { status: 400 },
    );
  }
  try {
    const stat = await fs.stat(r.abs);
    let kind: "directory" | "file" | "other";
    if (stat.isDirectory()) kind = "directory";
    else if (stat.isFile()) kind = "file";
    else kind = "other";
    return NextResponse.json({
      rel,
      abs: r.abs,
      root: r.root,
      kind,
      size: stat.size,
    });
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return NextResponse.json(
        { rel, abs: r.abs, root: r.root, kind: "missing" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: e?.message ?? "stat failed" },
      { status: 500 },
    );
  }
}
