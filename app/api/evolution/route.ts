import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bigBang } from "@/lib/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

// The universe through time. We walk git history forward from the big bang and,
// at every tick, record how many files live inside each top-level galaxy. The
// result is a time-series suitable for a streamgraph: each lane is a galaxy,
// each x is a commit, the band's thickness is the number of files there.

const MAX_COMMITS = 600;

export type EvolutionCommit = {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  message: string;
  total: number; // total tracked files at this commit
  counts: Record<string, number>; // top-level folder/file name → count
};

export type EvolutionResult = {
  isGit: boolean;
  root: string;
  lanes: string[]; // ordered top-level names (most files lifetime first)
  commits: EvolutionCommit[];
  error?: string;
};

// A path's top-level "galaxy" is its first segment. Files at the root become a
// synthetic "(root)" lane, so nothing in the universe is invisible.
function topOf(p: string): string {
  const i = p.indexOf("/");
  if (i < 0) return "(root)";
  return p.slice(0, i);
}

export async function GET() {
  const root = bigBang();

  let isGit = false;
  try {
    await exec("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
    isGit = true;
  } catch {
    isGit = false;
  }

  if (!isGit) {
    return NextResponse.json<EvolutionResult>({
      isGit: false,
      root,
      lanes: [],
      commits: [],
    });
  }

  // One log walk: oldest first, with the rename-resolved file list for each
  // commit's diff against its parent. The first commit (no parent) is fed
  // through --root so its add list is emitted too.
  let stdout = "";
  try {
    const r = await exec(
      "git",
      [
        "-C",
        root,
        "log",
        "--reverse",
        "--root",
        "--no-renames",
        "--name-status",
        "-n",
        String(MAX_COMMITS),
        "--pretty=format:>%H%x09%h%x09%aI%x09%an%x09%s",
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch (e: any) {
    return NextResponse.json<EvolutionResult>(
      {
        isGit: true,
        root,
        lanes: [],
        commits: [],
        error: e?.message ?? String(e),
      },
      { status: 500 },
    );
  }

  // Live set of tracked files, partitioned by top-level lane. Walking forward,
  // each commit's name-status mutates this set; we snapshot counts after each.
  const live = new Set<string>();
  const laneSeen = new Set<string>();
  const laneTotals = new Map<string, number>(); // lifetime touches per lane
  const commits: EvolutionCommit[] = [];

  let cur: {
    sha: string;
    shortSha: string;
    date: string;
    author: string;
    message: string;
  } | null = null;

  const flush = () => {
    if (!cur) return;
    const counts: Record<string, number> = {};
    for (const f of live) {
      const t = topOf(f);
      counts[t] = (counts[t] ?? 0) + 1;
    }
    commits.push({ ...cur, total: live.size, counts });
  };

  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    if (raw.startsWith(">")) {
      flush();
      const parts = raw.slice(1).split("\t");
      cur = {
        sha: parts[0] ?? "",
        shortSha: parts[1] ?? "",
        date: parts[2] ?? "",
        author: parts[3] ?? "",
        message: parts.slice(4).join("\t"),
      };
      continue;
    }
    // status\tpath  (or status\told\tnew for renames, but we --no-renames)
    const tab = raw.indexOf("\t");
    if (tab < 0) continue;
    const status = raw.slice(0, tab).trim();
    const path = raw.slice(tab + 1).trim();
    if (!path) continue;
    const lane = topOf(path);
    laneSeen.add(lane);
    laneTotals.set(lane, (laneTotals.get(lane) ?? 0) + 1);
    const code = status[0];
    if (code === "D") {
      live.delete(path);
    } else {
      // A (add), M (modify), C (copy), T (typechange), or anything else: ensure
      // the file is in the set. Modify is a no-op but is harmless to re-add.
      live.add(path);
    }
  }
  flush();

  // Lane ordering: most-touched first, so the streamgraph stacks the loudest
  // galaxies at the center and quieter ones spill outward.
  const lanes = [...laneSeen].sort(
    (a, b) => (laneTotals.get(b) ?? 0) - (laneTotals.get(a) ?? 0),
  );

  return NextResponse.json<EvolutionResult>({
    isGit: true,
    root,
    lanes,
    commits,
  });
}
