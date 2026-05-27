import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { bigBang } from "@/lib/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

export type Session = {
  id: string; // pid — stable across polls, so its orbit is continuous
  age: number; // seconds the session has been running
  headless: boolean; // a `claude -p` task vs an interactive session
  state: string; // process state word: running | idle | stopped | …
};

// Linux ps STAT first letter → a friendly status word.
function stateWord(stat: string): string {
  switch (stat[0]) {
    case "R": return "running";
    case "S": return "idle";
    case "D": return "waiting";
    case "T": return "stopped";
    case "Z": return "defunct";
    default: return "alive";
  }
}

// A Claude Code session is a process whose argv0 basename is `claude`. We count
// only sessions living inside the universe (cwd at/below the root) — those are
// the minds active in *this* world.
export async function GET() {
  const root = bigBang();
  let out = "";
  try {
    const r = await exec("ps", ["-eo", "pid=,etimes=,stat=,args="], { maxBuffer: 1 << 20 });
    out = r.stdout;
  } catch {
    return NextResponse.json({ sessions: [], root });
  }

  const sessions: Session[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [pid, etimes, stat, args] = [m[1], parseInt(m[2], 10), m[3], m[4]];
    const argv0 = args.trim().split(/\s+/)[0] ?? "";
    if (path.basename(argv0) !== "claude") continue;

    let cwd = "";
    try {
      cwd = await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      continue; // process gone or unreadable
    }
    if (!(cwd === root || cwd.startsWith(root + path.sep))) continue;

    sessions.push({
      id: pid,
      age: Number.isFinite(etimes) ? etimes : 0,
      headless: /\s-p(\s|$)|--print(\s|$)/.test(args),
      state: stateWord(stat),
    });
  }

  // Oldest first, so a given session keeps its slot as others come and go.
  sessions.sort((a, b) => b.age - a.age);
  return NextResponse.json({ sessions, root });
}
