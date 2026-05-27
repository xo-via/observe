import path from "node:path";

// The root of the universe — the big bang. Defined in .env as BIG_BANG. Every
// path the Visualizer handles is relative to this directory, and the browser
// URL holds that relative path. If BIG_BANG is unset, fall back to the parent
// of this app (which runs inside the universe's observe/ submodule).
export function bigBang(): string {
  const env = process.env.BIG_BANG?.trim();
  if (env) return path.resolve(env);
  return path.resolve(process.cwd(), "..");
}

// Turn a relative-from-root path (as it appears in the URL; "" means the root)
// into an absolute path, refusing anything that would escape the root.
export function resolveFromRoot(rel: string): string | null {
  const root = bigBang();
  let clean: string;
  try {
    clean = decodeURIComponent(rel ?? "");
  } catch {
    clean = rel ?? "";
  }
  clean = clean.replace(/^\/+/, "").replace(/\/+$/, "");
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// Turn an absolute path back into a root-relative URL path ("" means the root).
export function toRel(abs: string): string {
  const root = bigBang();
  const rel = path.relative(root, abs);
  if (rel === "" || rel === ".") return "";
  return rel.split(path.sep).join("/");
}
