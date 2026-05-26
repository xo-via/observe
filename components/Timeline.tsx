"use client";

import { useMemo, useRef, useState } from "react";

export type Commit = {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  message: string;
};

const LIVE_SHA = "__live__";

export function Timeline({
  commits,
  isGit,
  selected,
  onSelect,
}: {
  commits: Commit[];
  isGit: boolean;
  selected: string | null; // sha or LIVE_SHA
  onSelect: (sha: string | null) => void; // null = live
}) {
  // Oldest on the left, newest on the right
  const items = useMemo<Commit[]>(() => {
    if (!isGit || commits.length === 0) {
      return [
        {
          sha: LIVE_SHA,
          shortSha: "live",
          date: new Date().toISOString(),
          author: "",
          message: "current working tree",
        },
      ];
    }
    return [...commits].reverse();
  }, [commits, isGit]);

  const barRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);

  const selectedIdx = useMemo(() => {
    if (!selected || selected === LIVE_SHA) return items.length - 1;
    const i = items.findIndex((c) => c.sha === selected);
    return i >= 0 ? i : items.length - 1;
  }, [items, selected]);

  function pickAtX(clientX: number): number {
    const el = barRef.current;
    if (!el) return selectedIdx;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (clientX - rect.left) / rect.width),
    );
    return Math.round(ratio * (items.length - 1));
  }

  function selectIdx(idx: number) {
    const c = items[idx];
    if (!c) return;
    if (c.sha === LIVE_SHA) onSelect(null);
    else onSelect(c.sha);
  }

  return (
    <div className="w-full">
      {hover && items[hover.idx] && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full mb-2 px-3 py-2 rounded-md bg-black/85 border border-white/10 text-xs font-mono max-w-md backdrop-blur"
          style={{
            left: hover.x,
            bottom: "100%",
          }}
        >
          <div className="text-white/90 truncate">
            {items[hover.idx].message || "(no message)"}
          </div>
          <div className="text-white/40 mt-0.5">
            {items[hover.idx].shortSha}
            {items[hover.idx].author && (
              <>
                <span className="mx-1.5">·</span>
                {items[hover.idx].author}
              </>
            )}
            {items[hover.idx].date && (
              <>
                <span className="mx-1.5">·</span>
                {formatDate(items[hover.idx].date)}
              </>
            )}
          </div>
        </div>
      )}

      <div
        ref={barRef}
        className="relative h-10 cursor-pointer select-none"
        onMouseMove={(e) => {
          const idx = pickAtX(e.clientX);
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          setHover({ idx, x: e.clientX - rect.left });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => selectIdx(pickAtX(e.clientX))}
      >
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px bg-white/15" />
        {items.map((c, i) => {
          const ratio = items.length === 1 ? 0.5 : i / (items.length - 1);
          const isSel = i === selectedIdx;
          const isHov = hover?.idx === i;
          const size = isSel ? 12 : isHov ? 9 : 5;
          const ringSize = isSel ? 22 : isHov ? 16 : 0;
          return (
            <div
              key={c.sha + i}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${ratio * 100}%` }}
            >
              {ringSize > 0 && (
                <div
                  className="absolute rounded-full border border-white/30"
                  style={{
                    width: ringSize,
                    height: ringSize,
                    left: -ringSize / 2,
                    top: -ringSize / 2,
                  }}
                />
              )}
              <div
                className="rounded-full bg-white"
                style={{
                  width: size,
                  height: size,
                  opacity: isSel ? 1 : 0.7,
                  boxShadow: isSel
                    ? "0 0 12px rgba(255,255,255,0.7)"
                    : "0 0 4px rgba(255,255,255,0.3)",
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex justify-between text-[10px] font-mono text-white/40 tabular-nums">
        <span>{items[0] ? labelOf(items[0]) : ""}</span>
        <span className="text-white/60">
          {items[selectedIdx] ? `${items[selectedIdx].shortSha} ${shortMessage(items[selectedIdx].message)}` : ""}
        </span>
        <span>
          {items[items.length - 1] ? labelOf(items[items.length - 1]) : ""}
        </span>
      </div>
    </div>
  );
}

function labelOf(c: Commit): string {
  if (c.sha === LIVE_SHA) return "live";
  return formatDate(c.date);
}

function shortMessage(msg: string): string {
  if (!msg) return "";
  return msg.length > 60 ? msg.slice(0, 57) + "..." : msg;
}

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "2-digit",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export { LIVE_SHA };
