import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { bigBang } from "@/lib/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

// The lifecycle verbs observe.py understands. Allowlisted: the route never runs
// anything but these, and arguments are passed as an argv array (no shell), so a
// folder path, url, or ref cannot inject a command.
const ACTIONS = new Set(["start", "fetch", "update", "clone", "travel"]);

// Words that mean "the present" — returning home rather than visiting the past.
const PRESENT = new Set(["present", "now", "head", "tip", "today"]);

// The engine lives at the root of the universe (BIG_BANG). The canonical name
// is observe.py — start, fetch, update, clone, and travel all bottom out in it.
async function findObserve(): Promise<string | null> {
  const file = path.join(bigBang(), "observe.py");
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

async function homeBranch(root: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", root, "rev-parse", "--abbrev-ref", "origin/HEAD"]);
    const s = stdout.trim();
    if (s.includes("/")) return s.split("/").slice(1).join("/");
  } catch {
    /* fall through */
  }
  return "main";
}

function fail(action: string, e: any) {
  const output = `${e?.stdout ?? ""}${e?.stderr ?? ""}`.trim();
  const reason = e?.killed
    ? "timed out"
    : typeof e?.code === "number"
      ? `exit ${e.code}`
      : (e?.message ?? "failed");
  return NextResponse.json({ ok: false, action, output, error: reason }, { status: 500 });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action: string = body.action ?? "";

  if (!ACTIONS.has(action)) {
    return NextResponse.json(
      { error: `unknown action: ${action || "(none)"}` },
      { status: 400 },
    );
  }

  const script = await findObserve();
  if (!script) {
    return NextResponse.json(
      { error: "observe.py not found beside the app" },
      { status: 404 },
    );
  }
  const root = path.dirname(script);
  const opts = { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 } as const;

  // Returning to the present is a recovery action: while time-traveling, the
  // checked-out observe.py may be an old version that lacks `travel`. So we run
  // git directly for the trip home, never depending on the on-disk script.
  if (action === "travel" && PRESENT.has(String(body.ref ?? "").trim().toLowerCase())) {
    try {
      const branch = await homeBranch(root);
      const { stdout: co, stderr: coErr } = await exec("git", ["-C", root, "checkout", branch]);
      let pull = "";
      try {
        const r = await exec("git", ["-C", root, "pull", "--ff-only", "origin", branch]);
        pull = `${r.stdout}${r.stderr}`;
      } catch {
        /* offline / nothing to pull — fine */
      }
      const output = `returned to the present — ${branch}.\n${co}${coErr}${pull}`.trim();
      return NextResponse.json({ ok: true, action, output });
    } catch (e: any) {
      return fail(action, e);
    }
  }

  const args = [script, action];
  if (action === "clone") {
    const url: string = (body.url ?? "").trim();
    if (!url) {
      return NextResponse.json({ error: "clone needs a url" }, { status: 400 });
    }
    args.push(url);
    const dest: string = (body.dest ?? "").trim();
    if (dest) args.push(dest);
  }
  if (action === "travel") {
    const ref: string = (body.ref ?? "").trim();
    if (!ref) {
      return NextResponse.json({ error: "travel needs a moment (a commit or t=N)" }, { status: 400 });
    }
    args.push(ref);
  }

  try {
    const { stdout, stderr } = await exec("python3", args, opts);
    const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
    return NextResponse.json({ ok: true, action, output });
  } catch (e: any) {
    return fail(action, e);
  }
}
