"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { packSiblings, packEnclose } from "d3-hierarchy";

export type Entry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  itemCount?: number;
};

export type ParticleKind = "folder" | "html" | "md" | "other";

export type HoverInfo = {
  name: string;
  path: string;
  kind: ParticleKind;
  size: number;
  itemCount?: number;
  x: number;
  y: number;
  clickable: boolean;
} | null;

export type ClickInfo = {
  name: string;
  path: string;
  kind: "html" | "md";
};

export type FolderOpenInfo = {
  name: string;
  path: string;
};

// An active Claude Code session living in the universe (see /api/sessions).
export type SessionInfo = {
  id: string;
  age: number;
  headless: boolean;
  state: string;
};

// A session as it orbits the folder. Persisted across polls by id so its motion
// is continuous; appears/disappears with the session.
type Orbit = {
  id: string;
  angle: number; // current angular position
  speed: number; // radians/sec (signed → direction)
  ring: number; // extra radius beyond the cluster, to separate concurrent orbits
  headless: boolean;
  alpha: number;
  talpha: number;
  bx: number; // last drawn screen position (for click/hover hit-testing)
  by: number;
};

function humanAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

type Particle = {
  key: string;
  name: string;
  path: string;
  kind: ParticleKind;
  size: number;
  itemCount?: number;
  x: number;
  y: number;
  r: number;
  alpha: number;
  tx: number;
  ty: number;
  tr: number;
  talpha: number;
  phase: number;
  freq: number;
  amp: number;
  color: string;
  clickable: boolean;
};

type Star = {
  x: number;
  y: number;
  r: number;
  alpha: number;
  twinkle: number;
};

const COLORS: Record<ParticleKind, string> = {
  folder: "#a78bfa",
  html: "#fb923c",
  md: "#38bdf8",
  other: "#cbd5e1",
};

// Sessions are minds, not matter — a warm light against the cool particles. A
// headless `claude -p` task glows a cooler cyan; an interactive session, gold.
const SESSION_COLOR = { interactive: "#ffd479", headless: "#7ef9ff" };

// Particle size is ABSOLUTE and proportional to size on disk: a particle's
// AREA is its byte size times AREA_PER_KB (square pixels of area per kilobyte),
// so a 100 KB entry draws with 100× the area of a 1 KB entry. We scale area —
// not radius — because area is what the eye reads as "how big". Tune the scale
// by changing AREA_PER_KB; this is the "x" in "1 KB = x".
const AREA_PER_KB = 64;
const MIN_RADIUS = 2.5; // floor so empty/tiny entries stay visible and clickable

function radiusForSize(bytes: number): number {
  const kb = Math.max(0, bytes) / 1024;
  const area = kb * AREA_PER_KB;
  return Math.max(MIN_RADIUS, Math.sqrt(area / Math.PI));
}

