import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { bigBang } from "@/lib/root";

export const dynamic = "force-dynamic";

function isEmpty(xo: unknown): boolean {
  if (xo === null || xo === undefined) return true;
  if (typeof xo !== "object") return false;
  return Object.keys(xo as Record<string, unknown>).length === 0;
}

export async function GET() {
  let root: string;
  try {
    root = await bigBang();
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "cowork-api unreachable" },
      { status: 502 },
    );
  }
  const file = path.join(root, "xo.json");
  try {
    const raw = await fs.readFile(file, "utf-8");
    const trimmed = raw.trim();
    if (!trimmed) {
      return NextResponse.json({ root, file, xo: null, empty: true });
    }
    const xo = JSON.parse(trimmed);
    return NextResponse.json({ root, file, xo, empty: isEmpty(xo) });
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return NextResponse.json({
        root,
        file,
        xo: null,
        empty: true,
        missing: true,
      });
    }
    return NextResponse.json(
      { error: e?.message ?? "read failed", root, file },
      { status: 500 },
    );
  }
}

export async function POST() {
  let root: string;
  try {
    root = await bigBang();
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "cowork-api unreachable" },
      { status: 502 },
    );
  }
  const file = path.join(root, "xo.json");
  const now = new Date().toISOString();
  const id = path.basename(root).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const seed = {
    v: 1,
    _: "XO DNA. One shape, every scale. A unit tracks state, learns from it, and improves.",
    id,
    kind: "universe",
    name: path.basename(root),
    kin: { parent: null, children: [] },
    self: { purpose: "", voice: "", scope: "" },
    aim: [],
    track: { state: {}, log: [] },
    learn: { signals: [], lessons: [] },
    improve: { next: [], experiments: [], questions: [] },
    ts: { created: now, updated: now },
  };
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(file, JSON.stringify(seed, null, 2) + "\n", "utf-8");
    return NextResponse.json({
      root,
      file,
      xo: seed,
      empty: false,
      created: true,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "write failed", root, file },
      { status: 500 },
    );
  }
}
