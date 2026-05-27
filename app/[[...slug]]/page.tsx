"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Universe,
  type Entry,
  type HoverInfo,
  type ClickInfo,
  type FolderOpenInfo,
  type SessionInfo,
} from "@/components/Universe";
import { Timeline, type Commit } from "@/components/Timeline";
import { Preview, type PreviewTarget } from "@/components/Preview";
import {
  Galaxies,
  type GalaxyNode,
  type GalaxyEdge,
  type GalaxyHover,
} from "@/components/Galaxies";
import {
  Evolution,
  type EvolutionCommit,
  type EvolutionFile,
  type EvolutionHover,
} from "@/components/Evolution";
import { Visualize, type ReadmePayload } from "@/components/Visualize";

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

// The path the Visualizer shows is relative to the root (BIG_BANG, set in .env);
// the browser URL *is* that relative path. "" means the root itself.
function relFromUrl(): string {
  if (typeof window === "undefined") return "";
  return decodeURIComponent(window.location.pathname)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

// Read ?timetraveltrace=sha1,sha2,... into an ordered list. SHAs are lowercased
// and de-junked (only [0-9a-f]); empty entries are dropped, but we keep the
// order and any duplicates the user chose (revisits are valid moves).
function readTraceFromUrl(): string[] {
  if (typeof window === "undefined") return [];
  const raw = new URLSearchParams(window.location.search).get("timetraveltrace");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && /^[0-9a-f]+$/.test(s));
}

