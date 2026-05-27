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
  type EvolutionHover,
} from "@/components/Evolution";

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
  // "evolution" = the universe stacked through time, lane = top-level folder.
  const [view, setView] = useState<"galaxies" | "folder" | "evolution">("galaxies");
  const [galaxyData, setGalaxyData] = useState<{ galaxies: GalaxyNode[]; edges: GalaxyEdge[] } | null>(null);
  const [galaxyHover, setGalaxyHover] = useState<GalaxyHover>(null);
  const [evolutionData, setEvolutionData] = useState<{ commits: EvolutionCommit[]; lanes: string[] } | null>(null);
  const [evolutionHover, setEvolutionHover] = useState<EvolutionHover>(null);
  // A trace through time: an ordered list of commit SHAs the user has visited
  // in this view. The last entry is the "current" moment. Persists in the URL
  // as ?timetraveltrace=sha1,sha2,... so a trace can be shared or replayed.
  const [traceSHAs, setTraceSHAs] = useState<string[]>([]);

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

  // Load the universe-through-time stream once the evolution tab is opened.
  useEffect(() => {
    if (view !== "evolution" || evolutionData) return;
    let alive = true;
    fetch("/api/evolution")
      .then((r) => r.json())
      .then((j) => {
        if (alive && Array.isArray(j.commits) && Array.isArray(j.lanes)) {
          setEvolutionData({ commits: j.commits, lanes: j.lanes });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [view, evolutionData]);

  // Clicking a tick in either the streamgraph or the timeline below it appends
  // the commit to the trace. Repeating the same sha collapses (no-op) so the
  // visualization doesn't accumulate redundant overlapping dots; a true revisit
  // requires clicking a different commit first.
  const pushTrace = useCallback((sha: string | null) => {
    if (!sha) return;
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

  // The "you are here" commit on the evolution view = the tail of the trace.
  const evolutionSelectedSha = traceSHAs.length > 0 ? traceSHAs[traceSHAs.length - 1] : null;

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
    <main className="fixed inset-0 overflow-hidden">
      <div ref={stageRef} className="absolute inset-0">
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
            width={stage.w}
            height={stage.h}
            selectedSha={evolutionSelectedSha}
            traceSHAs={traceSHAs}
            onHover={setEvolutionHover}
            onPickCommit={(c) => pushTrace(c.sha)}
          />
        )}
      </div>

      {/* XO logo */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2 select-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/xo-logo.svg"
          alt="XO"
          width={28}
          height={28}
          className="opacity-90"
        />
        <span className="text-sm font-semibold tracking-wider text-white/80">
          XO
        </span>
      </div>

      {/* View toggle: the whole universe as galaxies, or one folder explored */}
      <div className="absolute top-14 left-4 z-20 flex items-center gap-1 text-[11px] font-mono">
        {(["galaxies", "folder", "evolution"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={
              "px-2.5 py-1 rounded-full border backdrop-blur-md transition " +
              (view === v
                ? "bg-white/15 border-white/25 text-white"
                : "bg-black/30 border-white/10 text-white/45 hover:text-white/80")
            }
          >
            {v}
          </button>
        ))}
      </div>

      {/* Universe lifecycle verbs */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5">
        {(["start", "fetch", "update", "clone"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => runVerb(v)}
            disabled={busyVerb !== null}
            className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 border border-white/15 text-white/75 hover:bg-white/10 hover:text-white backdrop-blur-md transition disabled:opacity-40 disabled:cursor-not-allowed"
            title={`observe.py ${v}`}
          >
            {busyVerb === v ? `${v}…` : v}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setModal("about")}
          className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 border border-white/15 text-white/75 hover:bg-white/10 hover:text-white backdrop-blur-md transition"
          title="about this universe (observatory)"
        >
          about
        </button>
        <button
          type="button"
          onClick={() => setModal("changelog")}
          className="px-3 py-1.5 text-xs font-mono rounded-full bg-black/40 border border-white/15 text-white/75 hover:bg-white/10 hover:text-white backdrop-blur-md transition"
          title="what changed, tick by tick (CHANGELOG.md)"
        >
          changelog
        </button>
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

      {/* Evolution view: footer summary + hover tooltip */}
      {view === "evolution" && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-full bg-black/40 border border-white/10 backdrop-blur-md text-[11px] font-mono text-white/40">
          {evolutionData
            ? `${evolutionData.commits.length} ticks · ${evolutionData.lanes.length} lanes · the universe through time`
            : "rewinding the universe…"}
        </div>
      )}
      {view === "evolution" && evolutionHover && (
        <div
          className="pointer-events-none fixed z-20 px-3 py-2 rounded-md bg-black/85 border border-white/10 text-xs font-mono backdrop-blur"
          style={{ left: evolutionHover.x + 14, top: evolutionHover.y + 14, maxWidth: 360 }}
        >
          <div className="text-white/90 truncate">
            {evolutionHover.lane === "(root)" ? "root files" : `${evolutionHover.lane}/`}
            <span className="text-white/40"> · {evolutionHover.count}</span>
          </div>
          <div className="text-white/55 truncate">
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
            {evolutionHover.commit.total} files total
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
