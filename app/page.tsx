"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Universe, type Entry, type HoverInfo } from "@/components/Universe";
import { Timeline, type Commit } from "@/components/Timeline";

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

const DEFAULT_PATH = "~";

export default function Page() {
  const [pathInput, setPathInput] = useState<string>(DEFAULT_PATH);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState<boolean>(false);

  const [data, setData] = useState<ScanResult | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotsResult | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null); // null = live

  const [scanLoading, setScanLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo>(null);

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

  function submitPath(p: string) {
    const t = p.trim();
    if (!t) return;
    setActivePath(t);
    setSelectedSha(null);
    setData(null);
    setSnapshots(null);
    scan(t, null);
    loadSnapshots(t);
  }

  // Re-scan when selectedSha changes (and we have an active path)
  useEffect(() => {
    if (!activePath) return;
    scan(activePath, selectedSha);
  }, [selectedSha, activePath, scan]);

  // Re-scan when showHidden toggles
  useEffect(() => {
    if (!activePath) return;
    scan(activePath, selectedSha);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  const entries = data?.entries ?? [];

  return (
    <main className="fixed inset-0 overflow-hidden">
      {/* Universe stage */}
      <div ref={stageRef} className="absolute inset-0">
        {stage.w > 0 && stage.h > 0 && (
          <Universe
            entries={entries}
            width={stage.w}
            height={stage.h}
            onHover={setHover}
          />
        )}
      </div>

      {/* Top floating controls */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 w-[min(720px,92vw)]">
        <form
          className="flex items-center gap-2 px-3 py-2 rounded-full bg-black/40 border border-white/10 backdrop-blur-md shadow-[0_10px_40px_-10px_rgba(0,0,0,0.6)]"
          onSubmit={(e) => {
            e.preventDefault();
            submitPath(pathInput);
          }}
        >
          <input
            className="flex-1 bg-transparent px-3 py-1.5 text-sm font-mono text-white/90 placeholder-white/30 focus:outline-none"
            placeholder="paste a folder path (e.g. ~/Programming/myrepo)"
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
            disabled={scanLoading || !pathInput.trim()}
          >
            {scanLoading ? "..." : "observe"}
          </button>
        </form>
        {data && !error && (
          <div className="mt-2 text-center text-[11px] font-mono text-white/30 truncate">
            {data.root}
            <span className="mx-2">·</span>
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
          <div className="mt-2 px-3 py-1.5 rounded-md bg-red-950/60 border border-red-900/60 text-red-200 text-xs font-mono text-center">
            {error}
          </div>
        )}
      </div>

      {/* Bottom timeline */}
      {activePath && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 w-[min(900px,94vw)] px-4 py-3 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md">
          <Timeline
            commits={snapshots?.commits ?? []}
            isGit={!!snapshots?.isGit}
            selected={selectedSha}
            onSelect={setSelectedSha}
          />
        </div>
      )}

      {/* Hover tooltip */}
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
            {hover.type === "directory" ? `${hover.name}/` : hover.name}
          </div>
          <div className="text-white/50">
            {formatBytes(hover.size)}
            {hover.itemCount !== undefined && (
              <>
                <span className="mx-1.5">·</span>
                {hover.itemCount} items
              </>
            )}
          </div>
        </div>
      )}

      {/* Empty-state hint */}
      {!activePath && !scanLoading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-white/25 text-xs font-mono tracking-widest">
            paste a folder, observe its universe
          </div>
        </div>
      )}
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
