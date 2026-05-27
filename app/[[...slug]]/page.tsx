"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Universe,
  type Entry,
  type HoverInfo,
  type ClickInfo,
  type FolderOpenInfo,
} from "@/components/Universe";
import { Timeline, type Commit } from "@/components/Timeline";
import { Preview, type PreviewTarget } from "@/components/Preview";
import { classify, type Shape } from "@/lib/shape";

type ScanResult = {
  root: string;
  ref: string | null;
  totalSize: number;
  entries: Entry[];
  hiddenFiltered: boolean;
};

type SnapshotsResult = {
  isGit: boolean;
  commits: Commit[];
  error?: string;
};

type XoResult = {
  root: string;
  file: string;
  xo: any | null;
  empty: boolean;
  missing?: boolean;
};

type EntryClassify = {
  rel: string;
  abs: string;
  root: string;
  kind: "directory" | "file" | "other" | "missing";
  size?: number;
};

const CRUMBS = [
  "purpose",
  "path",
  "state",
  "constraints",
  "experiments",
] as const;
type Crumb = (typeof CRUMBS)[number];

const TABS = ["human", "ai", "boomer", "raw"] as const;
type Tab = (typeof TABS)[number];

function encodeRel(rel: string): string {
  if (!rel) return "";
  return rel.split("/").map(encodeURIComponent).join("/");
}
function parentRel(rel: string): string {
  if (!rel) return "";
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}
function relFromAbs(root: string, abs: string): string {
  if (abs === root) return "";
  const prefix = root.endsWith("/") ? root : root + "/";
  if (abs.startsWith(prefix)) return abs.slice(prefix.length);
  return abs;
}
function previewKindFor(name: string): "html" | "md" | null {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "md";
  return null;
}

