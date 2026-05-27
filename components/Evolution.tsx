"use client";

import { useMemo, useRef } from "react";

export type EvolutionCommit = {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  message: string;
  total: number;
  counts: Record<string, number>;
};

export type EvolutionHover = {
  x: number;
  y: number;
  lane: string;
  count: number;
  commit: EvolutionCommit;
} | null;

// Deterministic hash → [0,1). Same trick as Galaxies.tsx so colors are stable.
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function laneColor(name: string, alpha = 0.85): string {
  if (name === "(root)") return `hsla(0, 0%, 70%, ${alpha})`;
  const hue = Math.floor(hash01(name) * 360);
  return `hsla(${hue}, 70%, 62%, ${alpha})`;
}

// Centripetal Catmull–Rom → cubic Bezier path. Produces the river-smooth curves
// you expect from a streamgraph without dragging in d3-shape.
function smoothPath(points: [number, number][]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`;
  const out: string[] = [`M ${points[0][0]} ${points[0][1]}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    out.push(`C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`);
  }
  return out.join(" ");
}

export function Evolution({
  commits,
  lanes,
  width,
  height,
  selectedSha,
  traceSHAs,
  onHover,
  onPickCommit,
}: {
  commits: EvolutionCommit[];
  lanes: string[];
  width: number;
  height: number;
  selectedSha: string | null;
  traceSHAs: string[];
  onHover: (info: EvolutionHover) => void;
  onPickCommit?: (commit: EvolutionCommit) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  // Layout. The stream lives inside a padded box so the time axis sits beneath
  // it without overlapping. Vertical center is the silhouette baseline.
  const padding = { top: 56, right: 36, bottom: 88, left: 36 };
  const w = Math.max(320, width);
  const h = Math.max(320, height);
  const innerW = Math.max(40, w - padding.left - padding.right);
  const innerH = Math.max(40, h - padding.top - padding.bottom);
  const midY = padding.top + innerH / 2;

  const { paths, peakTotal, xOf } = useMemo(() => {
    const n = commits.length;
    if (n === 0) {
      return { paths: [] as { lane: string; d: string; fill: string }[], peakTotal: 0, xOf: () => 0 };
    }
    const xStep = n === 1 ? 0 : innerW / (n - 1);
    const xOf = (i: number) => padding.left + i * xStep;

    let peak = 0;
    for (const c of commits) if (c.total > peak) peak = c.total;
    const scale = peak === 0 ? 0 : (innerH * 0.92) / peak;

    // Stacking: for each commit compute each lane's [yLow, yHigh] around midY,
    // with the cumulative half-height growing as we add lanes. Lane order is
    // fixed by `lanes` so streams keep their identity across commits.
    const yLow: Record<string, number[]> = {};
    const yHigh: Record<string, number[]> = {};
    for (const lane of lanes) {
      yLow[lane] = new Array(n);
      yHigh[lane] = new Array(n);
    }
    for (let i = 0; i < n; i++) {
      const c = commits[i];
      const halfTotal = (c.total * scale) / 2;
      let cursor = -halfTotal;
      for (const lane of lanes) {
        const v = c.counts[lane] ?? 0;
        const lo = cursor;
        const hi = cursor + v * scale;
        yLow[lane][i] = midY + lo;
        yHigh[lane][i] = midY + hi;
        cursor = hi;
      }
    }

    const paths = lanes.map((lane) => {
      const top: [number, number][] = [];
      const bot: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const x = xOf(i);
        top.push([x, yLow[lane][i]]);
        bot.push([x, yHigh[lane][i]]);
      }
      // Walk forward along the top edge, then back along the bottom for closure.
      const fwd = smoothPath(top);
      const back = smoothPath([...bot].reverse());
      const startBack = bot[bot.length - 1];
      const d = `${fwd} L ${startBack[0]} ${startBack[1]} ${back.replace(/^M /, "L ")} Z`;
      return { lane, d, fill: laneColor(lane) };
    });

    return { paths, peakTotal: peak, xOf };
  }, [commits, lanes, innerW, innerH, padding.left, midY]);

  // Pointer → commit index. The streamgraph is uniformly spaced, so this is a
  // simple inverse of xOf. Lane lookup uses the y position of the segment.
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const el = wrapRef.current;
    if (!el || commits.length === 0) {
      onHover(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const n = commits.length;
    const xStep = n === 1 ? 0 : innerW / (n - 1);
    const raw = (x - padding.left) / Math.max(xStep, 0.0001);
    const i = Math.max(0, Math.min(n - 1, Math.round(raw)));
    const c = commits[i];
    if (!c) return;
    // Find which lane the cursor sits on by re-stacking just this column.
    const scale = peakTotal === 0 ? 0 : (innerH * 0.92) / peakTotal;
    const halfTotal = (c.total * scale) / 2;
    let cursor = -halfTotal;
    let hitLane: string | null = null;
    let hitCount = 0;
    for (const lane of lanes) {
      const v = c.counts[lane] ?? 0;
      const lo = midY + cursor;
      const hi = midY + cursor + v * scale;
      if (y >= lo && y <= hi) {
        hitLane = lane;
        hitCount = v;
        break;
      }
      cursor += v * scale;
    }
    if (!hitLane) {
      // Cursor is in the empty space above/below the stream: surface the commit
      // anyway, attached to the biggest lane so the tooltip still makes sense.
      const sorted = Object.entries(c.counts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) {
        hitLane = sorted[0][0];
        hitCount = sorted[0][1];
      }
    }
    if (hitLane) {
      onHover({
        x: e.clientX,
        y: e.clientY,
        lane: hitLane,
        count: hitCount,
        commit: c,
      });
    }
  };

  const onLeave = () => onHover(null);

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (commits.length === 0) return;
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const xStep = commits.length === 1 ? 0 : innerW / (commits.length - 1);
    const raw = (x - padding.left) / Math.max(xStep, 0.0001);
    const i = Math.max(0, Math.min(commits.length - 1, Math.round(raw)));
    const c = commits[i];
    if (!c) return;
    onPickCommit?.(c);
  };

  // Tick marks along the bottom. We don't draw every commit; we draw roughly 8
  // human-readable date labels so the eye has anchors without crowding.
  const dateTicks = useMemo(() => {
    if (commits.length === 0) return [];
    const target = 8;
    const step = Math.max(1, Math.floor(commits.length / target));
    const out: { i: number; label: string }[] = [];
    for (let i = 0; i < commits.length; i += step) {
      out.push({ i, label: formatDate(commits[i].date) });
    }
    const last = commits.length - 1;
    if (out[out.length - 1]?.i !== last) {
      out.push({ i: last, label: formatDate(commits[last].date) });
    }
    return out;
  }, [commits]);

  // Indices into `commits` for the highlighted "now" and the trace polyline.
  // The trace can revisit; we keep duplicates and let the line cross itself.
  const selectedIdx = useMemo(() => {
    if (!selectedSha) return -1;
    return commits.findIndex((c) => c.sha === selectedSha);
  }, [selectedSha, commits]);

  const traceIdx = useMemo(() => {
    if (traceSHAs.length === 0) return [] as number[];
    const out: number[] = [];
    for (const sha of traceSHAs) {
      const i = commits.findIndex((c) => c.sha === sha);
      if (i >= 0) out.push(i);
    }
    return out;
  }, [traceSHAs, commits]);

  const tracePath = useMemo(() => {
    if (traceIdx.length === 0) return "";
    return traceIdx
      .map((i, k) => `${k === 0 ? "M" : "L"} ${xOf(i)} ${midY}`)
      .join(" ");
  }, [traceIdx, xOf, midY]);

  // Legend caps the number of named lanes; the tail collapses into "+N more"
  // so a thousand-folder universe doesn't drown the screen in chips.
  const LEGEND_CAP = 12;
  const legendLanes = lanes.slice(0, LEGEND_CAP);
  const legendRest = Math.max(0, lanes.length - LEGEND_CAP);

  return (
    <div ref={wrapRef} className="relative w-full h-full">
      <svg
        width={w}
        height={h}
        className="block"
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        onClick={onClick}
        style={{ cursor: commits.length > 0 ? "crosshair" : "default" }}
      >
        <defs>
          <filter id="evo-soft" x="-2%" y="-10%" width="104%" height="120%">
            <feGaussianBlur stdDeviation="0.6" />
          </filter>
        </defs>

        <line
          x1={padding.left}
          x2={w - padding.right}
          y1={midY}
          y2={midY}
          stroke="rgba(255,255,255,0.05)"
          strokeDasharray="2 6"
        />

        {paths.map((p) => (
          <path
            key={p.lane}
            d={p.d}
            fill={p.fill}
            stroke={laneColor(p.lane, 0.95)}
            strokeWidth={0.6}
            filter="url(#evo-soft)"
            opacity={0.85}
          />
        ))}

        {/* Faded vertical lines for every step of the trace */}
        {traceIdx.map((i, k) => (
          <line
            key={`trace-${k}-${i}`}
            x1={xOf(i)}
            x2={xOf(i)}
            y1={padding.top - 4}
            y2={h - padding.bottom + 4}
            stroke="rgba(255,200,120,0.25)"
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        ))}

        {/* The trace itself: a glowing polyline through the midline at each visit */}
        {tracePath && (
          <>
            <path
              d={tracePath}
              fill="none"
              stroke="rgba(255,200,120,0.35)"
              strokeWidth={5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={tracePath}
              fill="none"
              stroke="rgba(255,220,160,0.95)"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {traceIdx.map((i, k) => (
              <circle
                key={`tdot-${k}-${i}`}
                cx={xOf(i)}
                cy={midY}
                r={k === traceIdx.length - 1 ? 5 : 3}
                fill="rgba(255,220,160,0.95)"
                stroke="rgba(0,0,0,0.6)"
                strokeWidth={1}
              />
            ))}
          </>
        )}

        {/* Selected ("you are here") column: a brighter full-height line */}
        {selectedIdx >= 0 && (
          <line
            x1={xOf(selectedIdx)}
            x2={xOf(selectedIdx)}
            y1={padding.top - 8}
            y2={h - padding.bottom + 8}
            stroke="rgba(255,255,255,0.75)"
            strokeWidth={1.25}
          />
        )}

        {dateTicks.map((t) => (
          <g key={t.i}>
            <line
              x1={xOf(t.i)}
              x2={xOf(t.i)}
              y1={h - padding.bottom + 4}
              y2={h - padding.bottom + 10}
              stroke="rgba(255,255,255,0.25)"
            />
            <text
              x={xOf(t.i)}
              y={h - padding.bottom + 24}
              textAnchor="middle"
              fontSize={10}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
              fill="rgba(255,255,255,0.4)"
            >
              {t.label}
            </text>
          </g>
        ))}

        {commits.length > 0 && (
          <>
            <text
              x={padding.left}
              y={padding.top - 18}
              fontSize={11}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
              fill="rgba(255,255,255,0.55)"
            >
              {commits.length} commits · {peakTotal} files at peak ·{" "}
              {lanes.length} galaxies tracked
            </text>
            <text
              x={w - padding.right}
              y={padding.top - 18}
              textAnchor="end"
              fontSize={10}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
              fill="rgba(255,255,255,0.3)"
            >
              click a tick to mark a moment · hover to inspect
            </text>
          </>
        )}
      </svg>

      {/* Legend pinned to the right side, scrollable if it overflows. Lanes are
          listed in stacking order so the visual top of the stack matches the
          top of the list. */}
      <div className="pointer-events-none absolute right-3 top-14 max-h-[70%] overflow-hidden">
        <div className="flex flex-col gap-1 text-[10px] font-mono">
          {legendLanes.map((lane) => (
            <div
              key={lane}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md bg-black/30 backdrop-blur border border-white/5"
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ background: laneColor(lane, 1) }}
              />
              <span className="text-white/70 truncate max-w-[140px]">
                {lane}
              </span>
            </div>
          ))}
          {legendRest > 0 && (
            <div className="px-1.5 py-0.5 text-white/35">+{legendRest} more</div>
          )}
        </div>
      </div>

      {commits.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-white/25 text-xs font-mono tracking-widest">
            no commits to evolve from
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
