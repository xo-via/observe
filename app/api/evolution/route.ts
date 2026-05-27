import { NextRequest, NextResponse } from "next/server";
import { bigBang } from "@/lib/root";
import {
  ensureXoJson,
  readXoJsonAtRef,
  type XoCommit,
  type XoFile,
} from "@/lib/xo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Evolution is now a thin reader over xo.json — the frontend visualizes
// whatever the universe wrote about itself. Two modes:
//   live           → read the current xo.json (auto-created empty if missing)
//   time-travel    → ?ref=<sha> reads xo.json *as it was* at that git commit;
//                    the universe's older self-knowledge, not the present.
export type EvolutionResult = {
  mode: "live" | "time-travel";
  isGit: boolean;
  root: string;
  lanes: string[];
  commits: XoCommit[];
  files: XoFile[];
  xoExists: boolean;
  xoCreated: boolean;
  error?: string;
};

export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get("ref");
  const root = bigBang();

  if (ref) {
    const xo = await readXoJsonAtRef(ref);
    if (!xo) {
      return NextResponse.json<EvolutionResult>({
        mode: "time-travel",
        isGit: true,
        root,
        lanes: [],
        commits: [],
        files: [],
        xoExists: false,
        xoCreated: false,
        error: `xo.json did not exist at ${ref}`,
      });
    }
    return NextResponse.json<EvolutionResult>({
      mode: "time-travel",
      isGit: true,
      root,
      lanes: xo.lanes,
      commits: xo.evolution,
      files: xo.files,
      xoExists: true,
      xoCreated: false,
    });
  }

  const { xo, created } = await ensureXoJson();
  return NextResponse.json<EvolutionResult>({
    mode: "live",
    isGit: xo.evolution.length > 0,
    root,
    lanes: xo.lanes,
    commits: xo.evolution,
    files: xo.files,
    xoExists: true,
    xoCreated: created,
  });
}
