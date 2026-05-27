import { NextRequest, NextResponse } from "next/server";
import {
  ensureXoJson,
  readXoJsonAtRef,
  rebuildFromGit,
  XO_JSON_FILENAME,
} from "@/lib/xo";
import { bigBang } from "@/lib/root";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/xo            → returns the current xo.json (auto-creates empty)
// GET /api/xo?ref=<sha>  → returns xo.json *as committed* at <sha> (time travel)
// POST /api/xo {rebuild} → recomputes the visualization fields from git history
//                          and writes them back into xo.json, preserving any
//                          unknown top-level keys.
export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get("ref");
  const root = bigBang();
  const xoFile = path.join(root, XO_JSON_FILENAME);

  if (ref) {
    const xo = await readXoJsonAtRef(ref);
    return NextResponse.json({
      mode: "time-travel",
      ref,
      path: xoFile,
      created: false,
      exists: xo !== null,
      xo: xo,
    });
  }

  const { xo, created } = await ensureXoJson();
  return NextResponse.json({
    mode: "live",
    ref: null,
    path: xoFile,
    created,
    exists: true,
    xo,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action: string = body.action ?? "rebuild";
  if (action !== "rebuild") {
    return NextResponse.json(
      { error: `unknown action: ${action}` },
      { status: 400 },
    );
  }
  try {
    const xo = await rebuildFromGit();
    return NextResponse.json({
      ok: true,
      mode: "live",
      path: path.join(bigBang(), XO_JSON_FILENAME),
      xo,
    });
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message ?? String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