export default function Page() {
  const params = useParams();
  const router = useRouter();

  const slugArr = useMemo(() => {
    const s = (params as { slug?: string | string[] }).slug;
    if (!s) return [];
    return (Array.isArray(s) ? s : [s]).map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    });
  }, [params]);
  const relPath = slugArr.join("/");

  const [showHidden] = useState<boolean>(false);
  const [activeCrumb, setActiveCrumb] = useState<Crumb>("purpose");
  const [activeTab, setActiveTab] = useState<Tab>("human");

  const [data, setData] = useState<ScanResult | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotsResult | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewTarget>(null);

  const [scanLoading, setScanLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo>(null);

  const [xoLoaded, setXoLoaded] = useState<boolean>(false);
  const [xoLoading, setXoLoading] = useState<boolean>(false);
  const [xoResult, setXoResult] = useState<XoResult | null>(null);
  const [xoError, setXoError] = useState<string | null>(null);
  const [scaffolding, setScaffolding] = useState<boolean>(false);

  const [entryInfo, setEntryInfo] = useState<EntryClassify | null>(null);
  const [activeAbs, setActiveAbs] = useState<string | null>(null);
  const [currentShape, setCurrentShape] = useState<Shape>("fragment");
  const [sparkData, setSparkData] = useState<any | null>(null);

  const [newThoughtOpen, setNewThoughtOpen] = useState<boolean>(false);

  const [health, setHealth] = useState<"checking" | "healthy" | "down">(
    "checking",
  );
  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const json = await res.json();
      setHealth(res.ok && json?.healthy ? "healthy" : "down");
    } catch {
      setHealth("down");
    }
  }, []);
  useEffect(() => {
    checkHealth();
    const id = setInterval(checkHealth, 5000);
    return () => clearInterval(id);
  }, [checkHealth]);

  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<{ w: number; h: number }>({
    w: 800,
    h: 600,
  });

  useEffect(() => {
    if (!stageRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const ent of entries) {
        setStage({
          w: Math.max(320, Math.floor(ent.contentRect.width)),
          h: Math.max(320, Math.floor(ent.contentRect.height)),
        });
      }
    });
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, []);

  const scan = useCallback(
    async (abs: string, ref: string | null) => {
      setScanLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: abs, showHidden, ref }),
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json.error ?? "scan failed");
          setData(null);
        } else {
          setData(json);
        }
      } catch (e: any) {
        setError(e?.message ?? "fetch failed");
        setData(null);
      } finally {
        setScanLoading(false);
      }
    },
    [showHidden],
  );

  const loadSnapshots = useCallback(async (abs: string) => {
    try {
      const res = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: abs }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSnapshots({ isGit: false, commits: [], error: json.error });
      } else {
        setSnapshots(json);
      }
    } catch {
      setSnapshots({ isGit: false, commits: [] });
    }
  }, []);

  const loadXo = useCallback(async () => {
    setXoLoading(true);
    setXoError(null);
    try {
      const res = await fetch("/api/xo", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setXoError(json.error ?? "failed to load xo.json");
        setXoResult(null);
      } else {
        setXoResult(json as XoResult);
      }
    } catch (e: any) {
      setXoError(e?.message ?? "fetch failed");
      setXoResult(null);
    } finally {
      setXoLoading(false);
      setXoLoaded(true);
    }
  }, []);

  const scaffoldXo = useCallback(async () => {
    setScaffolding(true);
    setXoError(null);
    try {
      const res = await fetch("/api/xo", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setXoError(json.error ?? "failed to scaffold xo.json");
      } else {
        setXoResult(json as XoResult);
      }
    } catch (e: any) {
      setXoError(e?.message ?? "scaffold failed");
    } finally {
      setScaffolding(false);
    }
  }, []);

  useEffect(() => {
    loadXo();
  }, [loadXo]);

  const root = xoResult?.root ?? null;

  useEffect(() => {
    if (!root) return;
    if (xoResult?.empty) return;
    let cancelled = false;
    (async () => {
      try {
        if (relPath === "") {
          if (cancelled) return;
          setEntryInfo({ rel: "", abs: root, root, kind: "directory" });
          setActiveAbs(root);
          setPreview(null);
          setCurrentShape("cluster");
          await Promise.all([scan(root, null), loadSnapshots(root)]);
          return;
        }
        const res = await fetch(
          `/api/entry?rel=${encodeURIComponent(relPath)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as EntryClassify & { error?: string };
        if (cancelled) return;
        const name = relPath.split("/").pop() ?? "";
        const classified = classify(json, { name });
        setCurrentShape(classified.shape);
        if (json && (json as any).kind) setEntryInfo(json as EntryClassify);
        if (!res.ok || json.kind === "missing" || json.kind === "other") {
          setActiveAbs(null);
          setData(null);
          setSnapshots(null);
          setPreview(null);
          setError(json?.error ?? `path not found: ${relPath}`);
          return;
        }
        if (json.kind === "directory") {
          setActiveAbs(json.abs);
          setPreview(null);
          await Promise.all([scan(json.abs, null), loadSnapshots(json.abs)]);
          return;
        }
        // file
        const parent = parentRel(relPath);
        const parentAbs = parent ? root + "/" + parent : root;
        setActiveAbs(parentAbs);
        await Promise.all([scan(parentAbs, null), loadSnapshots(parentAbs)]);
        const fileName = name || relPath;
        const kind = previewKindFor(fileName);
        if (kind) setPreview({ name: fileName, path: json.abs, kind });
        else setPreview(null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, relPath, xoResult?.empty]);

  // Spark detection: any path that is a thought-folder or a .md file gets
  // classified as a spark. We override currentShape so the (shape, mode)
  // matrix routes to the SparkView.
  useEffect(() => {
    if (!root) return;
    if (xoResult?.empty) return;
    let cancelled = false;
    setSparkData(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/spark?rel=${encodeURIComponent(relPath)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setSparkData(json);
        setCurrentShape("spark");
      } catch {
        // not a spark — keep whatever shape the entry effect set
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, relPath, xoResult?.empty]);

  useEffect(() => {
    if (!activeAbs) return;
    scan(activeAbs, selectedSha);
  }, [selectedSha, activeAbs, scan]);

  useEffect(() => {
    if (!activeAbs) return;
    scan(activeAbs, selectedSha);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  const entries = data?.entries ?? [];

  const onSelectFile = useCallback(
    (info: ClickInfo) => {
      if (!root) return;
      const rel = relFromAbs(root, info.path);
      router.push("/" + encodeRel(rel));
    },
    [root, router],
  );

  const onFolderOpen = useCallback(
    (info: FolderOpenInfo) => {
      if (!root) return;
      const rel = relFromAbs(root, info.path);
      router.push("/" + encodeRel(rel));
    },
    [root, router],
  );

  const goUp = useCallback(() => {
    const parent = parentRel(relPath);
    router.push(parent ? "/" + encodeRel(parent) : "/");
  }, [relPath, router]);

  const onPreviewClose = useCallback(() => {
    const parent = parentRel(relPath);
    router.push(parent ? "/" + encodeRel(parent) : "/");
  }, [relPath, router]);

  const pathSegments = useMemo(() => {
    if (!relPath) return [] as { label: string; rel: string }[];
    const segs = relPath.split("/");
    const out: { label: string; rel: string }[] = [];
    for (let i = 0; i < segs.length; i++) {
      out.push({ label: segs[i], rel: segs.slice(0, i + 1).join("/") });
    }
    return out;
  }, [relPath]);

  return (
    <main className="fixed inset-0 overflow-hidden">
      <div ref={stageRef} className="absolute inset-0">
        {activeTab === "raw" && stage.w > 0 && stage.h > 0 && (
          <Universe
            entries={entries}
            width={stage.w}
            height={stage.h}
            onHover={setHover}
            onSelect={onSelectFile}
            onFolderOpen={onFolderOpen}
          />
        )}
        {activeTab === "boomer" && (
          <BoomerView
            entries={entries}
            relPath={relPath}
            onNavigate={(rel) =>
              router.push(rel ? "/" + encodeRel(rel) : "/")
            }
          />
        )}
        {activeTab === "human" &&
          (sparkData ? (
            <SparkView spark={sparkData} relPath={relPath} />
          ) : (
            <HumanThoughtsView
              relPath={relPath}
              onOpen={(rel) => router.push("/" + encodeRel(rel))}
            />
          ))}
        {activeTab === "ai" && <AIView />}
      </div>

      {/* XO logo */}
      <button
        type="button"
        onClick={() => router.push("/")}
        className="absolute top-4 left-4 z-20 flex items-center gap-2 select-none cursor-pointer hover:opacity-100 opacity-90"
        title="Go to root"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/xo-logo.svg" alt="XO" width={28} height={28} />
        <span className="text-sm font-semibold tracking-wider text-white/80">
          XO
        </span>
      </button>

      {/* Up chip */}
      {relPath !== "" && (
        <button
          type="button"
          onClick={goUp}
          className="absolute top-4 right-4 z-20 px-3 py-1.5 text-xs font-mono text-white/70 rounded-full bg-black/40 border border-white/15 hover:bg-white/10 backdrop-blur-md"
          title="Go up one level"
        >
          ← up
        </button>
      )}

      {/* Section sidebar */}
      <aside className="absolute top-16 left-4 z-20 w-44 flex flex-col gap-1 p-2 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md select-none">
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 px-3 py-1">
          sections
        </div>
        {CRUMBS.map((label) => (
          <button
            key={label}
            type="button"
            onClick={() => setActiveCrumb(label)}
            className={`text-left px-3 py-2 text-[11px] font-mono uppercase tracking-widest rounded-md transition ${
              activeCrumb === label
                ? "bg-white/15 text-white/95"
                : "text-white/45 hover:text-white/85 hover:bg-white/5"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="border-t border-white/10 my-2" />
        <button
          type="button"
          onClick={() => setNewThoughtOpen(true)}
          className="text-left px-3 py-2 text-[11px] font-mono uppercase tracking-widest rounded-md text-[#83d63a]/90 hover:text-[#83d63a] hover:bg-[#83d63a]/10 transition"
        >
          + new thought
        </button>
      </aside>

      {/* Top cluster: tabs + path bar */}
      <div className="absolute top-12 left-[200px] right-4 z-10 flex flex-col items-center gap-3 max-w-[calc(100vw-220px)] mx-auto">
        {/* View tabs */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-white/40 select-none w-24 text-right">
            observations:
          </span>
          <div className="flex items-center gap-1 p-1 rounded-full bg-black/40 border border-white/10 backdrop-blur-md">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setActiveTab(t)}
                className={`px-4 py-1 text-[11px] font-mono uppercase tracking-wider rounded-full transition ${
                  activeTab === t
                    ? "bg-white/15 text-white/90"
                    : "text-white/40 hover:text-white/70"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <HealthDot status={health} onClick={checkHealth} />
        </div>


        {/* Path breadcrumb (file-tree) + shape chip */}
        <nav className="w-full flex items-center gap-1 flex-wrap text-xs font-mono text-white/50 px-2">
          <ShapeChip shape={currentShape} />
          <button
            type="button"
            onClick={() => router.push("/")}
            className={`px-1.5 py-0.5 rounded transition ${
              relPath === ""
                ? "text-white/85"
                : "text-white/45 hover:text-white/80"
            }`}
          >
            root
          </button>
          {pathSegments.map((seg, i) => (
            <span key={seg.rel} className="flex items-center gap-1">
              <span className="text-white/20">/</span>
              <button
                type="button"
                onClick={() => router.push("/" + encodeRel(seg.rel))}
                className={`px-1.5 py-0.5 rounded transition truncate max-w-[180px] ${
                  i === pathSegments.length - 1
                    ? "text-white/85"
                    : "text-white/45 hover:text-white/80"
                }`}
                title={seg.label}
              >
                {seg.label}
              </button>
            </span>
          ))}
        </nav>

        {xoLoaded && xoResult && !xoResult.empty && (
          <div className="w-full mt-1 text-center text-[11px] font-mono text-white/35 truncate">
            <span className="text-white/60">{xoResult.xo?.name ?? "xo"}</span>
            <span className="mx-2">·</span>
            <span className="text-white/50">your universe</span>
            <span className="mx-2">·</span>
            <span className="text-white/25">{xoResult.root}</span>
          </div>
        )}
        {xoError && (
          <div className="w-full mt-1 px-3 py-1.5 rounded-md bg-red-950/60 border border-red-900/60 text-red-200 text-xs font-mono text-center">
            {xoError}
          </div>
        )}
        {data && !error && entryInfo?.kind === "directory" && (
          <div className="w-full mt-1 text-center text-[11px] font-mono text-white/30 truncate">
            {data.entries.length} entries
            <span className="mx-2">·</span>
            {formatBytes(data.totalSize)}
            {data.hiddenFiltered && (
              <>
                <span className="mx-2">·</span>hidden filtered
              </>
            )}
          </div>
        )}
        {error && (
          <div className="w-full mt-1 px-3 py-1.5 rounded-md bg-red-950/60 border border-red-900/60 text-red-200 text-xs font-mono text-center">
            {error}
          </div>
        )}
      </div>

      {activeAbs && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 w-[min(900px,94vw)] px-4 py-3 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md">
          <Timeline
            commits={snapshots?.commits ?? []}
            isGit={!!snapshots?.isGit}
            selected={selectedSha}
            onSelect={setSelectedSha}
          />
        </div>
      )}

      {hover && (
        <div
          className="pointer-events-none fixed z-20 px-3 py-2 rounded-md bg-black/85 border border-white/10 text-xs font-mono backdrop-blur"
          style={{
            left: hover.x + 14,
            top: hover.y + 14,
            maxWidth: 280,
          }}
        >
          <div className="text-white/90 truncate">
            {hover.kind === "folder" ? `${hover.name}/` : hover.name}
          </div>
          <div className="text-white/50 flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-white/35">
              {hover.kind}
            </span>
            <span className="text-white/20">·</span>
            <span>{formatBytes(hover.size)}</span>
            {hover.itemCount !== undefined && (
              <>
                <span className="text-white/20">·</span>
                <span>{hover.itemCount} items</span>
              </>
            )}
          </div>
          {hover.clickable && (
            <div className="text-[10px] mt-1 text-white/40">
              {hover.kind === "folder" ? "click to enter" : "click to preview"}
            </div>
          )}
        </div>
      )}


      {/* new thought modal */}
      {newThoughtOpen && (
        <NewThoughtModal
          parentRel={relPath}
          onClose={() => setNewThoughtOpen(false)}
          onCreated={(rel) => {
            setNewThoughtOpen(false);
            router.push("/" + encodeRel(rel));
          }}
        />
      )}

      {/* welcome / get-started overlay */}
      {xoLoaded && xoResult?.empty && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-md">
          <div className="w-[min(480px,92vw)] p-8 rounded-2xl bg-black/70 border border-white/10 backdrop-blur-md text-center flex flex-col items-center gap-4 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/xo-logo.svg" alt="XO" width={56} height={56} />
            <h1 className="text-lg font-semibold text-white/90 tracking-wide">
              welcome to observe
            </h1>
            <p className="text-xs font-mono text-white/50 leading-relaxed">
              {xoResult.missing ? "no xo.json yet" : "xo.json is empty"} at
              <br />
              <span className="text-white/70 break-all">{xoResult.file}</span>
            </p>
            <p className="text-[11px] text-white/40 max-w-[340px]">
              An xo.json turns a folder into a unit, one shape every scale.
              Create one to start observing this universe.
            </p>
            <button
              type="button"
              onClick={scaffoldXo}
              disabled={scaffolding}
              className="mt-2 px-5 py-2 text-sm rounded-full bg-[#83d63a]/90 hover:bg-[#83d63a] text-black font-semibold tracking-wide transition disabled:opacity-50"
            >
              {scaffolding ? "creating..." : "get started"}
            </button>
            {xoError && (
              <div className="w-full mt-1 px-3 py-1.5 rounded-md bg-red-950/60 border border-red-900/60 text-red-200 text-xs font-mono">
                {xoError}
              </div>
            )}
          </div>
        </div>
      )}

      <Preview
        target={preview}
        root={activeAbs ?? root}
        gitRef={selectedSha}
        onClose={onPreviewClose}
      />
    </main>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

function BoomerView({
  entries,
  relPath,
  onNavigate,
}: {
  entries: Entry[];
  relPath: string;
  onNavigate: (rel: string) => void;
}) {
  const sorted = useMemo(() => {
    return [...entries].sort((a, b) => {
      const ad = a.type === "directory" ? 0 : 1;
      const bd = b.type === "directory" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  return (
    <div className="absolute inset-0 pt-[280px] pb-[110px] pl-[210px] pr-6 overflow-auto">
      <div className="w-full max-w-[900px] rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md font-mono text-sm">
        <div className="px-4 py-2 border-b border-white/10 text-[11px] uppercase tracking-widest text-white/40 flex items-center justify-between">
          <span>ls /{relPath}</span>
          <span className="text-white/30">{entries.length} entries</span>
        </div>
        {sorted.length === 0 ? (
          <div className="px-4 py-6 text-white/30 text-xs">empty</div>
        ) : (
          <ul>
            {sorted.map((e) => {
              const next = relPath
                ? `${relPath}/${e.name}`
                : e.name;
              return (
                <li
                  key={e.name}
                  className="grid grid-cols-[20px,1fr,80px,80px] gap-3 items-center px-4 py-1.5 hover:bg-white/5 border-b border-white/[0.03] last:border-0 cursor-pointer text-white/80"
                  onClick={() => onNavigate(next)}
                >
                  <span className="text-white/45 text-center">
                    {e.type === "directory" ? "▸" : "·"}
                  </span>
                  <span
                    className={`truncate ${
                      e.type === "directory"
                        ? "text-white/90"
                        : "text-white/75"
                    }`}
                  >
                    {e.name}
                    {e.type === "directory" ? "/" : ""}
                  </span>
                  <span className="text-right text-white/40 text-xs">
                    {e.type === "directory"
                      ? `${e.itemCount ?? 0} items`
                      : ""}
                  </span>
                  <span className="text-right text-white/40 text-xs">
                    {formatBytes(e.size)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function RawView({
  relPath,
  absPath,
  root,
  isFile,
}: {
  relPath: string;
  absPath: string | null;
  root: string | null;
  isFile: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!isFile || !absPath || !root) {
      setContent(null);
      setErr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch("/api/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, path: absPath, raw: true }),
    })
      .then(async (r) => {
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setErr(j.error ?? "read failed");
          setContent(null);
        } else {
          setContent(j.content ?? "");
          setTruncated(!!j.truncated);
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(e?.message ?? "fetch failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [absPath, root, isFile]);

  if (!isFile) {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-white/30 text-xs font-mono tracking-widest text-center max-w-xs">
          raw view
          <br />
          <span className="text-white/20">
            navigate to a file (e.g. /README.md) to load its contents
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 pt-[280px] pb-[110px] pl-[210px] pr-6 overflow-auto">
      <div className="w-full max-w-[900px] rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md font-mono text-xs">
        <div className="px-4 py-2 border-b border-white/10 text-[11px] uppercase tracking-widest text-white/40 flex items-center justify-between">
          <span className="truncate">/{relPath}</span>
          {truncated && (
            <span className="text-amber-300/70">truncated</span>
          )}
        </div>
        <div className="p-4">
          {loading && <div className="text-white/30">loading...</div>}
          {err && !loading && <div className="text-red-300">{err}</div>}
          {!loading && !err && content !== null && (
            <pre className="whitespace-pre text-white/80 overflow-auto leading-relaxed">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function AIView() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="text-center">
        <div className="text-white/30 text-xs font-mono uppercase tracking-widest">
          ai view
        </div>
        <div className="mt-2 text-white/20 text-xs font-mono">
          coming soon
        </div>
      </div>
    </div>
  );
}

function HealthDot({
  status,
  onClick,
}: {
  status: "checking" | "healthy" | "down";
  onClick: () => void;
}) {
  const cfg =
    status === "healthy"
      ? {
          dot: "bg-emerald-400",
          glow: "shadow-[0_0_10px_rgba(52,211,153,0.85)]",
          label: "healthy",
        }
      : status === "down"
        ? {
            dot: "bg-red-400",
            glow: "shadow-[0_0_10px_rgba(248,113,113,0.85)]",
            label: "down",
          }
        : {
            dot: "bg-amber-300",
            glow: "shadow-[0_0_10px_rgba(252,211,77,0.7)] animate-pulse",
            label: "checking",
          };
  return (
    <button
      type="button"
      onClick={onClick}
      title={`backend: ${cfg.label} (click to recheck)`}
      className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/40 border border-white/10 backdrop-blur-md hover:bg-white/5 transition"
    >
      <span className={`block w-2.5 h-2.5 rounded-full ${cfg.dot} ${cfg.glow}`} />
      <span className="text-[10px] font-mono uppercase tracking-widest text-white/50">
        {cfg.label}
      </span>
    </button>
  );
}

function ShapeChip({ shape }: { shape: Shape }) {
  const cfg =
    shape === "cluster"
      ? { dot: "bg-sky-300", label: "cluster" }
      : shape === "spark"
        ? { dot: "bg-emerald-300", label: "spark" }
        : shape === "page"
          ? { dot: "bg-orange-300", label: "page" }
          : { dot: "bg-white/40", label: "fragment" };
  return (
    <span
      title={`shape: ${cfg.label}`}
      className="mr-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/40 border border-white/10 text-[10px] uppercase tracking-widest text-white/55"
    >
      <span className={`block w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// Reader view for a single spark (thought-folder or md file).
// Layout: rendered markdown body on the left, meta sidebar on the right.
function SparkView({
  spark,
  relPath,
}: {
  spark: any;
  relPath: string;
}) {
  const t = spark?.thought ?? {};
  const html: string = spark?.body?.html ?? "";
  const log: any[] = Array.isArray(t.log) ? t.log : [];
  const parentRelStr = t?.kin?.parent ?? null;
  const children: any[] = Array.isArray(t?.kin?.children) ? t.kin.children : [];
  return (
    <div className="absolute inset-0 pt-[180px] pb-[110px] pl-[210px] pr-6 overflow-auto">
      <div className="mx-auto w-full max-w-[1100px] grid grid-cols-1 lg:grid-cols-[1fr,260px] gap-6">
        {/* Body column */}
        <article className="rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md p-8">
          <header className="mb-6 pb-4 border-b border-white/10">
            <div className="flex items-center gap-2 mb-2 text-[10px] font-mono uppercase tracking-widest text-white/40">
              <span className="text-emerald-300">●</span> spark
              <span className="text-white/20">/</span>
              <span className="truncate">{relPath || "(root)"}</span>
            </div>
            <h1 className="text-2xl font-semibold text-white/95 tracking-tight">
              {t.identity || t.name || "untitled"}
            </h1>
            {t.purpose && (
              <p className="mt-2 text-sm text-white/65 leading-relaxed">
                {t.purpose}
              </p>
            )}
          </header>
          {html ? (
            <div
              className="spark-prose text-white/85"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <div className="text-white/35 text-sm font-mono py-8 text-center">
              no body · README.md is empty
            </div>
          )}
        </article>

        {/* Meta sidebar */}
        <aside className="rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md p-5 h-fit space-y-4">
          <SparkMetaRow
            label="outcome"
            value={t.outcome ? t.outcome : null}
            fallback="tbd"
          />
          <SparkMetaRow
            label="state"
            value={t.state}
            stateBadge={!!t.state}
          />
          {Array.isArray(t.evolution) && t.evolution.length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">
                evolution
              </div>
              <ol className="flex flex-wrap gap-1.5 text-[10px] font-mono">
                {t.evolution.map((step: string) => (
                  <li
                    key={step}
                    className={`px-2 py-0.5 rounded-full border ${
                      step === t.state
                        ? STATE_COLOR[step] ??
                          "bg-white/15 text-white/80 border-white/15"
                        : "text-white/35 border-white/10"
                    }`}
                  >
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          )}
          <SparkMetaRow
            label="parent"
            value={parentRelStr}
            fallback="root"
            mono
          />
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">
              children
            </div>
            {children.length === 0 ? (
              <div className="text-white/30 text-xs font-mono">none</div>
            ) : (
              <ul className="text-xs font-mono text-white/65 space-y-0.5">
                {children.map((c: any, i: number) => (
                  <li key={i} className="truncate">
                    {typeof c === "string" ? c : JSON.stringify(c)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <SparkMetaRow
            label="created"
            value={
              t.createdAt
                ? new Date(t.createdAt).toISOString().slice(0, 10)
                : null
            }
            mono
          />
          <SparkMetaRow
            label="updated"
            value={
              t.updatedAt
                ? new Date(t.updatedAt).toISOString().slice(0, 10)
                : null
            }
            mono
          />
          {log.length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">
                log
              </div>
              <ul className="text-[11px] font-mono text-white/55 space-y-1">
                {log.slice(-4).map((entry: any, i: number) => (
                  <li key={i} className="truncate">
                    <span className="text-white/30">
                      {entry.at?.slice(0, 10) ?? "?"}
                    </span>{" "}
                    {entry.event ?? "—"}
                    {entry.state ? (
                      <span className="text-white/35">
                        {" "}
                        → {entry.state}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="pt-2 border-t border-white/10">
            <div className="text-[10px] font-mono uppercase tracking-widest text-white/30 break-all">
              {spark?.abs ?? ""}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function SparkMetaRow({
  label,
  value,
  fallback,
  mono,
  stateBadge,
}: {
  label: string;
  value: string | null | undefined;
  fallback?: string;
  mono?: boolean;
  stateBadge?: boolean;
}) {
  const display = value && value.length > 0 ? value : fallback ?? null;
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1">
        {label}
      </div>
      {display === null ? (
        <div className="text-white/25 italic text-xs font-mono">empty</div>
      ) : stateBadge ? (
        <span
          className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-mono uppercase tracking-wider ${
            STATE_COLOR[display] ??
            "bg-white/15 text-white/80 border-white/15"
          }`}
        >
          {display}
        </span>
      ) : (
        <div
          className={`text-white/80 text-sm ${mono ? "font-mono text-xs" : ""}`}
        >
          {display}
        </div>
      )}
    </div>
  );
}

function HumanThoughtsView({
  relPath,
  onOpen,
}: {
  relPath: string;
  onOpen: (rel: string) => void;
}) {
  const [thoughts, setThoughts] = useState<any[]>([]);
  const [count, setCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(`/api/thoughts?rel=${encodeURIComponent(relPath)}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setErr(j.error ?? "failed to load thoughts");
        } else {
          setThoughts(j.thoughts ?? []);
          setCount(j.count ?? 0);
          setTruncated(!!j.truncated);
        }
      })
      .catch((e) => !cancelled && setErr(e?.message ?? "fetch failed"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [relPath]);

  return (
    <div className="absolute inset-0 pt-[180px] pb-[110px] pl-[210px] pr-6 overflow-auto">
      <div className="w-full max-w-[960px]">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[10px] font-mono uppercase tracking-widest text-white/40">
            thoughts in /{relPath || ""}
            {loading ? " · loading..." : ` · ${count}`}
            {truncated && " · truncated"}
          </div>
        </div>
        {err && (
          <div className="px-3 py-1.5 rounded-md bg-red-950/60 border border-red-900/60 text-red-200 text-xs font-mono">
            {err}
          </div>
        )}
        {!err && !loading && thoughts.length === 0 && (
          <div className="text-white/35 text-sm font-mono py-12 text-center">
            no thoughts here yet · use{" "}
            <span className="text-[#83d63a]/80">+ new thought</span> in the
            sidebar
          </div>
        )}
        {!err && thoughts.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {thoughts.map((t) => (
              <ThoughtCard key={t.rel} t={t} onOpen={() => onOpen(t.rel)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const STATE_COLOR: Record<string, string> = {
  thought: "bg-white/15 text-white/70 border-white/15",
  idea: "bg-amber-400/15 text-amber-200 border-amber-400/30",
  vision: "bg-sky-400/15 text-sky-200 border-sky-400/30",
  mission: "bg-[#83d63a]/15 text-[#83d63a] border-[#83d63a]/30",
};

function ThoughtCard({ t, onOpen }: { t: any; onOpen: () => void }) {
  const stateCls = STATE_COLOR[t.state] ?? STATE_COLOR.thought;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left p-4 rounded-2xl bg-black/40 border border-white/10 hover:border-white/25 hover:bg-black/60 backdrop-blur-md transition group"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="text-sm font-mono text-white/90 truncate">
          {t.identity}
        </div>
        <span
          className={`px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded-full border ${stateCls}`}
        >
          {t.state}
        </span>
      </div>
      <div className="text-xs text-white/65 leading-relaxed line-clamp-3 min-h-[3em]">
        {t.purpose || (
          <span className="text-white/25 italic">no purpose set</span>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between text-[10px] font-mono uppercase tracking-widest">
        <span className="text-white/30 truncate">/{t.rel}</span>
        {t.outcome ? (
          <span className="text-white/45 truncate ml-2">
            → {t.outcome}
          </span>
        ) : (
          <span className="text-white/25 ml-2">outcome: tbd</span>
        )}
      </div>
    </button>
  );
}

function NewThoughtModal({
  parentRel,
  onClose,
  onCreated,
}: {
  parentRel: string;
  onClose: () => void;
  onCreated: (rel: string) => void;
}) {
  const [name, setName] = useState<string>("");
  const [purpose, setPurpose] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !purpose.trim()) return;
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch("/api/thought", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          purpose: purpose.trim(),
          parentRel,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? "create failed");
      } else {
        onCreated(json.rel as string);
      }
    } catch (e: any) {
      setErr(e?.message ?? "network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-md"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-[min(520px,92vw)] p-7 rounded-2xl bg-black/80 border border-white/10 backdrop-blur-md flex flex-col gap-4 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-mono uppercase tracking-widest text-white/80">
            new thought
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-white/40 hover:text-white text-xs px-2 py-1 rounded-md hover:bg-white/10"
            aria-label="close"
          >
            esc
          </button>
        </div>

        <div className="text-[10px] font-mono uppercase tracking-widest text-white/35">
          parent · {parentRel ? `/${parentRel}` : "/ (root)"}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-widest text-white/45">
            identity (folder name)
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-black/40 border border-white/15 rounded-md px-3 py-2 text-sm font-mono text-white/90 placeholder-white/25 focus:outline-none focus:border-white/40"
            placeholder="e.g. observe-redesign"
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-widest text-white/45">
            purpose (why this thought exists)
          </span>
          <textarea
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={4}
            className="bg-black/40 border border-white/15 rounded-md px-3 py-2 text-sm font-mono text-white/90 placeholder-white/25 focus:outline-none focus:border-white/40 resize-none"
            placeholder="A short statement of intent."
          />
        </label>

        <div className="text-[10px] font-mono uppercase tracking-widest text-white/30">
          state: thought · outcome: (tbd) · evolves thought → idea → vision → mission
        </div>

        {err && (
          <div className="px-3 py-1.5 rounded-md bg-red-950/60 border border-red-900/60 text-red-200 text-xs font-mono">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-mono uppercase tracking-wider rounded-full text-white/55 hover:text-white/90 hover:bg-white/10 transition"
          >
            cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim() || !purpose.trim()}
            className="px-5 py-2 text-xs font-mono uppercase tracking-wider rounded-full bg-[#83d63a]/90 hover:bg-[#83d63a] text-black font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "creating..." : "create"}
          </button>
        </div>
      </form>
    </div>
  );
}
