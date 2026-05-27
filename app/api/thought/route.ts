import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { bigBang } from "@/lib/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A thought has 4 properties:
//   purpose   - narrative of why          (README.md + xo.json self.purpose)
//   identity  - folder name + xo.json name
//   outcome   - desired end state          (xo.json self.outcome, blank initially)
//   state     - evolution stage            (xo.json track.state)
// State evolves: thought -> idea -> vision -> mission.
const STATE_EVOLUTION = ["thought", "idea", "vision", "mission"] as const;

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return s || "thought";
}

function safeFolderName(name: string): string {
  return name.replace(/[\/\\]/g, "-").replace(/^\.+/, "").trim();
}

function resolveUnderRoot(root: string, rel: string): string | null {
  const clean = rel.replace(/^\/+|\/+$/g, "");
  if (!clean) return root;
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

export async function POST(req: NextRequest) {
  let root: string;
  try {
    root = await bigBang();
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "cowork-api unreachable" },
      { status: 502 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const rawName: string =
    typeof body.name === "string" ? body.name : "";
  const purpose: string =
    typeof body.purpose === "string" ? body.purpose.trim() : "";
  const parentRel: string =
    typeof body.parentRel === "string" ? body.parentRel : "";

  const name = safeFolderName(rawName);
  if (!name) {
    return NextResponse.json(
      { error: "name is required" },
      { status: 400 },
    );
  }
  if (!purpose) {
    return NextResponse.json(
      { error: "purpose is required" },
      { status: 400 },
    );
  }

  const parentAbs = resolveUnderRoot(root, parentRel);
  if (!parentAbs) {
    return NextResponse.json(
      { error: "parentRel escapes root" },
      { status: 400 },
    );
  }

  const folderAbs = path.join(parentAbs, name);
  try {
    await fs.access(folderAbs);
    return NextResponse.json(
      { error: `'${name}' already exists at this location` },
      { status: 409 },
    );
  } catch {
    // ENOENT — good, we can create
  }

  const now = new Date().toISOString();
  const id = slugify(name);
  const xoJson = {
    v: 1,
    _: "A thought. Captures purpose, identity, outcome, state.",
    id,
    kind: "thought",
    name,
    kin: { parent: parentRel || null, children: [] },
    self: {
      purpose,
      identity: name,
      outcome: "",
    },
    track: {
      state: "thought",
      evolution: STATE_EVOLUTION,
      log: [{ at: now, event: "created", state: "thought" }],
    },
    aim: [],
    learn: { signals: [], lessons: [] },
    improve: { next: [], experiments: [], questions: [] },
    ts: { created: now, updated: now },
  };

  const readme = `# ${name}\n\n${purpose}\n`;

  try {
    await fs.mkdir(folderAbs, { recursive: false });
    await fs.writeFile(
      path.join(folderAbs, "README.md"),
      readme,
      "utf-8",
    );
    await fs.writeFile(
      path.join(folderAbs, "xo.json"),
      JSON.stringify(xoJson, null, 2) + "\n",
      "utf-8",
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "create failed" },
      { status: 500 },
    );
  }

  const rel = parentRel ? `${parentRel.replace(/^\/+|\/+$/g, "")}/${name}` : name;
  return NextResponse.json({
    ok: true,
    rel,
    abs: folderAbs,
    name,
    purpose,
    state: "thought",
  });
}
