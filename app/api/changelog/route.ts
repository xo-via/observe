import { promises as fs } from "node:fs";
import path from "node:path";
import { bigBang } from "@/lib/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CHANGELOG.md is the universe's tick-by-tick record of what changed, kept by
// observe.py at the universe root (BIG_BANG).
async function findChangelog(): Promise<string | null> {
  const file = path.join(bigBang(), "CHANGELOG.md");
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A tiny, dependency-free markdown pass: headings, inline `code`, and **bold**.
// Everything else is left as plain text inside a <pre>-like flow.
function renderMarkdown(md: string): string {
  return escapeHtml(md)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .split("\n")
    .map((line) => {
      const h2 = line.match(/^##\s+(.*)$/);
      if (h2) return `<h2>${h2[1]}</h2>`;
      const h1 = line.match(/^#\s+(.*)$/);
      if (h1) return `<h1>${h1[1]}</h1>`;
      const li = line.match(/^[-*]\s+(.*)$/);
      if (li) return `<div class="li">• ${li[1]}</div>`;
      if (line.trim() === "") return "<div class='sp'></div>";
      return `<div class="p">${line}</div>`;
    })
    .join("\n");
}

export async function GET() {
  const file = await findChangelog();
  if (!file) {
    return new Response("CHANGELOG.md not found beside the app", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const md = await fs.readFile(file, "utf8");
  const body = renderMarkdown(md);
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Changelog — the universe, tick by tick</title>
<style>
  :root { --bg:#06070d; --ink:#e8eaf6; --dim:#8a90b8; --line:#20243f; --accent:#9db4ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:14px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .wrap { max-width:760px; margin:0 auto; padding:40px 28px 80px; }
  h1 { font-size:20px; letter-spacing:.5px; margin:0 0 4px; }
  h2 { font-size:13px; letter-spacing:.4px; color:var(--accent); margin:26px 0 8px;
    padding-top:14px; border-top:1px solid var(--line); }
  .li { color:#cfd4f0; padding-left:6px; }
  .p { color:var(--dim); }
  .sp { height:8px; }
  code { background:#0e1020; border:1px solid var(--line); border-radius:4px;
    padding:1px 5px; color:#aab2e8; }
  strong { color:#fff; }
</style></head><body><div class="wrap">${body}</div></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
