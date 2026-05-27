// Every backend response gets classified into one of four shapes the UI
// understands. Names are thought-domain (not file-domain):
//   spark    = an atomic idea: a markdown file, or a thought-folder with
//              xo.json + README.md
//   cluster  = a folder of things (no thought identity of its own)
//   page     = an html surface
//   fragment = anything else (json, binary, source code, etc.)

export type Shape = "spark" | "cluster" | "page" | "fragment";

export type Classified<T = unknown> = {
  shape: Shape;
  raw: T;
  name?: string;
};

const SPARK_EXT = new Set(["md", "mdx", "markdown"]);
const PAGE_EXT = new Set(["html", "htm"]);

function extOf(name: string | undefined | null): string {
  if (!name) return "";
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function shapeForName(name: string | undefined | null): Shape {
  const ext = extOf(name);
  if (SPARK_EXT.has(ext)) return "spark";
  if (PAGE_EXT.has(ext)) return "page";
  return "fragment";
}

// Classify any backend response. We look for signals in this order:
//   1) /api/scan: has entries[]  -> cluster
//   2) /api/entry: has kind ("directory" | "file" | ...)
//   3) /api/file: has content + kind
//   4) fallback: fragment
export function classify<T = any>(
  response: T,
  hint?: { name?: string },
): Classified<T> {
  const r: any = response;

  if (r && Array.isArray(r.entries)) {
    return { shape: "cluster", raw: response };
  }

  if (r && typeof r.kind === "string") {
    if (r.kind === "directory") {
      return { shape: "cluster", raw: response };
    }
    if (r.kind === "file") {
      const name: string = hint?.name ?? r.abs?.split("/").pop() ?? "";
      return { shape: shapeForName(name), raw: response, name };
    }
    if (r.kind === "md") return { shape: "spark", raw: response };
    if (r.kind === "html") return { shape: "page", raw: response };
    // "other" | "missing" | "raw" fall through to fragment
  }

  if (typeof r?.content === "string" && hint?.name) {
    return { shape: shapeForName(hint.name), raw: response, name: hint.name };
  }

  return { shape: "fragment", raw: response };
}
