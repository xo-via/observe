"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type GalaxyNode = {
  path: string;
  name: string;
  depth: number;
  parent: string | null;
  fileCount: number;
  bytes: number;
};

export type GalaxyEdge = { source: string; target: string; weight: number };

export type GalaxyHover = { name: string; path: string; fileCount: number; x: number; y: number } | null;

type Body = {
  path: string;
  name: string;
  depth: number;
  parent: string | null;
  fileCount: number;
  r: number; // core radius
  hue: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  // a few fixed offsets for the file-particles that drift around the core
  motes: { a: number; rad: number; speed: number; size: number }[];
};

// deterministic hash → [0,1)
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// The hue of a galaxy = hue of its project (nearest hyphenated ancestor), so a
// project and its subfolders share a color and read as one region.
function projectKey(path: string, names: Map<string, string>): string {
  let p = path;
  while (p !== "") {
    const n = names.get(p);
    if (n && n.includes("-")) return p;
    p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  }
  return path || "universe";
}

export function Galaxies({
  galaxies,
  edges,
  width,
  height,
  onOpen,
  onHover,
}: {
  galaxies: GalaxyNode[];
  edges: GalaxyEdge[];
  width: number;
  height: number;
  onOpen: (path: string) => void;
  onHover: (info: GalaxyHover) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodiesRef = useRef<Map<string, Body>>(new Map());
  const edgesRef = useRef<GalaxyEdge[]>(edges);
  const dimsRef = useRef({ width, height });
  dimsRef.current = { width, height };
  const camRef = useRef({ x: 0, y: 0, scale: 1 });
  const [hoverable, setHoverable] = useState(false);
  const dragRef = useRef<{ on: boolean; px: number; py: number; moved: boolean }>({
    on: false, px: 0, py: 0, moved: false,
  });

  const namesMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of galaxies) m.set(g.path, g.name);
    return m;
  }, [galaxies]);

  // Build / reconcile bodies from the galaxy list.
  useEffect(() => {
    edgesRef.current = edges;
    const bodies = bodiesRef.current;
    const live = new Set(galaxies.map((g) => g.path));
    const cx = width / 2;
    const cy = height / 2;
    for (const g of galaxies) {
      const r = Math.min(46, 6 + Math.sqrt(g.fileCount) * 3.2);
      const hue = Math.floor(hash01(projectKey(g.path, namesMap)) * 360);
      const existing = bodies.get(g.path);
      if (existing) {
        existing.r = r;
        existing.hue = hue;
        existing.fileCount = g.fileCount;
        continue;
      }
      // seed position on a spread disk, deterministic by path
      const ang = hash01(g.path) * Math.PI * 2;
      const rad = (0.15 + hash01(g.path + "r") * 0.75) * Math.min(width, height) * 0.5;
      const motes = Array.from({ length: Math.min(14, g.fileCount) }, (_, i) => ({
        a: hash01(g.path + "m" + i) * Math.PI * 2,
        rad: r * (0.5 + hash01(g.path + "mr" + i) * 0.9),
        speed: (0.2 + hash01(g.path + "ms" + i) * 0.5) * (i % 2 ? 1 : -1),
        size: 0.8 + hash01(g.path + "msz" + i) * 1.4,
      }));
      bodies.set(g.path, {
        path: g.path, name: g.name, depth: g.depth, parent: g.parent,
        fileCount: g.fileCount, r, hue,
        x: cx + Math.cos(ang) * rad,
        y: cy + Math.sin(ang) * rad,
        vx: 0, vy: 0, motes,
      });
    }
    for (const [p] of bodies) if (!live.has(p)) bodies.delete(p);
  }, [galaxies, edges, width, height, namesMap]);

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

    const step = (dt: number) => {
      const bodies = [...bodiesRef.current.values()];
      const { width: w, height: h } = dimsRef.current;
      const cx = w / 2;
      const cy = h / 2;

      const byPath = bodiesRef.current;

      // repulsion (all pairs) — linear falloff, well-behaved
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d = Math.hypot(dx, dy);
          if (d < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 1; }
          const minD = a.r + b.r + 30;
          // strong short-range push, gentle long-range
          const force = d < minD ? 2600 / d : 1600 / d;
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          a.vx += fx * dt; a.vy += fy * dt;
          b.vx -= fx * dt; b.vy -= fy * dt;
        }
        // gravity to center
        a.vx += (cx - a.x) * 0.5 * dt;
        a.vy += (cy - a.y) * 0.5 * dt;
      }

      // parent springs (containment) — weak Hooke toward the parent folder
      for (const a of bodies) {
        if (!a.parent) continue;
        const p = byPath.get(a.parent);
        if (!p) continue;
        const dx = p.x - a.x, dy = p.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = (d - (a.r + p.r + 40)) * 0.5;
        a.vx += (dx / d) * f * dt; a.vy += (dy / d) * f * dt;
      }

      // link springs (cross-references) — Hooke, stronger with weight
      for (const e of edgesRef.current) {
        const a = byPath.get(e.source);
        const b = byPath.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = (d - (a.r + b.r + 90)) * 0.9 * Math.min(3, 0.6 + e.weight * 0.5);
        const ux = dx / d, uy = dy / d;
        a.vx += ux * f * dt; a.vy += uy * f * dt;
        b.vx -= ux * f * dt; b.vy -= uy * f * dt;
      }

      // integrate, damp, clamp speed (stability)
      for (const a of bodies) {
        a.vx *= 0.9; a.vy *= 0.9;
        const sp = Math.hypot(a.vx, a.vy);
        if (sp > 600) { a.vx = (a.vx / sp) * 600; a.vy = (a.vy / sp) * 600; }
        a.x += a.vx * dt; a.y += a.vy * dt;
      }
    };

    const draw = (now: number) => {
      const { width: w, height: h } = dimsRef.current;
      const cam = camRef.current;
      // backdrop
      const bg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.1, w / 2, h / 2, Math.max(w, h) * 0.8);
      bg.addColorStop(0, "#0a0a18");
      bg.addColorStop(1, "#020208");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const tx = (wx: number) => (wx - cam.x) * cam.scale + w / 2;
      const ty = (wy: number) => (wy - cam.y) * cam.scale + h / 2;
      const byPath = bodiesRef.current;

      // edges
      ctx.lineWidth = 1;
      for (const e of edgesRef.current) {
        const a = byPath.get(e.source);
        const b = byPath.get(e.target);
        if (!a || !b) continue;
        ctx.strokeStyle = `hsla(${a.hue},70%,70%,${Math.min(0.28, 0.07 * e.weight)})`;
        ctx.beginPath();
        ctx.moveTo(tx(a.x), ty(a.y));
        ctx.lineTo(tx(b.x), ty(b.y));
        ctx.stroke();
      }

      // galaxies
      const t = now * 0.001;
      ctx.globalCompositeOperation = "lighter";
      for (const a of byPath.values()) {
        const x = tx(a.x), y = ty(a.y), r = a.r * cam.scale;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
        glow.addColorStop(0, `hsla(${a.hue},80%,72%,0.55)`);
        glow.addColorStop(0.4, `hsla(${a.hue},80%,60%,0.18)`);
        glow.addColorStop(1, `hsla(${a.hue},80%,60%,0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
        ctx.fill();
        // file-particles drifting around the core
        for (const m of a.motes) {
          const ang = m.a + t * m.speed;
          const px = x + Math.cos(ang) * m.rad * cam.scale;
          const py = y + Math.sin(ang) * m.rad * cam.scale;
          ctx.fillStyle = `hsla(${a.hue},60%,88%,0.8)`;
          ctx.beginPath();
          ctx.arc(px, py, m.size, 0, Math.PI * 2);
          ctx.fill();
        }
        // bright core
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.2, r * 0.32), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      // labels (project galaxies, or when zoomed in)
      for (const a of byPath.values()) {
        const showLabel = a.name.includes("-") || cam.scale > 1.6;
        if (!showLabel) continue;
        const x = tx(a.x), y = ty(a.y), r = a.r * cam.scale;
        ctx.globalAlpha = a.name.includes("-") ? 0.82 : 0.5;
        ctx.fillStyle = `hsl(${a.hue},60%,82%)`;
        ctx.font = `${a.name.includes("-") ? 12 : 10}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.fillText(a.name, x, y + r * 2.4 + 12);
        ctx.globalAlpha = 1;
      }
      ctx.textAlign = "left";
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      step(dt);
      draw(now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  // --- interaction: pan (drag), zoom (wheel), hover, click-to-open ---
  function toWorld(mx: number, my: number) {
    const cam = camRef.current;
    const { width: w, height: h } = dimsRef.current;
    return { x: (mx - w / 2) / cam.scale + cam.x, y: (my - h / 2) / cam.scale + cam.y };
  }
  function pick(mx: number, my: number): Body | null {
    const wld = toWorld(mx, my);
    let best: Body | null = null;
    let bestD = Infinity;
    for (const b of bodiesRef.current.values()) {
      const d = (b.x - wld.x) ** 2 + (b.y - wld.y) ** 2;
      const rr = Math.max(b.r + 6, 12);
      if (d < rr * rr && d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  return (
    <div
      style={{ position: "relative", width, height, cursor: dragRef.current.on ? "grabbing" : hoverable ? "pointer" : "grab" }}
      onMouseDown={(e) => {
        dragRef.current = { on: true, px: e.clientX, py: e.clientY, moved: false };
      }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const drag = dragRef.current;
        if (drag.on) {
          const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
          if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
          camRef.current.x -= dx / camRef.current.scale;
          camRef.current.y -= dy / camRef.current.scale;
          drag.px = e.clientX; drag.py = e.clientY;
          onHover(null);
          return;
        }
        const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
        setHoverable(!!hit);
        onHover(hit ? { name: hit.name, path: hit.path, fileCount: hit.fileCount, x: e.clientX, y: e.clientY } : null);
      }}
      onMouseUp={() => { dragRef.current.on = false; }}
      onMouseLeave={() => { dragRef.current.on = false; setHoverable(false); onHover(null); }}
      onClick={(e) => {
        if (dragRef.current.moved) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
        if (hit) onOpen(hit.path);
      }}
      onWheel={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const before = toWorld(mx, my);
        const cam = camRef.current;
        cam.scale = Math.max(0.25, Math.min(6, cam.scale * (e.deltaY < 0 ? 1.12 : 0.89)));
        const after = toWorld(mx, my);
        cam.x += before.x - after.x;
        cam.y += before.y - after.y;
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
