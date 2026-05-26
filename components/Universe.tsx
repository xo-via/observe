"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, pack as d3pack } from "d3-hierarchy";

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

// Folders are always bigger than files. Files get a small floor so even
// empty/tiny files are visible. Inside each category there is some variation
// (folders by item count, files by log size) so structure is still readable.
function packValue(e: Entry): number {
  if (e.type === "directory") {
    const items = e.itemCount ?? 1;
    return 420 + Math.min(items, 500) * 2;
  }
  const sizeKb = Math.max(1, e.size / 1024);
  return 28 + Math.log2(sizeKb + 1) * 7;
}

function classify(name: string, type: Entry["type"]): ParticleKind {
  if (type === "directory") return "folder";
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "md";
  return "other";
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
  width,
  height,
  onHover,
  onSelect,
  onFolderOpen,
}: {
  entries: Entry[];
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
        value: packValue(e),
        _e: e,
      })),
    }).sum((d: any) => d.value ?? 0);

    const layoutSize = Math.min(width, height) * 0.86;
    d3pack<any>().size([layoutSize, layoutSize]).padding(6)(root);

    const cx = width / 2;
    const cy = height / 2;
    const off = layoutSize / 2;

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
    for (const leaf of root.leaves()) {
      const e = (leaf.data as any)._e as Entry;
      const key = e.name;
      seen.add(key);
      const kind = classify(e.name, e.type);
      const color = COLORS[kind];
      const clickable =
        kind === "html" || kind === "md" || kind === "folder";

      const tx = (leaf as any).x - off + cx;
      const ty = (leaf as any).y - off + cy;
      const tr = Math.max(2.5, (leaf as any).r);

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
      ctx.globalCompositeOperation = "source-over";

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

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    if (zoomingRef.current) return; // freeze hover while zooming
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = pickAt(mx, my, false);
    setHoverIsClickable(!!hit && hit.clickable);
    if (hit) {
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
