import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

export type Commit = {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  message: string;
};

function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const MAX_COMMITS = 200;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const rawPath: string = body.path ?? "";
  if (!rawPath || typeof rawPath !== "string") {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  const target = path.resolve(expandHome(rawPath));

  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      return NextResponse.json(
        { error: `${target} is not a directory` },
        { status: 400 },
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: `cannot stat ${target}: ${e?.message ?? e}` },
      { status: 400 },
    );
  }

  let isGit = false;
  try {
    await exec("git", ["-C", target, "rev-parse", "--is-inside-work-tree"]);
    isGit = true;
  } catch {
    isGit = false;
  }

  if (!isGit) {
    return NextResponse.json({ isGit: false, commits: [] });
  }

  try {
    const { stdout } = await exec("git", [
      "-C",
      target,
      "log",
      "-n",
      String(MAX_COMMITS),
      "--pretty=format:%H%x09%h%x09%aI%x09%an%x09%s",
      "--",
      ".",
    ]);
    const commits: Commit[] = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        return {
          sha: parts[0] ?? "",
          shortSha: parts[1] ?? "",
          date: parts[2] ?? "",
          author: parts[3] ?? "",
          message: parts.slice(4).join("\t"),
        };
      });
    return NextResponse.json({ isGit: true, commits });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? String(e) },
      { status: 500 },
    );
  }
}
