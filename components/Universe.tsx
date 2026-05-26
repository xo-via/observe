"use client";

import { useEffect, useMemo, useRef } from "react";
import { hierarchy, pack as d3pack } from "d3-hierarchy";

export type Entry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  itemCount?: number;
};

export type HoverInfo = {
  name: string;
  type: Entry["type"];
  size: number;
  itemCount?: number;
  x: number;
  y: number;
} | null;

type Particle = {
  key: string;
  name: string;
  type: Entry["type"];
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
};

type Star = {
  x: number;
  y: number;
  r: number;
  alpha: number;
  twinkle: number;
};

const DIR_PALETTE = [
  "#fb923c",
  "#a78bfa",
  "#34d399",
  "#60a5fa",
  "#f87171",
  "#fbbf24",
  "#22d3ee",
  "#e879f9",
];

function colorFor(name: string, type: Entry["type"]): string {
  if (type === "directory") {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return DIR_PALETTE[h % DIR_PALETTE.length];
  }
  if (type === "symlink") return "#64748b";
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (
    [
      "ts","tsx","js","jsx","mjs","cjs","py","rs","go","rb","java","c","cpp","cc",
      "h","hpp","swift","kt","sh","bash","zsh","lua","php","scala","clj","ex","exs",
    ].includes(ext)
  )
    return "#7dd3fc";
  if (["md", "mdx", "txt", "rst", "adoc"].includes(ext)) return "#e2e8f0";
  if (["css", "scss", "sass", "less", "html", "vue", "svelte"].includes(ext))
    return "#c4b5fd";
  if (
    [
      "json","yaml","yml","toml","ini","env","lock","conf","cfg","xml",
    ].includes(ext)
  )
    return "#fbbf24";
  if (
    [
      "png","jpg","jpeg","gif","svg","webp","ico","bmp","mp4","mov","webm","mp3","wav","flac","pdf",
    ].includes(ext)
  )
    return "#f472b6";
  return "#94a3b8";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

export function Universe({
  entries,
  width,
  height,
  onHover,
}: {
  entries: Entry[];
  width: number;
  height: number;
  onHover: (info: HoverInfo) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Map<string, Particle>>(new Map());
  const starsRef = useRef<Star[]>([]);
  const dimsRef = useRef({ width, height });
  dimsRef.current = { width, height };

  // (Re)generate background stars on resize
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

  // Recompute particle targets when entries (or canvas size) change
  const layoutKey = useMemo(
    () =>
      entries.map((e) => `${e.name}:${e.type}:${e.size}`).join("|") +
      `@${width}x${height}`,
    [entries, width, height],
  );

  useEffect(() => {
    const particles = particlesRef.current;

    if (entries.length === 0) {
      for (const p of particles.values()) p.talpha = 0;
      return;
    }

    const root = hierarchy<{
      name: string;
      value?: number;
      _e?: Entry;
      children?: any[];
    }>({
      name: "root",
      children: entries.map((e) => ({
        name: e.name,
        value: Math.max(e.size, 1),
        _e: e,
      })),
    }).sum((d: any) => d.value ?? 0);

    const layoutSize = Math.min(width, height) * 0.86;
    d3pack<any>().size([layoutSize, layoutSize]).padding(6)(root);

    const cx = width / 2;
    const cy = height / 2;
    const off = layoutSize / 2;

    const seen = new Set<string>();
    for (const leaf of root.leaves()) {
      const e = (leaf.data as any)._e as Entry;
      const key = e.name;
      seen.add(key);
      const tx = (leaf as any).x - off + cx;
      const ty = (leaf as any).y - off + cy;
      const tr = Math.max(2.5, (leaf as any).r);
      const color = colorFor(e.name, e.type);

      let p = particles.get(key);
      if (!p) {
        p = {
          key,
          name: e.name,
          type: e.type,
          size: e.size,
          itemCount: e.itemCount,
          x: cx + (Math.random() - 0.5) * 80,
          y: cy + (Math.random() - 0.5) * 80,
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
        p.type = e.type;
      }
    }
    for (const [k, p] of particles) {
      if (!seen.has(k)) p.talpha = 0;
    }
  }, [layoutKey, entries, width, height]);

  // Animation loop
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

      // Stars
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

      // Particles
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
        const drawX = p.x + dx;
        const drawY = p.y + dy;

        const rgb = hexToRgb(p.color);
        const haloR = p.r * 3.4;

        const halo = ctx.createRadialGradient(
          drawX,
          drawY,
          0,
          drawX,
          drawY,
          haloR,
        );
        halo.addColorStop(
          0,
          `rgba(${rgb.r},${rgb.g},${rgb.b},${0.95 * p.alpha})`,
        );
        halo.addColorStop(
          0.35,
          `rgba(${rgb.r},${rgb.g},${rgb.b},${0.35 * p.alpha})`,
        );
        halo.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(drawX, drawY, haloR, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(drawX, drawY, Math.max(0.7, p.r * 0.4), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = "source-over";

      for (const k of toDelete) particlesRef.current.delete(k);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: Particle | null = null;
    let bestD = Infinity;
    for (const p of particlesRef.current.values()) {
      const rr = Math.max(p.r + 3, 6);
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < rr * rr && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (best) {
      onHover({
        name: best.name,
        type: best.type,
        size: best.size,
        itemCount: best.itemCount,
        x: e.clientX,
        y: e.clientY,
      });
    } else {
      onHover(null);
    }
  }

  return (
    <div
      onMouseMove={handleMove}
      onMouseLeave={() => onHover(null)}
      style={{ position: "relative", width, height }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
