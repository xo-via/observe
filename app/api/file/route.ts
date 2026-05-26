import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { marked } from "marked";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

const MAX_BYTES = 1_000_000; // 1 MB cap on previewable file size

type Kind = "html" | "md" | "other";

function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function classifyByName(name: string): Kind {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "md";
  return "other";
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function readFromGit(
  repoDir: string,
  ref: string,
  relPath: string,
): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["-C", repoDir, "show", `${ref}:${relPath}`],
    { maxBuffer: MAX_BYTES * 2, encoding: "utf8" },
  );
  return stdout.length > MAX_BYTES ? stdout.slice(0, MAX_BYTES) : stdout;
}

async function gitRepoTop(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

const MD_STYLE = `
<style>
  :root { color-scheme: dark; }
  html, body { background: #0a0a14; color: #e5e7eb; }
  body { font: 14px/1.65 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 28px 36px; }
  h1, h2, h3, h4, h5, h6 { color: #fff; line-height: 1.25; margin: 1.6em 0 0.6em; }
  h1 { font-size: 1.8rem; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: .3em; }
  h2 { font-size: 1.4rem; }
  h3 { font-size: 1.15rem; }
  p { margin: 0.8em 0; }
  a { color: #7dd3fc; }
  code { background: rgba(255,255,255,0.07); padding: 1px 6px; border-radius: 4px; font-size: .92em; }
  pre { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); padding: 14px 16px; border-radius: 8px; overflow: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 3px solid rgba(255,255,255,0.18); padding: 4px 14px; color: #cbd5e1; margin: 0.9em 0; }
  ul, ol { padding-left: 1.5em; }
  hr { border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 2em 0; }
  img { max-width: 100%; }
  table { border-collapse: collapse; }
  td, th { padding: 6px 10px; border: 1px solid rgba(255,255,255,0.08); }
</style>
`;

function wrapMdHtml(htmlBody: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeAttr(title)}</title>${MD_STYLE}</head><body>${htmlBody}</body></html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const rawRoot: string = body.root ?? "";
  const rawPath: string = body.path ?? "";
  const ref: string | null =
    typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : null;

  if (!rawRoot || !rawPath) {
    return NextResponse.json(
      { error: "root and path are required" },
      { status: 400 },
    );
  }

  const root = path.resolve(expandHome(rawRoot));
  const target = path.resolve(expandHome(rawPath));

  if (!(target === root || isInside(target, root))) {
    return NextResponse.json(
      { error: "path is outside the observed root" },
      { status: 400 },
    );
  }

  const name = path.basename(target);
  const kind = classifyByName(name);

  if (kind === "other") {
    return NextResponse.json(
      { error: `no preview for ${name}` },
      { status: 400 },
    );
  }

  try {
    let raw: string;
    let truncated = false;

    if (ref) {
      const repoTop = await gitRepoTop(root);
      if (!repoTop) {
        return NextResponse.json(
          { error: "ref provided but folder is not in a git repo" },
          { status: 400 },
        );
      }
      const relInRepo = path.relative(repoTop, target).replace(/\\/g, "/");
      raw = await readFromGit(repoTop, ref, relInRepo);
      truncated = raw.length >= MAX_BYTES;
    } else {
      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        return NextResponse.json(
          { error: `${name} is not a regular file` },
          { status: 400 },
        );
      }
      const fh = await fs.open(target, "r");
      try {
        const buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
        await fh.read(buf, 0, buf.length, 0);
        raw = buf.toString("utf8");
        truncated = stat.size > MAX_BYTES;
      } finally {
        await fh.close();
      }
    }

    if (kind === "md") {
      const htmlBody = await marked.parse(raw, { async: true });
      return NextResponse.json({
        name,
        kind,
        content: wrapMdHtml(htmlBody, name),
        truncated,
      });
    }

    // html: pass through. The client renders inside a sandboxed iframe.
    return NextResponse.json({
      name,
      kind,
      content: raw,
      truncated,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? String(e) },
      { status: 500 },
    );
  }
}