function classify(name: string, type: Entry["type"]): ParticleKind {
  if (type === "directory") return "folder";
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "md";
  return "other";
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

const STYLE: Record<
  ParticleKind,
  { haloMul: number; coreMul: number; alphaMul: number }
> = {
  folder: { haloMul: 3.6, coreMul: 0.2, alphaMul: 0.9 },
  html: { haloMul: 3.2, coreMul: 0.5, alphaMul: 1.0 },
  md: { haloMul: 3.2, coreMul: 0.5, alphaMul: 1.0 },
  other: { haloMul: 3.0, coreMul: 0.45, alphaMul: 0.9 },
};

const ZOOM_SCALE = 8;
const ZOOM_TRIGGER_SCALE = 5.5; // fire onFolderOpen when scale crosses this

export function Universe({
  entries,
  sessions = [],
  width,
  height,
  onHover,
  onSelect,
  onFolderOpen,
}: {
  entries: Entry[];
  sessions?: SessionInfo[];
  width: number;
  height: number;
  onHover: (info: HoverInfo) => void;
  onSelect: (info: ClickInfo) => void;
  onFolderOpen: (info: FolderOpenInfo) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Map<string, Particle>>(new Map());
  const starsRef = useRef<Star[]>([]);
  const dimsRef = useRef({ width, height });
  dimsRef.current = { width, height };
  const [hoverIsClickable, setHoverIsClickable] = useState(false);

  // The folder cluster (world center + radius), updated each layout, so orbits
  // know what to revolve around. Orbits, keyed by session id for continuity.
  const clusterRef = useRef({ cx: width / 2, cy: height / 2, radius: Math.min(width, height) * 0.18 });
  const orbitsRef = useRef<Map<string, Orbit>>(new Map());
  // Latest status per session (for the click-to-show label), and which is selected.
  const sessionInfoRef = useRef<Map<string, SessionInfo>>(new Map());
  const selectedSessionRef = useRef<string | null>(null);

  // Camera: world coords. Default = center of stage at scale 1.
  const cameraRef = useRef({
    x: width / 2,
    y: height / 2,
    scale: 1,
    tx: width / 2,
    ty: height / 2,
    tscale: 1,
  });

  // Zooming-into-folder state
  const zoomingRef = useRef<{
    name: string;
    path: string;
    fired: boolean;
  } | null>(null);

  // Latest callback refs so the animation tick doesn't capture stale closures
  const onFolderOpenRef = useRef(onFolderOpen);
  onFolderOpenRef.current = onFolderOpen;

  // Snap camera target back to center when entries change (new folder loaded)
  const layoutKey = useMemo(
    () =>
      entries.map((e) => `${e.name}:${e.type}:${e.size}`).join("|") +
      `@${width}x${height}`,
    [entries, width, height],
  );

  useEffect(() => {
    const count = Math.max(40, Math.floor((width * height) / 5500));
    const stars: Star[] = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.3 + 0.2,
        alpha: Math.random() * 0.5 + 0.15,
        twinkle: Math.random() * Math.PI * 2,
      });
    }
    starsRef.current = stars;
  }, [width, height]);

  useEffect(() => {
    const particles = particlesRef.current;
    const cam = cameraRef.current;

    if (entries.length === 0) {
      for (const p of particles.values()) p.talpha = 0;
      clusterRef.current = {
        cx: width / 2,
        cy: height / 2,
        radius: Math.min(width, height) * 0.18,
      };
      return;
    }

    // Give every entry an absolute radius from its byte size, then let
    // packSiblings position the circles WITHOUT rescaling them (unlike d3.pack,
    // which normalizes radii to fit a box and so destroys the absolute scale).
    const circles = entries.map((e) => ({
      _e: e,
      r: radiusForSize(e.size),
      x: 0,
      y: 0,
    }));
    packSiblings(circles);
    const enc = circles.length
      ? packEnclose(circles)
      : { x: 0, y: 0, r: 1 };

    const cx = width / 2;
    const cy = height / 2;

    // The scale stays absolute (fit = 1) until the whole cluster would spill out
    // of the viewport; only then do we shrink uniformly, which preserves every
    // size ratio (100 KB is still 100× the area of 1 KB).
    const layoutSize = Math.min(width, height) * 0.92;
    const fit = enc.r * 2 > layoutSize ? layoutSize / (enc.r * 2) : 1;

    // Record what the sessions orbit around: the cluster's center and radius.
    clusterRef.current = { cx, cy, radius: Math.max(40, enc.r * fit) };

    // When new entries arrive, spawn new particles at the current camera
    // position (so they appear "inside" the folder we zoomed into) and
    // animate the camera back out to center.
    const spawnX = cam.x;
    const spawnY = cam.y;

    cam.tx = cx;
    cam.ty = cy;
    cam.tscale = 1;
    zoomingRef.current = null;

    const seen = new Set<string>();
    for (const c of circles) {
      const e = c._e;
      const key = e.name;
      seen.add(key);
      const kind = classify(e.name, e.type);
      const color = COLORS[kind];
      const clickable =
        kind === "html" || kind === "md" || kind === "folder";

      const tx = (c.x - enc.x) * fit + cx;
      const ty = (c.y - enc.y) * fit + cy;
      const tr = Math.max(MIN_RADIUS, c.r * fit);

      let p = particles.get(key);
      if (!p) {
        p = {
          key,
          name: e.name,
          path: e.path,
          kind,
          size: e.size,
          itemCount: e.itemCount,
          x: spawnX + (Math.random() - 0.5) * 30,
          y: spawnY + (Math.random() - 0.5) * 30,
          r: 1,
          alpha: 0,
          tx,
          ty,
          tr,
          talpha: 1,
          phase: Math.random() * Math.PI * 2,
          freq: 0.25 + Math.random() * 0.45,
          amp: 1.6 + Math.random() * 3.4,
          color,
          clickable,
        };
        particles.set(key, p);
      } else {
        p.tx = tx;
        p.ty = ty;
        p.tr = tr;
        p.talpha = 1;
        p.size = e.size;
        p.itemCount = e.itemCount;
        p.color = color;
        p.kind = kind;
        p.clickable = clickable;
        p.path = e.path;
        p.name = e.name;
      }
    }
    for (const [k, p] of particles) {
      if (!seen.has(k)) p.talpha = 0;
    }
  }, [layoutKey, entries, width, height]);

  // Reconcile orbits with the set of active sessions: add new ones (fading in
  // from a spread-out angle), keep existing ones moving, fade out the departed.
  useEffect(() => {
    const orbits = orbitsRef.current;
    const info = sessionInfoRef.current;
    info.clear();
    const live = new Set(sessions.map((s) => s.id));
    sessions.forEach((s, i) => {
      info.set(s.id, s);
      const existing = orbits.get(s.id);
      if (existing) {
        existing.talpha = 1;
        existing.headless = s.headless;
      } else {
        orbits.set(s.id, {
          id: s.id,
          angle: (i / Math.max(1, sessions.length)) * Math.PI * 2 + Math.random() * 0.6,
          // direction & pace vary a little per session so they don't lockstep
          speed: (0.18 + Math.random() * 0.12) * (i % 2 === 0 ? 1 : -1),
          ring: 16 + (i % 3) * 22,
          headless: s.headless,
          alpha: 0,
          talpha: 1,
          bx: 0,
          by: 0,
        });
      }
    });
    for (const [id, o] of orbits) if (!live.has(id)) o.talpha = 0;
    // If the selected session has ended, drop the label.
    if (selectedSessionRef.current && !live.has(selectedSessionRef.current)) {
      selectedSessionRef.current = null;
    }
  }, [sessions]);

  // Reset camera anchor if canvas size changes and nothing else is going on
  useEffect(() => {
    const cam = cameraRef.current;
    if (!zoomingRef.current) {
      cam.tx = width / 2;
      cam.ty = height / 2;
      cam.tscale = 1;
    }
  }, [width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let last = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { width: w, height: h } = dimsRef.current;
      const cam = cameraRef.current;

      // Lerp camera toward target
      const camLerp = 1 - Math.pow(0.002, dt);
      cam.x += (cam.tx - cam.x) * camLerp;
      cam.y += (cam.ty - cam.y) * camLerp;
      cam.scale += (cam.tscale - cam.scale) * camLerp;

      // Check zoom-in completion
      const zooming = zoomingRef.current;
      if (zooming && !zooming.fired && cam.scale > ZOOM_TRIGGER_SCALE) {
        zooming.fired = true;
        const info: FolderOpenInfo = {
          name: zooming.name,
          path: zooming.path,
        };
        // Defer to avoid setState-in-render warnings on parent
        queueMicrotask(() => onFolderOpenRef.current(info));
      }

      // Backdrop
      const bg = ctx.createRadialGradient(
        w / 2,
        h / 2,
        Math.min(w, h) * 0.1,
        w / 2,
        h / 2,
        Math.max(w, h) * 0.75,
      );
      bg.addColorStop(0, "#0a0a18");
      bg.addColorStop(1, "#020208");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Stars (not zoomed; they're "in the sky")
      for (const s of starsRef.current) {
        const a =
          s.alpha * (0.55 + 0.45 * Math.sin(now * 0.0012 + s.twinkle));
        ctx.globalAlpha = a;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Particles (zoomed via camera)
      const t = now * 0.001;
      const toDelete: string[] = [];
      ctx.globalCompositeOperation = "lighter";
      for (const [k, p] of particlesRef.current) {
        const lerp = 1 - Math.pow(0.0008, dt);
        p.x += (p.tx - p.x) * lerp;
        p.y += (p.ty - p.y) * lerp;
        p.r += (p.tr - p.r) * lerp;
        p.alpha += (p.talpha - p.alpha) * lerp;

        if (p.alpha < 0.004 && p.talpha < 0.004) {
          toDelete.push(k);
          continue;
        }

        const dx = Math.sin(t * p.freq + p.phase) * p.amp;
        const dy = Math.cos(t * p.freq * 0.7 + p.phase * 1.3) * p.amp;
        const worldX = p.x + dx;
        const worldY = p.y + dy;

        const drawX = (worldX - cam.x) * cam.scale + w / 2;
        const drawY = (worldY - cam.y) * cam.scale + h / 2;
        const drawR = p.r * cam.scale;

        const style = STYLE[p.kind];
        const rgb = hexToRgb(p.color);
        const haloR = drawR * style.haloMul;
        const a = p.alpha * style.alphaMul;

        const halo = ctx.createRadialGradient(
          drawX,
          drawY,
          0,
          drawX,
          drawY,
          haloR,
        );
        halo.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${0.9 * a})`);
        halo.addColorStop(0.35, `rgba(${rgb.r},${rgb.g},${rgb.b},${0.3 * a})`);
        halo.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(drawX, drawY, haloR, 0, Math.PI * 2);
        ctx.fill();

        const coreR = Math.max(0.6, drawR * style.coreMul);
        ctx.globalAlpha = a;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(drawX, drawY, coreR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // Sessions: minds revolving around the folder.
      const cluster = clusterRef.current;
      const ccx = (cluster.cx - cam.x) * cam.scale + w / 2;
      const ccy = (cluster.cy - cam.y) * cam.scale + h / 2;
      const orbitDelete: string[] = [];
      for (const [id, o] of orbitsRef.current) {
        const oLerp = 1 - Math.pow(0.02, dt);
        o.alpha += (o.talpha - o.alpha) * oLerp;
        o.angle += o.speed * dt;
        if (o.alpha < 0.004 && o.talpha < 0.004) {
          orbitDelete.push(id);
          continue;
        }

        const rgb = hexToRgb(
          o.headless ? SESSION_COLOR.headless : SESSION_COLOR.interactive,
        );
        const orad = (cluster.radius * 1.35 + o.ring) * cam.scale;
        const dir = o.speed >= 0 ? 1 : -1;

        // faint orbit ring — the path it revolves on
        ctx.globalAlpha = 0.05 * o.alpha;
        ctx.strokeStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(ccx, ccy, orad, 0, Math.PI * 2);
        ctx.stroke();

        // comet tail trailing behind the direction of travel
        for (let k = 6; k >= 1; k--) {
          const ang = o.angle - dir * k * 0.09;
          ctx.globalAlpha = Math.max(0, o.alpha * (1 - k / 7) * 0.45);
          ctx.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
          ctx.beginPath();
          ctx.arc(
            ccx + Math.cos(ang) * orad,
            ccy + Math.sin(ang) * orad,
            Math.max(0.5, 3.4 - k * 0.4),
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }

        // the body: glow + bright core
        const bx = ccx + Math.cos(o.angle) * orad;
        const by = ccy + Math.sin(o.angle) * orad;
        o.bx = bx;
        o.by = by;
        if (selectedSessionRef.current === id) {
          ctx.globalAlpha = 0.9 * o.alpha;
          ctx.strokeStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(bx, by, 9, 0, Math.PI * 2);
          ctx.stroke();
        }
        const glow = ctx.createRadialGradient(bx, by, 0, bx, by, 16);
        glow.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${0.9 * o.alpha})`);
        glow.addColorStop(0.4, `rgba(${rgb.r},${rgb.g},${rgb.b},${0.3 * o.alpha})`);
        glow.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(bx, by, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = o.alpha;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(bx, by, 2.4, 0, Math.PI * 2);
        ctx.fill();

        if (o.alpha > 0.5) {
          ctx.globalAlpha = 0.55 * o.alpha;
          ctx.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
          ctx.font = "10px ui-monospace, monospace";
          ctx.fillText(id.slice(-4), bx + 9, by - 7);
        }
        ctx.globalAlpha = 1;
      }
      for (const id of orbitDelete) orbitsRef.current.delete(id);

      ctx.globalCompositeOperation = "source-over";

      // Status label for the clicked session — follows its orbiting body.
      const selId = selectedSessionRef.current;
      if (selId) {
        const o = orbitsRef.current.get(selId);
        const info = sessionInfoRef.current.get(selId);
        if (o && info && o.alpha > 0.2) {
          const rgb = hexToRgb(
            info.headless ? SESSION_COLOR.headless : SESSION_COLOR.interactive,
          );
          const lines = [
            `claude ${info.headless ? "task" : "session"}`,
            `pid ${selId}`,
            `${info.state} · up ${humanAge(info.age)}`,
          ];
          ctx.font = "11px ui-monospace, monospace";
          const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
          const padX = 10, lh = 15;
          const boxW = tw + padX * 2;
          const boxH = lines.length * lh + 11;
          let lx = o.bx + 16;
          let ly = o.by + 16;
          if (lx + boxW > w) lx = o.bx - boxW - 16;
          if (ly + boxH > h) ly = o.by - boxH - 16;

          // connector
          ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.5)`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(o.bx, o.by);
          ctx.lineTo(lx, ly + 10);
          ctx.stroke();
          // panel
          roundRect(ctx, lx, ly, boxW, boxH, 7);
          ctx.fillStyle = "rgba(8,9,16,0.92)";
          ctx.fill();
          ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.55)`;
          ctx.stroke();
          // text
          lines.forEach((l, i) => {
            ctx.fillStyle =
              i === 0
                ? `rgb(${rgb.r},${rgb.g},${rgb.b})`
                : i === 1
                  ? "rgba(255,255,255,0.78)"
                  : "rgba(255,255,255,0.55)";
            ctx.fillText(l, lx + padX, ly + 15 + lh * i);
          });
        }
      }

      for (const k of toDelete) particlesRef.current.delete(k);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  // Convert screen mouse coords to world coords through the current camera
  function toWorld(mx: number, my: number): { x: number; y: number } {
    const cam = cameraRef.current;
    const { width: w, height: h } = dimsRef.current;
    return {
      x: (mx - w / 2) / cam.scale + cam.x,
      y: (my - h / 2) / cam.scale + cam.y,
    };
  }

  function pickAt(
    mx: number,
    my: number,
    clickableOnly: boolean,
  ): Particle | null {
    const world = toWorld(mx, my);
    let best: Particle | null = null;
    let bestD = Infinity;
    for (const p of particlesRef.current.values()) {
      if (clickableOnly && !p.clickable) continue;
      const rr = Math.max(p.r + 3, 6);
      const d = (p.x - world.x) ** 2 + (p.y - world.y) ** 2;
      if (d < rr * rr && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  // Orbiting sessions are hit-tested in screen space (their last drawn position).
  function pickSession(mx: number, my: number): Orbit | null {
    let best: Orbit | null = null;
    let bestD = Infinity;
    for (const o of orbitsRef.current.values()) {
      if (o.alpha < 0.3) continue;
      const d = (o.bx - mx) ** 2 + (o.by - my) ** 2;
      if (d < 16 * 16 && d < bestD) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    if (zoomingRef.current) return; // freeze hover while zooming
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const sess = pickSession(mx, my);
    const hit = pickAt(mx, my, false);
    setHoverIsClickable(!!sess || (!!hit && hit.clickable));
    if (hit && !sess) {
      onHover({
        name: hit.name,
        path: hit.path,
        kind: hit.kind,
        size: hit.size,
        itemCount: hit.itemCount,
        x: e.clientX,
        y: e.clientY,
        clickable: hit.clickable,
      });
    } else {
      onHover(null);
    }
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (zoomingRef.current) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // A session takes priority: clicking one toggles its status label.
    const sess = pickSession(mx, my);
    if (sess) {
      selectedSessionRef.current =
        selectedSessionRef.current === sess.id ? null : sess.id;
      return;
    }
    // Clicking anywhere else dismisses the label.
    selectedSessionRef.current = null;

    const hit = pickAt(mx, my, true);
    if (!hit) return;

    if (hit.kind === "folder") {
      // Begin zoom: set camera target to particle world position at high scale
      const cam = cameraRef.current;
      cam.tx = hit.tx;
      cam.ty = hit.ty;
      cam.tscale = ZOOM_SCALE;
      zoomingRef.current = {
        name: hit.name,
        path: hit.path,
        fired: false,
      };
      setHoverIsClickable(false);
      onHover(null);
      return;
    }

    if (hit.kind === "html" || hit.kind === "md") {
      onSelect({ name: hit.name, path: hit.path, kind: hit.kind });
    }
  }

  return (
    <div
      onMouseMove={handleMove}
      onMouseLeave={() => {
        setHoverIsClickable(false);
        onHover(null);
      }}
      onClick={handleClick}
      style={{
        position: "relative",
        width,
        height,
        cursor: hoverIsClickable ? "pointer" : "default",
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
