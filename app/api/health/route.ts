import { NextResponse } from "next/server";

const COWORK_API =
  process.env.COWORK_API_URL?.trim() || "http://localhost:5002";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const url = `${COWORK_API}/health`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { healthy: false, code: res.status, error: res.statusText },
        { status: 502 },
      );
    }
    const json: any = await res.json().catch(() => null);
    const healthy = json?.status === "healthy";
    return NextResponse.json({ healthy, status: json?.status, raw: json });
  } catch (e: any) {
    return NextResponse.json(
      { healthy: false, error: e?.message ?? "fetch failed" },
      { status: 502 },
    );
  }
}
