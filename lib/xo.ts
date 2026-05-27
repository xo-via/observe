import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bigBang } from "./root";

// xo.json is the universe's external memory — the single source of truth the
// frontend visualizes. It lives at the root of the universe (BIG_BANG). The
// frontend never walks the filesystem or git directly for visualization data;
// it only reads (and occasionally rebuilds) this file.
//
// Unknown keys in xo.json are preserved on every write so other tools (for
// example observe.py's sealed dna/footprint payload) can share the same file
// without us trampling their data.

const exec = promisify(execFile);

export const XO_JSON_FILENAME = "xo.json";
export const XO_VERSION = 1;

export type XoCommit = {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  message: string;
  tick: number | null;
  total: number;
  counts: Record<string, number>;
};

export type XoFile = {
  path: string;
  lane: string;
  bornIdx: number;
  diedIdx: number;
};

export type XoJson = {
  version: number;
  name?: string;
  bigBang?: string;
  currentSha?: string;
  currentTick?: number | null;
  lanes: string[];
  evolution: XoCommit[];
  files: XoFile[];
  builtAt?: string;
  // Pass-through for fields owned by other tools (e.g. observe.py's dna).
  [k: string]: unknown;
};

export const EMPTY_XO: XoJson = {
  version: XO_VERSION,
  lanes: [],
  evolution: [],
  files: [],
};

export function xoPath(root?: string): string {
  return path.join(root ?? bigBang(), XO_JSON_FILENAME);
}

function normalize(parsed: unknown): XoJson {
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  return {
    ...obj,
    version: typeof obj.version === "number" ? (obj.version as number) : XO_VERSION,
    lanes: Array.isArray(obj.lanes) ? (obj.lanes as string[]) : [],
    evolution: Array.isArray(obj.evolution) ? (obj.evolution as XoCommit[]) : [],
    files: Array.isArray(obj.files) ? (obj.files as XoFile[]) : [],
  };
}

// Read xo.json from disk. If it doesn't exist, create an empty one and return
// it — the empty file is persisted so a follow-up call sees a stable file and
// doesn't race another creation. Malformed files are surfaced as empty *in
// memory only*, so we never clobber a hand-edited (or third-party) file.
export async function ensureXoJson(): Promise<{ xo: XoJson; created: boolean }> {
  const file = xoPath();
  try {
    const txt = await fs.readFile(file, "utf8");
    return { xo: normalize(JSON.parse(txt)), created: false };
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "ENOENT") {
      const empty: XoJson = { ...EMPTY_XO };
      await fs.writeFile(file, JSON.stringify(empty, null, 2) + "\n");
      return { xo: empty, created: true };
    }
    return { xo: { ...EMPTY_XO }, created: false };
  }
}

export async function readXoJson(): Promise<XoJson | null> {
  try {
    const txt = await fs.readFile(xoPath(), "utf8");
    return normalize(JSON.parse(txt));
  } catch {
    return null;
  }
}

