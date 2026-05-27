import { promises as fs } from "node:fs";
import path from "node:path";
import { bigBang } from "@/lib/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// observatory.html is the universe's human-facing "about" page, at the universe
// root (BIG_BANG).
async function findObservatory(): Promise<string | null> {
  const file = path.join(bigBang(), "observatory.html");
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

export async function GET() {
  const file = await findObservatory();
  if (!file) {
    return new Response("observatory.html not found beside the app", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const html = await fs.readFile(file, "utf8");
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
