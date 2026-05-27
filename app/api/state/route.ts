import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { bigBang } from "@/lib/root";

// getstate: the commit hash of the current rel (its enclosing git repo).
// Also returns short hash, branch, and a dirty flag for convenience.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

async function gitInfo(dir: string): Promise<
  | {
      isGit: true;
      top: string;
      commit: string;
      short: string;
      branch: string;
      dirty: boolean;
    }
  | { isGit: false }
> {
  try {
    const top = (
      await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"])
    ).stdout.trim();
    const commit = (
      await exec("git", ["-C", dir, "rev-parse", "HEAD"])
    ).stdout.trim();
    const short = (
      await exec("git", ["-C", dir, "rev-parse", "--short", "HEAD"])
    ).stdout.trim();
    const branch = (
      await exec("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();
    const status = (
      await exec("git", ["-C", dir, "status", "--porcelain"])
    ).stdout.trim();
    return {
      isGit: true,
      top,
      commit,
      short,
      branch,
      dirty: status.length > 0,
    };
  } catch {
    return { isGit: false };
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
  const info = await gitInfo(start);
  return NextResponse.json({
    rel: rel.replace(/^\/+|\/+$/g, ""),
    root,
    abs: start,
    ...info,
  });
}
