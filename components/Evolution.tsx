"use client";

import { useEffect, useMemo, useRef } from "react";

export type EvolutionCommit = {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  message: string;
  total: number;
  counts: Record<string, number>;
};

export type EvolutionFile = {
  path: string;
  lane: string;
  bornIdx: number;
  diedIdx: number;
};

export type EvolutionHover = {
  x: number;
  y: number;
  lane: string;
  path: string | null;
  commit: EvolutionCommit;
} | null;

// Deterministic hash → [0,1). Matches Galaxies.tsx so colors are consistent.
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function laneColor(name: string, alpha = 0.9): string {
  if (name === "(root)") return `hsla(0, 0%, 78%, ${alpha})`;
  const hue = Math.floor(hash01(name) * 360);
  return `hsla(${hue}, 70%, 62%, ${alpha})`;
}

// Each galaxy keeps a smoothly-tweened radius so scrubbing through time looks
// like the universe breathing rather than snapping between snapshots.
type GalaxyState = {
  lane: string;
  x: number;
  y: number;
  r: number;
  rTarget: number;
};

type Mote = {
  lane: string;
  path: string;
  bornIdx: number;
  diedIdx: number;
  angle: number;
  orbit: number;
  speed: number;
  size: number;
};

// The universe at one tick: galaxies (top-level folders) as glowing bubbles
// whose radii track file count, with each file represented by a tiny orbiting
// mote. Scrubbing or playing back through commits animates births and deaths.
export function Evolution({
  commits,
  lanes,
  files,
  width,
  height,
  currentSha,
  traceSHAs,
  onHover,
  onPickCommit,
}: {
  commits: EvolutionCommit[];
  lanes: string[];
  files: EvolutionFile[];
  width: number;
  height: number;
  currentSha: string | null;
  traceSHAs: string[];
  onHover: (info: EvolutionHover) => void;
  onPickCommit?: (commit: EvolutionCommit) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const currentIdx = useMemo(() => {
    if (commits.length === 0) return -1;
    if (!currentSha) return commits.length - 1;
    const i = commits.findIndex((c) => c.sha === currentSha);
    return i >= 0 ? i : commits.length - 1;
  }, [currentSha, commits]);

  // Lane positions are a polar ring around center; bigger lanes (more lifetime
  // touches) sit closer to the top so the "main story" is easy to spot.
  const galaxyHome = useMemo(() => {
    const cx = width / 2;
    const cy = height / 2;
    const ring = Math.min(width, height) * 0.32;
    const N = lanes.length;
    const map = new Map<string, { x: number; y: number }>();
    if (N === 0) return map;
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
      map.set(lanes[i], {
        x: cx + Math.cos(angle) * ring,
        y: cy + Math.sin(angle) * ring,
      });
    }
    return map;
  }, [lanes, width, height]);

  // The peak count of any single lane across all of history determines the
  // radius scale. Locking it once means a small galaxy at the early universe
  // really does look small next to its eventual size.
  const radiusScale = useMemo(() => {
    let peak = 1;
    for (const c of commits) {
      for (const lane of lanes) {
        const v = c.counts[lane] ?? 0;
        if (v > peak) peak = v;
      }
    }
    const maxR = Math.min(width, height) * 0.12;
    return maxR / Math.sqrt(peak);
  }, [commits, lanes, width, height]);

  // Each file gets a stable orbit slot derived from its path. The slot is the
  // same forever, so a file that disappears and is reborn snaps back into the
  // exact same place — making lifelines visually recognizable.
  const motes = useMemo<Mote[]>(() => {
    return files.map((f) => {
      const a = hash01(f.path);
      const b = hash01(f.path + "#orbit");
      const c = hash01(f.path + "#speed");
      const d = hash01(f.path + "#size");
      return {
        lane: f.lane,
        path: f.path,
        bornIdx: f.bornIdx,
        diedIdx: f.diedIdx,
        angle: a * Math.PI * 2,
        orbit: 22 + b * 36,
        speed: (0.00035 + c * 0.0009) * (d > 0.5 ? 1 : -1),
        size: 1.6 + a * 1.4,
      };
    });
  }, [files]);

  // Live state held in a ref so requestAnimationFrame can mutate it without
  // triggering React renders. The galaxy radii tween toward their target each
  // frame, giving the "growing" feel as you walk through commits.
  const statesRef = useRef<Map<string, GalaxyState>>(new Map());
  const targetIdxRef = useRef<number>(currentIdx);

  useEffect(() => {
    const m = new Map<string, GalaxyState>();
    for (const lane of lanes) {
      const home = galaxyHome.get(lane) ?? { x: width / 2, y: height / 2 };
      const prev = statesRef.current.get(lane);
      m.set(lane, {
        lane,
        x: home.x,
        y: home.y,
        r: prev?.r ?? 0,
        rTarget: prev?.rTarget ?? 0,
      });
    }
    statesRef.current = m;
  }, [lanes, galaxyHome, width, height]);

  useEffect(() => {
    targetIdxRef.current = currentIdx;
    const c = commits[currentIdx];
    if (!c) return;
    for (const lane of lanes) {
      const st = statesRef.current.get(lane);
      if (!st) continue;
      const count = c.counts[lane] ?? 0;
      st.rTarget = radiusScale * Math.sqrt(count);
    }
  }, [currentIdx, commits, lanes, radiusScale]);

  // The animation loop. One pass: lerp radii, then draw galaxies, then draw
  // motes for files alive at the current tick. The mote draw uses time-driven
  // rotation so even paused universes feel alive.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let last = performance.now();
    const draw = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;

      ctx.clearRect(0, 0, width, height);

      // Background: a faint radial fade so the centered universe reads as a
      // contained world rather than scattered particles.
      const cx = width / 2;
      const cy = height / 2;
      const bgR = Math.max(width, height) * 0.6;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, bgR);
      grad.addColorStop(0, "rgba(60,80,160,0.05)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // Tween radii. The closer they are to their target, the slower they
      // converge — gives bigger jumps when scrubbing across long gaps.
      const lerp = 1 - Math.pow(0.0001, dt);
      for (const st of statesRef.current.values()) {
        st.r += (st.rTarget - st.r) * lerp;
      }

      const idx = targetIdxRef.current;
      const tipIdx = commits.length - 1;

      // Galaxy bodies first: bloomed halo, then crisp core, then name label.
      for (const [lane, st] of statesRef.current) {
        if (st.r < 0.5) continue;
        const color = laneColor(lane, 0.95);
        const halo = ctx.createRadialGradient(st.x, st.y, 0, st.x, st.y, st.r * 2.6);
        halo.addColorStop(0, laneColor(lane, 0.55));
        halo.addColorStop(0.5, laneColor(lane, 0.12));
        halo.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r * 2.6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.font =
          "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        ctx.textAlign = "center";
        const label = lane === "(root)" ? "root" : lane;
        ctx.fillText(label, st.x, st.y + st.r + 16);

        const count = commits[idx]?.counts[lane] ?? 0;
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.font =
          "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        ctx.fillText(`${count}`, st.x, st.y + st.r + 30);
      }

      // Motes: only draw files alive at the current commit. Each rotates at
      // its own speed around its lane's center.
      ctx.globalCompositeOperation = "lighter";
      for (const m of motes) {
        if (idx < m.bornIdx || idx > m.diedIdx) continue;
        const st = statesRef.current.get(m.lane);
        if (!st) continue;
        const ang = m.angle + t * m.speed;
        const rOrbit = st.r + m.orbit;
        const px = st.x + Math.cos(ang) * rOrbit;
        const py = st.y + Math.sin(ang) * rOrbit;
        ctx.fillStyle = laneColor(m.lane, 0.85);
        ctx.beginPath();
        ctx.arc(px, py, m.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      // Center hud: current tick + commit message. Kept inside canvas so it
      // travels through devicePixelRatio scaling cleanly.
      const c = commits[idx];
      if (c) {
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.font =
          "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        const tick = c.message.match(/^t=(\d+)/);
        const tickLabel = tick ? `t=${tick[1]}` : c.shortSha;
        ctx.fillText(`${tickLabel}  ·  ${c.total} files`, cx, height - 90);
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font =
          "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        const msg = (c.message || "").replace(/^t=\d+[:\s]*/, "");
        ctx.fillText(truncate(msg, 80), cx, height - 74);
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillText(
          `${idx + 1} / ${commits.length}  ·  ${formatDate(c.date)}${idx === tipIdx ? "  ·  present" : ""}`,
          cx,
          height - 58,
        );
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [width, height, commits, motes]);

  // Hover detection runs in DOM space (no canvas readback) by computing the
  // nearest galaxy in current state. Motes are too small to hover reliably,
  // so we surface them only when the cursor lands inside a galaxy halo.
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el || commits.length === 0) {
      onHover(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const idx = targetIdxRef.current;
    const c = commits[idx];
    if (!c) return;
    let best: { lane: string; d: number; r: number } | null = null;
    for (const [lane, st] of statesRef.current) {
      const dx = x - st.x;
      const dy = y - st.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const hit = st.r + 48;
      if (d <= hit && (!best || d < best.d)) {
        best = { lane, d, r: st.r };
      }
    }
    onHover({
      x: e.clientX,
      y: e.clientY,
      lane: best?.lane ?? "(root)",
      path: null,
      commit: c,
    });
  };

  const onLeave = () => onHover(null);

  // Clicking the canvas marks "this moment" — pushes the current commit onto
  // the trace. The Timeline below is the primary scrub control; canvas-click
  // is the fast way to bookmark the moment you're staring at.
  const onClick = () => {
    if (commits.length === 0) return;
    const c = commits[targetIdxRef.current];
    if (c) onPickCommit?.(c);
  };

  // Trace overlay along the bottom: small ghost dots, one per visited commit,
  // so the trace stays visible even while we're showing a galaxy view above.
  const traceMarkers = useMemo(() => {
    if (commits.length === 0) return [] as { i: number; isLast: boolean }[];
    const order: number[] = [];
    for (const sha of traceSHAs) {
      const i = commits.findIndex((c) => c.sha === sha);
      if (i >= 0) order.push(i);
    }
    return order.map((i, k) => ({ i, isLast: k === order.length - 1 }));
  }, [traceSHAs, commits]);

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onClick={onClick}
      style={{ cursor: commits.length > 0 ? "crosshair" : "default" }}
    >
      <canvas ref={canvasRef} className="block absolute inset-0" />

      {/* Trace ribbon: ghost dots representing the visited commits along the
          time axis. Sits above the timeline panel so the two read as one. */}
      {traceMarkers.length > 0 && commits.length > 1 && (
        <svg
          width={width}
          height={20}
          className="absolute left-0 right-0 pointer-events-none"
          style={{ bottom: 0 }}
        >
          {traceMarkers.map((m, k) => {
            const x = (m.i / (commits.length - 1)) * width;
            return (
              <circle
                key={`${k}-${m.i}`}
                cx={x}
                cy={10}
                r={m.isLast ? 4 : 2.5}
                fill="rgba(255,220,160,0.95)"
                stroke="rgba(0,0,0,0.5)"
                strokeWidth={0.5}
              />
            );
          })}
        </svg>
      )}

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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