// Read xo.json *as committed* at a specific git ref. Used for the time-travel
// mode: the frontend sees the universe as it knew itself at that moment.
// If the file didn't exist at that ref, returns null so the caller can show
// an empty universe (rather than the live one bleeding through).
export async function readXoJsonAtRef(ref: string): Promise<XoJson | null> {
  try {
    const root = bigBang();
    const { stdout } = await exec(
      "git",
      ["-C", root, "show", `${ref}:${XO_JSON_FILENAME}`],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return normalize(JSON.parse(stdout));
  } catch {
    return null;
  }
}

// Atomically merge new visualization fields into xo.json, preserving any
// foreign top-level keys (e.g. observe.py's "dna"/"footprint"). Tools that
// share this file can keep their own keys without us clobbering them.
export async function writeXoJsonMerge(patch: Partial<XoJson>): Promise<XoJson> {
  const file = xoPath();
  let existing: Record<string, unknown> = {};
  try {
    const txt = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object") existing = parsed;
  } catch {
    /* missing or malformed — start clean */
  }
  const merged = normalize({ ...existing, ...patch, version: XO_VERSION });
  await fs.writeFile(file, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

// Rebuild the visualization fields by walking git history at BIG_BANG. This is
// the one place we touch git for visualization data; everything else reads
// xo.json. After this completes, the frontend has a usable universe even if
// observe.py hasn't been wired to maintain xo.json yet.
const MAX_COMMITS = 1000;

function topOf(p: string): string {
  const i = p.indexOf("/");
  if (i < 0) return "(root)";
  return p.slice(0, i);
}

export async function rebuildFromGit(): Promise<XoJson> {
  const root = bigBang();
  let isGit = false;
  try {
    await exec("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
    isGit = true;
  } catch {
    /* not a git repo: leave empty */
  }
  if (!isGit) {
    return writeXoJsonMerge({
      ...EMPTY_XO,
      builtAt: new Date().toISOString(),
    });
  }

  const { stdout } = await exec(
    "git",
    [
      "-C",
      root,
      "log",
      "--reverse",
      "--root",
      "--no-renames",
      "--name-status",
      "-n",
      String(MAX_COMMITS),
      "--pretty=format:>%H%x09%h%x09%aI%x09%an%x09%s",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );

  const live = new Map<string, number>();
  const laneSeen = new Set<string>();
  const laneTotals = new Map<string, number>();
  const lifelines: XoFile[] = [];
  const evolution: XoCommit[] = [];

  let cur: Omit<XoCommit, "total" | "counts" | "tick"> | null = null;
  let commitIdx = -1;
  const pendingAdds: string[] = [];

  const flush = () => {
    if (!cur) return;
    const counts: Record<string, number> = {};
    for (const p of live.keys()) {
      const t = topOf(p);
      counts[t] = (counts[t] ?? 0) + 1;
    }
    const tickMatch = cur.message.match(/^t=(\d+)/);
    evolution.push({
      ...cur,
      tick: tickMatch ? Number(tickMatch[1]) : null,
      total: live.size,
      counts,
    });
  };

  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    if (raw.startsWith(">")) {
      for (const p of pendingAdds) if (!live.has(p)) live.set(p, commitIdx);
      pendingAdds.length = 0;
      flush();
      commitIdx++;
      const parts = raw.slice(1).split("\t");
      cur = {
        sha: parts[0] ?? "",
        shortSha: parts[1] ?? "",
        date: parts[2] ?? "",
        author: parts[3] ?? "",
        message: parts.slice(4).join("\t"),
      };
      continue;
    }
    const tab = raw.indexOf("\t");
    if (tab < 0) continue;
    const status = raw.slice(0, tab).trim();
    const path = raw.slice(tab + 1).trim();
    if (!path) continue;
    const lane = topOf(path);
    laneSeen.add(lane);
    laneTotals.set(lane, (laneTotals.get(lane) ?? 0) + 1);
    if (status[0] === "D") {
      const born = live.get(path);
      if (born !== undefined) {
        lifelines.push({ path, lane, bornIdx: born, diedIdx: commitIdx - 1 });
        live.delete(path);
      }
    } else if (!live.has(path)) {
      pendingAdds.push(path);
    }
  }
  for (const p of pendingAdds) if (!live.has(p)) live.set(p, commitIdx);
  flush();
  const tipIdx = evolution.length - 1;
  for (const [path, born] of live) {
    lifelines.push({ path, lane: topOf(path), bornIdx: born, diedIdx: tipIdx });
  }

  const lanes = [...laneSeen].sort(
    (a, b) => (laneTotals.get(b) ?? 0) - (laneTotals.get(a) ?? 0),
  );
  const laneRank = new Map(lanes.map((l, i) => [l, i] as const));
  lifelines.sort((a, b) => {
    const la = laneRank.get(a.lane) ?? 1e9;
    const lb = laneRank.get(b.lane) ?? 1e9;
    if (la !== lb) return la - lb;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.bornIdx - b.bornIdx;
  });

  const tip = evolution[tipIdx];
  const big = evolution[0];
  return writeXoJsonMerge({
    name: path.basename(bigBang()),
    bigBang: big?.date,
    currentSha: tip?.sha,
    currentTick: tip?.tick ?? null,
    lanes,
    evolution,
    files: lifelines,
    builtAt: new Date().toISOString(),
  });
}