export default function Page() {
  // activePath: relative-from-root path. null only before the first URL read.
  const [pathInput, setPathInput] = useState<string>("");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState<boolean>(false);

  const [data, setData] = useState<ScanResult | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotsResult | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewTarget>(null);

  const [scanLoading, setScanLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo>(null);

  // The universe lifecycle verbs (observe.py: start / fetch / update / clone).
  const [busyVerb, setBusyVerb] = useState<string | null>(null);
  const [verbMsg, setVerbMsg] = useState<string | null>(null);
  const [modal, setModal] = useState<"about" | "changelog" | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  // View: "galaxies" = the whole universe as a graph of folders (galaxies)
  // linked by cross-references; "folder" = the classic single-folder explorer;
  // "evolution" = the universe through time, fed by xo.json;
  // "visualize" = the universe's README rendered as its self-description.
  const [view, setView] = useState<
    "galaxies" | "folder" | "evolution" | "visualize"
  >("galaxies");
  const [galaxyData, setGalaxyData] = useState<{ galaxies: GalaxyNode[]; edges: GalaxyEdge[] } | null>(null);
  const [galaxyHover, setGalaxyHover] = useState<GalaxyHover>(null);
  const [evolutionData, setEvolutionData] = useState<{
    commits: EvolutionCommit[];
    lanes: string[];
    files: EvolutionFile[];
    xoExists: boolean;
    xoCreated: boolean;
  } | null>(null);
  const [evolutionHover, setEvolutionHover] = useState<EvolutionHover>(null);
  // Two evolution states the user toggles between:
  //   live        → cursor pinned to the tip of xo.json; polls for new ticks
  //   time-travel → cursor is free to scrub the past; playback + bookmarks
  // The frontend never walks git for visualization data — everything here
  // comes from xo.json (auto-created empty if missing, see /api/xo).
  const [evoMode, setEvoMode] = useState<"live" | "time-travel">("live");
  const [traceSHAs, setTraceSHAs] = useState<string[]>([]);
  const [currentSha, setCurrentSha] = useState<string | null>(null);
  const [playing, setPlaying] = useState<boolean>(false);
  const [playSpeedMs, setPlaySpeedMs] = useState<number>(400);
  const [rebuilding, setRebuilding] = useState<boolean>(false);
  const [readme, setReadme] = useState<ReadmePayload | null>(null);
  const [readmeLoading, setReadmeLoading] = useState<boolean>(false);

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
    async (path: string, ref: string | null) => {
      setScanLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, showHidden, ref }),
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

  const loadSnapshots = useCallback(async (path: string) => {
    try {
      const res = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
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

  // Go to a folder by its path relative to the root, optionally pushing the
  // browser URL so the location bar always equals the relative path.
  const navigate = useCallback(
    (rel: string, push: boolean) => {
      const clean = rel.replace(/^\/+/, "").replace(/\/+$/, "");
      if (push && typeof window !== "undefined") {
        window.history.pushState({}, "", "/" + clean);
      }
      setActivePath(clean);
      setPathInput(clean);
      setSelectedSha(null);
      setSnapshots(null);
      setPreview(null);
      loadSnapshots(clean);
    },
    [loadSnapshots],
  );

  // Start from whatever the URL says, and follow browser back/forward.
  useEffect(() => {
    navigate(relFromUrl(), false);
    const onPop = () => {
      navigate(relFromUrl(), false);
      setTraceSHAs(readTraceFromUrl());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hydrate the time-travel trace from the URL on first mount, then mirror any
  // future changes back into the URL via replaceState (so the trace doesn't
  // pollute browser history with a new entry per click).
  useEffect(() => {
    setTraceSHAs(readTraceFromUrl());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (traceSHAs.length === 0) {
      url.searchParams.delete("timetraveltrace");
    } else {
      url.searchParams.set("timetraveltrace", traceSHAs.join(","));
    }
    const next = url.pathname + (url.search ? url.search : "") + url.hash;
    const cur = window.location.pathname + window.location.search + window.location.hash;
    if (next !== cur) window.history.replaceState({}, "", next);
  }, [traceSHAs]);

  // Scan whenever the folder, the scrubbed commit, or hidden-toggle changes.
  useEffect(() => {
    if (activePath === null) return;
    scan(activePath, selectedSha);
  }, [activePath, selectedSha, showHidden, scan]);

  const runVerb = useCallback(
    async (action: "start" | "fetch" | "update" | "clone") => {
      let url: string | undefined;
      let dest: string | undefined;
      if (action === "clone") {
        url = window.prompt("clone which universe? (git url)")?.trim();
        if (!url) return;
        dest = window.prompt("into which directory? (blank = default)")?.trim() || undefined;
      }
      setBusyVerb(action);
      setVerbMsg(null);
      try {
        const res = await fetch("/api/universe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, url, dest }),
        });
        const json = await res.json();
        setVerbMsg(
          json.output?.trim() ||
            json.error ||
            (json.ok ? `${action}: done` : `${action}: failed`),
        );
        // A verb may have changed history; refresh what we're looking at.
        if (json.ok && activePath) {
          loadSnapshots(activePath);
          scan(activePath, selectedSha);
        }
      } catch (e: any) {
        setVerbMsg(e?.message ?? `${action} failed`);
      } finally {
        setBusyVerb(null);
      }
    },
    [activePath, loadSnapshots, scan, selectedSha],
  );

  const travelTo = useCallback(
    async (ref: string) => {
      setBusyVerb("travel");
      setVerbMsg(null);
      try {
        const res = await fetch("/api/universe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "travel", ref }),
        });
        const json = await res.json();
        setVerbMsg(
          json.output?.trim() ||
            json.error ||
            (json.ok ? "traveled" : "travel failed"),
        );
        // The working tree moved; re-read it (at the live HEAD, not a preview ref).
        if (json.ok && activePath) {
          setSelectedSha(null);
          loadSnapshots(activePath);
          scan(activePath, null);
        }
      } catch (e: any) {
        setVerbMsg(e?.message ?? "travel failed");
      } finally {
        setBusyVerb(null);
      }
    },
    [activePath, loadSnapshots, scan],
  );

  useEffect(() => {
    if (!verbMsg) return;
    const id = setTimeout(() => setVerbMsg(null), 8000);
    return () => clearTimeout(id);
  }, [verbMsg]);

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  // Poll the active Claude sessions living in the universe; they orbit the folder.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/sessions");
        const json = await res.json();
        if (alive && Array.isArray(json.sessions)) setSessions(json.sessions);
      } catch {
        /* leave the last known set in place */
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Load the whole-universe galaxy graph when that view is shown.
  useEffect(() => {
    if (view !== "galaxies" || galaxyData) return;
    let alive = true;
    fetch("/api/galaxies")
      .then((r) => r.json())
      .then((j) => {
        if (alive && Array.isArray(j.galaxies)) {
          setGalaxyData({ galaxies: j.galaxies, edges: j.edges ?? [] });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [view, galaxyData]);

  // Click a galaxy → drop into the classic explorer at that folder.
  const openGalaxy = useCallback(
    (relPath: string) => {
      setView("folder");
      navigate(relPath, true);
    },
    [navigate],
  );

  // Load (and, in live mode, keep refreshing) the universe's evolution from
  // xo.json. In time-travel mode we read once and let the user scrub; in live
  // mode we poll every few seconds so newly-recorded ticks appear without a
  // page reload.
  useEffect(() => {
    if (view !== "evolution") return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/evolution");
        const j = await res.json();
        if (
          alive &&
          Array.isArray(j.commits) &&
          Array.isArray(j.lanes) &&
          Array.isArray(j.files)
        ) {
          setEvolutionData({
            commits: j.commits,
            lanes: j.lanes,
            files: j.files,
            xoExists: !!j.xoExists,
            xoCreated: !!j.xoCreated,
          });
        }
      } catch {
        /* keep previous data if a poll briefly fails */
      }
    };
    load();
    if (evoMode !== "live") return;
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [view, evoMode]);

  // In live mode the cursor is always the tip of xo.json. Whenever the data
  // refreshes (a poll picked up a new tick) we re-snap the cursor forward.
  useEffect(() => {
    if (evoMode !== "live" || !evolutionData) return;
    const commits = evolutionData.commits;
    if (commits.length === 0) return;
    setPlaying(false);
    setCurrentSha(commits[commits.length - 1].sha);
  }, [evoMode, evolutionData]);

  // The Visualize tab reads /api/readme on demand. We keep a single payload in
  // state; pressing "↻ try again" inside the component re-runs this loader.
  const loadReadme = useCallback(async () => {
    setReadmeLoading(true);
    try {
      const res = await fetch("/api/readme");
      const j = (await res.json()) as ReadmePayload;
      setReadme(j);
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? String(e);
      setReadme({ exists: false, error: msg });
    } finally {
      setReadmeLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view !== "visualize") return;
    if (readme || readmeLoading) return;
    loadReadme();
  }, [view, readme, readmeLoading, loadReadme]);

  const rebuildXo = useCallback(async () => {
    setRebuilding(true);
    try {
      const res = await fetch("/api/xo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rebuild" }),
      });
      const j = await res.json();
      if (j.ok && j.xo) {
        setEvolutionData({
          commits: Array.isArray(j.xo.evolution) ? j.xo.evolution : [],
          lanes: Array.isArray(j.xo.lanes) ? j.xo.lanes : [],
          files: Array.isArray(j.xo.files) ? j.xo.files : [],
          xoExists: true,
          xoCreated: false,
        });
      }
    } catch {
      /* swallow; the live poll will catch up */
    } finally {
      setRebuilding(false);
    }
  }, []);

  // Clicking a tick (timeline or canvas) appends the commit to the trace *and*
  // moves the cursor there. Repeating the same sha collapses to avoid stacking
  // redundant trace markers.
  const pushTrace = useCallback((sha: string | null) => {
    if (!sha) return;
    setCurrentSha(sha);
    setTraceSHAs((prev) => {
      if (prev[prev.length - 1] === sha) return prev;
      return [...prev, sha];
    });
  }, []);

  const clearTrace = useCallback(() => setTraceSHAs([]), []);
  const undoTrace = useCallback(
    () => setTraceSHAs((prev) => (prev.length === 0 ? prev : prev.slice(0, -1))),
    [],
  );

  // If the user clears the trace, snap the cursor back to "present" (no commit
  // selected) — that's the live HEAD of the universe.
  useEffect(() => {
    if (traceSHAs.length === 0) return;
    const tail = traceSHAs[traceSHAs.length - 1];
    if (currentSha === null) setCurrentSha(tail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceSHAs]);

  // Playback: every N ms advance the cursor to the next commit. Auto-stops at
  // the tip. We never write into the trace from here — playback is ephemeral.
  useEffect(() => {
    if (!playing || view !== "evolution" || !evolutionData) return;
    const commits = evolutionData.commits;
    if (commits.length === 0) return;
    const id = setInterval(() => {
      setCurrentSha((cur) => {
        const idx = cur ? commits.findIndex((c) => c.sha === cur) : -1;
        const next = idx < 0 ? 0 : idx + 1;
        if (next >= commits.length) {
          setPlaying(false);
          return commits[commits.length - 1].sha;
        }
        return commits[next].sha;
      });
    }, Math.max(60, playSpeedMs));
    return () => clearInterval(id);
  }, [playing, playSpeedMs, view, evolutionData]);

  const entries = data?.entries ?? [];

  const onSelectFile = useCallback((info: ClickInfo) => {
    setPreview({ name: info.name, path: info.path, kind: info.kind });
  }, []);

  const onFolderOpen = useCallback(
    (info: FolderOpenInfo) => {
      // info.path is already relative to the root.
      navigate(info.path, true);
    },
    [navigate],
  );

  function goBack() {
    if (!activePath) return;
    const parent = activePath.split("/").slice(0, -1).join("/");
    navigate(parent, true);
  }

  return (
    <main className="fixed inset-0 flex flex-col overflow-hidden">
      {/* ── Top toolbar: identity · view tabs · universe lifecycle verbs ── */}
      <header className="relative z-30 flex items-center gap-3 px-3 h-12 shrink-0 border-b border-white/10 bg-black/50 backdrop-blur-md">
        <div className="flex items-center gap-2 select-none pr-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/xo-logo.svg" alt="XO" width={22} height={22} className="opacity-90" />
          <span className="text-sm font-semibold tracking-wider text-white/80">XO</span>
        </div>
        <div className="flex items-center gap-1 text-[11px] font-mono">
          {(["galaxies", "folder", "evolution", "visualize"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={
                "px-2.5 py-1 rounded-full border transition " +
                (view === v
                  ? "bg-white/15 border-white/25 text-white"
                  : "bg-black/30 border-white/10 text-white/45 hover:text-white/80")
              }
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          {(["start", "fetch", "update", "clone"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => runVerb(v)}
              disabled={busyVerb !== null}
              className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 border border-white/15 text-white/75 hover:bg-white/10 hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
              title={`observe.py ${v}`}
            >
              {busyVerb === v ? `${v}…` : v}
            </button>
          ))}
          <span className="w-px h-5 bg-white/10 mx-0.5" />
          <button
            type="button"
            onClick={() => setModal("about")}
            className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 border border-white/15 text-white/75 hover:bg-white/10 hover:text-white transition"
            title="about this universe (observatory)"
          >
            about
          </button>
          <button
            type="button"
            onClick={() => setModal("changelog")}
            className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 border border-white/15 text-white/75 hover:bg-white/10 hover:text-white transition"
            title="what changed, tick by tick (CHANGELOG.md)"
          >
            changelog
          </button>
        </div>
      </header>

      {/* ── Canvas stage: fills the space between the toolbar and the bottom bar ── */}
      <div ref={stageRef} className="relative flex-1 min-h-0">
        {stage.w > 0 && stage.h > 0 && view === "folder" && (
          <Universe
            entries={entries}
            sessions={sessions}
            width={stage.w}
            height={stage.h}
            onHover={setHover}
            onSelect={onSelectFile}
            onFolderOpen={onFolderOpen}
          />
        )}
        {stage.w > 0 && stage.h > 0 && view === "galaxies" && galaxyData && (
          <Galaxies
            galaxies={galaxyData.galaxies}
            edges={galaxyData.edges}
            width={stage.w}
            height={stage.h}
            onOpen={openGalaxy}
            onHover={setGalaxyHover}
          />
        )}
        {stage.w > 0 && stage.h > 0 && view === "evolution" && evolutionData && (
          <Evolution
            commits={evolutionData.commits}
            lanes={evolutionData.lanes}
            files={evolutionData.files}
            width={stage.w}
            height={stage.h}
            currentSha={currentSha}
            traceSHAs={traceSHAs}
            onHover={setEvolutionHover}
            onPickCommit={(c) => pushTrace(c.sha)}
          />
        )}
        {view === "visualize" && (
          <Visualize
            payload={readme}
            loading={readmeLoading}
            onReload={loadReadme}
          />
        )}
      </div>


      {/* Verb result toast */}
      {verbMsg && (
        <div className="absolute bottom-5 left-5 z-30 max-w-[min(440px,42vw)] px-3 py-2 rounded-md bg-black/80 border border-white/10 text-[11px] font-mono text-white/70 whitespace-pre-wrap backdrop-blur shadow-[0_10px_40px_-10px_rgba(0,0,0,0.7)]">
          {verbMsg}
        </div>
      )}

      {/* Info modal — the observatory (about) or the changelog */}
      {modal && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setModal(null)}
        >
          <div
            className="relative w-[min(920px,94vw)] h-[min(86vh,920px)] rounded-2xl overflow-hidden border border-white/15 bg-[#06070d] shadow-[0_30px_120px_-20px_rgba(0,0,0,0.8)]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setModal(null)}
              className="absolute top-3 right-3 z-10 px-3 py-1.5 text-xs font-mono rounded-full bg-black/50 border border-white/15 text-white/70 hover:bg-white/10 backdrop-blur"
              title="close (Esc)"
            >
              ✕ close
            </button>
            <iframe
              src={modal === "about" ? "/api/about" : "/api/changelog"}
              title={modal === "about" ? "About — the observatory" : "Changelog"}
              className="w-full h-full border-0 bg-[#06070d]"
            />
          </div>
        </div>
      )}

      {/* Back chip */}
      {view === "folder" && !!activePath && (
        <button
          type="button"
          onClick={goBack}
          className="absolute top-4 right-4 z-20 px-3 py-1.5 text-xs font-mono text-white/70 rounded-full bg-black/40 border border-white/15 hover:bg-white/10 backdrop-blur-md"
          title="Go up one level"
        >
          ← back
        </button>
      )}

      {/* Path bar (folder view only) */}
      {view === "folder" && (
      <div className="absolute top-16 left-1/2 -translate-x-1/2 z-10 w-[min(720px,92vw)]">
        <form
          className="flex items-center gap-2 px-3 py-2 rounded-full bg-black/40 border border-white/10 backdrop-blur-md shadow-[0_10px_40px_-10px_rgba(0,0,0,0.6)]"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(pathInput, true);
          }}
        >
          <span className="pl-2 text-sm font-mono text-white/30 select-none">/</span>
          <input
            className="flex-1 bg-transparent px-1 py-1.5 text-sm font-mono text-white/90 placeholder-white/30 focus:outline-none"
            placeholder="path relative to the root (blank = the big bang)"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <label className="flex items-center gap-1.5 text-[11px] text-white/40 px-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-white/70"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            hidden
          </label>
          <button
            type="submit"
            className="px-4 py-1.5 text-sm rounded-full bg-white/10 hover:bg-white/20 text-white/90 border border-white/15 transition"
            disabled={scanLoading}
          >
            {scanLoading ? "..." : "observe"}
          </button>
        </form>
        {data && !error && (
          <div className="mt-2 text-center text-[11px] font-mono text-white/30 truncate">
            {data.root === "" ? "/ (root)" : "/" + data.root}
            <span className="mx-2">·</span>
            {data.entries.length} entries
            <span className="mx-2">·</span>
            {formatBytes(data.totalSize)}
            {sessions.length > 0 && (
              <>
                <span className="mx-2">·</span>
                <span className="text-amber-200/60">
                  {sessions.length} session{sessions.length === 1 ? "" : "s"} orbiting
                </span>
              </>
            )}
            {data.hiddenFiltered && (
              <>
                <span className="mx-2">·</span>hidden filtered
              </>
            )}
          </div>
        )}
        {error && (
          <div className="mt-2 px-3 py-1.5 rounded-md bg-red-950/60 border border-red-900/60 text-red-200 text-xs font-mono text-center">
            {error}
          </div>
        )}
      </div>
      )}

      {view === "folder" && activePath !== null && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 w-[min(900px,94vw)] px-4 py-3 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md">
          <Timeline
            commits={snapshots?.commits ?? []}
            isGit={!!snapshots?.isGit}
            selected={selectedSha}
            onSelect={setSelectedSha}
          />
          {snapshots?.isGit && (
            <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between gap-3">
              <span className="text-[10px] text-white/30 font-mono">
                scrub to preview · travel to move the universe there
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => selectedSha && travelTo(selectedSha)}
                  disabled={busyVerb !== null || !selectedSha}
                  className="px-3 py-1.5 text-xs font-mono rounded-full bg-white/10 hover:bg-white/20 text-white/90 border border-white/15 transition disabled:opacity-30 disabled:cursor-not-allowed"
                  title={selectedSha ? `git checkout ${selectedSha.slice(0, 8)}` : "pick a commit on the timeline first"}
                >
                  {busyVerb === "travel" ? "traveling…" : "⤓ travel here"}
                </button>
                <button
                  type="button"
                  onClick={() => travelTo("present")}
                  disabled={busyVerb !== null}
                  className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 hover:bg-white/10 text-white/70 border border-white/15 transition disabled:opacity-40"
                  title="return to the tip of the timeline (now)"
                >
                  ⌂ present
                </button>
              </div>
            </div>
          )}
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

      {view === "folder" && activePath === null && !scanLoading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-white/25 text-xs font-mono tracking-widest">
            observing the universe…
          </div>
        </div>
      )}

      {/* Galaxy view: legend + hover tooltip */}
      {view === "galaxies" && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-full bg-black/40 border border-white/10 backdrop-blur-md text-[11px] font-mono text-white/40">
          {galaxyData
            ? `${galaxyData.galaxies.length} galaxies · ${galaxyData.edges.length} links · drag to pan · scroll to zoom · click a galaxy to enter`
            : "charting the universe…"}
        </div>
      )}
      {view === "galaxies" && galaxyHover && (
        <div
          className="pointer-events-none fixed z-20 px-3 py-2 rounded-md bg-black/85 border border-white/10 text-xs font-mono backdrop-blur"
          style={{ left: galaxyHover.x + 14, top: galaxyHover.y + 14, maxWidth: 320 }}
        >
          <div className="text-white/90 truncate">{galaxyHover.name}/</div>
          <div className="text-white/45">
            {galaxyHover.fileCount} files
            {galaxyHover.path && <span className="text-white/25"> · /{galaxyHover.path}</span>}
          </div>
          <div className="text-[10px] mt-1 text-white/40">click to enter this galaxy</div>
        </div>
      )}

      {/* Evolution view: a live/time-travel toggle plus the matching controls.
          Both states read from xo.json — live mode pins the cursor to the tip
          and polls for new ticks; time-travel mode unlocks scrubbing, playback,
          and bookmarks (synced to ?timetraveltrace). If xo.json is empty we
          surface a "rebuild from git" affordance front and center. */}
      {view === "evolution" && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 w-[min(960px,94vw)] px-4 py-3 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md">
          {/* Mode toggle + always-present rebuild action */}
          <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
            <div className="flex items-center gap-1 text-[11px] font-mono">
              {(["live", "time-travel"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setEvoMode(m);
                    if (m === "live") setPlaying(false);
                  }}
                  className={
                    "px-3 py-1 rounded-full border transition " +
                    (evoMode === m
                      ? "bg-white/15 border-white/25 text-white"
                      : "bg-black/30 border-white/10 text-white/45 hover:text-white/80")
                  }
                  title={
                    m === "live"
                      ? "pin the cursor to the tip; poll xo.json for new ticks"
                      : "scrub through history, play it back, bookmark moments"
                  }
                >
                  {m === "live" ? "● live" : "↺ time-travel"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-white/30 font-mono truncate max-w-[280px]">
                {evolutionData
                  ? `xo.json · ${evolutionData.commits.length} ticks · ${evolutionData.files.length} lifelines`
                  : "loading xo.json…"}
              </span>
              <button
                type="button"
                onClick={rebuildXo}
                disabled={rebuilding}
                className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 hover:bg-white/10 text-white/70 border border-white/15 transition disabled:opacity-40 disabled:cursor-not-allowed"
                title="rebuild xo.json from git history (preserves unknown keys)"
              >
                {rebuilding ? "rebuilding…" : "↻ rebuild xo.json"}
              </button>
            </div>
          </div>

          {!evolutionData ? (
            <div className="text-center text-[11px] font-mono text-white/40 py-2">
              reading xo.json…
            </div>
          ) : evolutionData.commits.length === 0 ? (
            <div className="text-center text-[11px] font-mono text-white/50 py-3 border-t border-white/10">
              {evolutionData.xoCreated
                ? "xo.json was just created (empty). press ↻ rebuild to populate it from git."
                : "xo.json has no evolution data yet — observe.py hasn't recorded any ticks. press ↻ rebuild to bootstrap from git."}
            </div>
          ) : evoMode === "live" ? (
            <div className="pt-2 border-t border-white/10 flex items-center justify-between gap-3">
              <span className="text-[11px] font-mono text-white/65 truncate">
                ● <span className="text-emerald-300/80">live</span> · pinned to{" "}
                {(() => {
                  const tip = evolutionData.commits[evolutionData.commits.length - 1];
                  if (!tip) return "—";
                  const t = tip.message.match(/^t=(\d+)/);
                  return t ? `t=${t[1]}` : tip.shortSha;
                })()}
                <span className="mx-1.5 text-white/25">·</span>
                polls xo.json every 5s
              </span>
              <span className="text-[10px] font-mono text-white/30">
                switch to ↺ time-travel to scrub
              </span>
            </div>
          ) : (
            <>
              <Timeline
                commits={evolutionData.commits}
                isGit={true}
                selected={currentSha}
                onSelect={(sha) => {
                  setPlaying(false);
                  setCurrentSha(sha);
                }}
              />
              <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const commits = evolutionData.commits;
                      if (commits.length === 0) return;
                      const tipSha = commits[commits.length - 1].sha;
                      if (!playing && currentSha === tipSha) {
                        setCurrentSha(commits[0].sha);
                      }
                      setPlaying((p) => !p);
                    }}
                    className="px-3 py-1.5 text-xs font-mono rounded-full bg-white/10 hover:bg-white/20 text-white/90 border border-white/15 transition"
                    title="play the universe forward through history"
                  >
                    {playing ? "⏸ pause" : "▶ play"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPlaying(false);
                      if (evolutionData.commits[0])
                        setCurrentSha(evolutionData.commits[0].sha);
                    }}
                    className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 hover:bg-white/10 text-white/70 border border-white/15 transition"
                    title="rewind to the big bang"
                  >
                    ⏮ big bang
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPlaying(false);
                      const c =
                        evolutionData.commits[evolutionData.commits.length - 1];
                      if (c) setCurrentSha(c.sha);
                    }}
                    className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 hover:bg-white/10 text-white/70 border border-white/15 transition"
                    title="jump to the present"
                  >
                    ⏭ present
                  </button>
                  <label className="ml-2 flex items-center gap-1.5 text-[10px] font-mono text-white/40">
                    speed
                    <input
                      type="range"
                      min={80}
                      max={1200}
                      step={20}
                      value={1280 - playSpeedMs}
                      onChange={(e) =>
                        setPlaySpeedMs(1280 - Number(e.target.value))
                      }
                      className="accent-white/70"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (!currentSha) return;
                      pushTrace(currentSha);
                    }}
                    disabled={!currentSha}
                    className="px-3 py-1.5 text-xs font-mono rounded-full bg-white/10 hover:bg-white/20 text-white/90 border border-white/15 transition disabled:opacity-30 disabled:cursor-not-allowed"
                    title="bookmark the moment you're looking at into the trace"
                  >
                    ★ bookmark
                  </button>
                  <button
                    type="button"
                    onClick={undoTrace}
                    disabled={traceSHAs.length === 0}
                    className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 hover:bg-white/10 text-white/70 border border-white/15 transition disabled:opacity-30 disabled:cursor-not-allowed"
                    title="drop the most recent bookmark"
                  >
                    ↶ undo
                  </button>
                  <button
                    type="button"
                    onClick={clearTrace}
                    disabled={traceSHAs.length === 0}
                    className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 hover:bg-white/10 text-white/70 border border-white/15 transition disabled:opacity-30 disabled:cursor-not-allowed"
                    title="erase the whole trace and clear the query param"
                  >
                    ✕ clear
                  </button>
                </div>
              </div>
              <div className="mt-1.5 text-[10px] text-white/30 font-mono text-center truncate">
                {traceSHAs.length === 0
                  ? `${evolutionData.commits.length} ticks · scrub the timeline or press play · bookmark to record`
                  : `trace: ${traceSHAs.length} step${traceSHAs.length === 1 ? "" : "s"} · synced to ?timetraveltrace`}
              </div>
            </>
          )}
        </div>
      )}
      {view === "evolution" && evolutionHover && (
        <div
          className="pointer-events-none fixed z-20 px-3 py-2 rounded-md bg-black/85 border border-white/10 text-xs font-mono backdrop-blur"
          style={{ left: evolutionHover.x + 14, top: evolutionHover.y + 14, maxWidth: 380 }}
        >
          <div className="text-white/90 truncate">
            {evolutionHover.path
              ? evolutionHover.path
              : evolutionHover.lane === "(root)"
                ? "root"
                : `${evolutionHover.lane}/`}
          </div>
          <div className="text-white/45 text-[10px] truncate">
            {evolutionHover.path ? `lane · ${evolutionHover.lane}` : "no file at this row/commit"}
          </div>
          <div className="text-white/55 truncate mt-1 pt-1 border-t border-white/10">
            {evolutionHover.commit.message || "(no message)"}
          </div>
          <div className="text-white/35 text-[10px] mt-0.5">
            {evolutionHover.commit.shortSha}
            {evolutionHover.commit.author && (
              <>
                <span className="mx-1.5">·</span>
                {evolutionHover.commit.author}
              </>
            )}
            <span className="mx-1.5">·</span>
            {new Date(evolutionHover.commit.date).toLocaleString()}
            <span className="mx-1.5">·</span>
            {evolutionHover.commit.total} alive
          </div>
        </div>
      )}

      <Preview
        target={preview}
        gitRef={selectedSha}
        onClose={() => setPreview(null)}
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
