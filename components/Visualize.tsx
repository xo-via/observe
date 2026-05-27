"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

export type ReadmePayload = {
  exists: boolean;
  path?: string;
  relPath?: string;
  bytes?: number;
  truncated?: boolean;
  content?: string;
  root?: string;
  error?: string;
};

// The Visualize tab renders the universe's README — its own self-description —
// as a readable artifact. It's a thin shell around `marked` + a generous dark
// stylesheet that matches the rest of the visualizer.
export function Visualize({
  payload,
  loading,
  onReload,
}: {
  payload: ReadmePayload | null;
  loading: boolean;
  onReload: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  // `marked` is synchronous by default but its types allow Promises; the cast
  // keeps the JSX simple. We sanitize the *source* by trusting our own server
  // (which read the file from disk) and turning off any unsafe extensions —
  // the README content is rendered into a sandboxed area within our own UI.
  const html = useMemo(() => {
    if (!payload?.content) return "";
    marked.setOptions({ gfm: true, breaks: false });
    return marked.parse(payload.content, { async: false }) as string;
  }, [payload?.content]);

  // Reset the scroll position when the payload changes so re-renders don't
  // strand the reader half-way down the previous document.
  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [payload?.path]);

  const [copied, setCopied] = useState(false);
  const copyPath = async () => {
    if (!payload?.path) return;
    try {
      await navigator.clipboard.writeText(payload.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; silently ignore */
    }
  };

  if (loading && !payload) {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-white/30 text-xs font-mono tracking-widest">
          reading the universe's README…
        </div>
      </div>
    );
  }

  if (!payload || !payload.exists) {
    return (
      <div className="absolute inset-0 flex items-center justify-center px-6">
        <div className="max-w-md text-center font-mono text-sm text-white/50 space-y-3">
          <div className="text-white/70">no README found</div>
          <div className="text-[11px] text-white/40">
            {payload?.error ??
              "looked at the universe root and a few levels deep."}
          </div>
          <button
            type="button"
            onClick={onReload}
            className="mt-2 px-3 py-1.5 text-xs rounded-full bg-white/10 hover:bg-white/20 text-white/85 border border-white/15 transition"
          >
            ↻ try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <div
        ref={scrollerRef}
        className="flex-1 overflow-auto px-6 pt-24 pb-32 flex justify-center"
      >
        <article
          className="visualize-readme prose-invert max-w-[760px] w-full"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      {/* Footer chip: shows where we read from, byte count, copy-to-clipboard */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-full bg-black/45 border border-white/10 backdrop-blur-md flex items-center gap-2 text-[10px] font-mono text-white/55">
        <span className="text-white/40">README</span>
        <span className="text-white/20">·</span>
        <span className="truncate max-w-[420px]" title={payload.path}>
          /{payload.relPath || ""}
        </span>
        {typeof payload.bytes === "number" && (
          <>
            <span className="text-white/20">·</span>
            <span>{formatBytes(payload.bytes)}</span>
          </>
        )}
        {payload.truncated && (
          <>
            <span className="text-white/20">·</span>
            <span className="text-amber-200/70">truncated</span>
          </>
        )}
        <span className="text-white/20">·</span>
        <button
          type="button"
          onClick={copyPath}
          className="px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/15 text-white/70 transition"
          title="copy absolute path"
        >
          {copied ? "copied" : "copy path"}
        </button>
        <button
          type="button"
          onClick={onReload}
          className="px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/15 text-white/70 transition"
          title="re-read the README from disk"
        >
          ↻
        </button>
      </div>

      {/* Scoped typographic styling. We use a styled <article> instead of
          Tailwind's typography plugin so we don't take a new dependency for a
          single rendered document. */}
      <style jsx>{`
        :global(.visualize-readme) {
          color: rgba(232, 234, 246, 0.92);
          font-family:
            ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
            Roboto, Helvetica, Arial, sans-serif;
          line-height: 1.7;
          font-size: 15px;
        }
        :global(.visualize-readme h1),
        :global(.visualize-readme h2),
        :global(.visualize-readme h3),
        :global(.visualize-readme h4) {
          font-family:
            ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
            Roboto, sans-serif;
          color: #fff;
          line-height: 1.25;
          letter-spacing: -0.01em;
        }
        :global(.visualize-readme h1) {
          font-size: 28px;
          margin: 4px 0 16px;
          font-weight: 700;
        }
        :global(.visualize-readme h2) {
          font-size: 19px;
          margin: 32px 0 10px;
          padding-top: 18px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          font-weight: 650;
          color: #cdd6ff;
        }
        :global(.visualize-readme h3) {
          font-size: 15px;
          margin: 24px 0 8px;
          font-weight: 650;
          color: #aab2e8;
        }
        :global(.visualize-readme p) {
          margin: 10px 0;
          color: rgba(220, 224, 240, 0.85);
        }
        :global(.visualize-readme strong) {
          color: #fff;
          font-weight: 650;
        }
        :global(.visualize-readme em) {
          color: rgba(220, 224, 240, 0.92);
          font-style: italic;
        }
        :global(.visualize-readme a) {
          color: #9db4ff;
          text-decoration: underline;
          text-decoration-color: rgba(157, 180, 255, 0.35);
          text-underline-offset: 2px;
        }
        :global(.visualize-readme a:hover) {
          text-decoration-color: rgba(157, 180, 255, 0.9);
        }
        :global(.visualize-readme ul),
        :global(.visualize-readme ol) {
          margin: 10px 0 10px 22px;
          padding: 0;
        }
        :global(.visualize-readme li) {
          margin: 4px 0;
          color: rgba(220, 224, 240, 0.85);
        }
        :global(.visualize-readme code) {
          font-family:
            ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 13px;
          background: rgba(20, 22, 40, 0.85);
          color: #c5cdf7;
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 4px;
          padding: 1px 6px;
        }
        :global(.visualize-readme pre) {
          background: rgba(10, 12, 24, 0.85);
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 8px;
          padding: 14px 16px;
          overflow-x: auto;
          margin: 14px 0;
        }
        :global(.visualize-readme pre code) {
          background: transparent;
          border: 0;
          padding: 0;
          font-size: 12.5px;
          color: #d8def7;
        }
        :global(.visualize-readme blockquote) {
          border-left: 2px solid rgba(157, 180, 255, 0.4);
          padding: 4px 14px;
          margin: 12px 0;
          color: rgba(205, 214, 255, 0.75);
          background: rgba(157, 180, 255, 0.04);
          border-radius: 0 6px 6px 0;
        }
        :global(.visualize-readme hr) {
          border: 0;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          margin: 28px 0;
        }
        :global(.visualize-readme table) {
          border-collapse: collapse;
          margin: 14px 0;
          font-size: 13px;
          width: 100%;
        }
        :global(.visualize-readme th),
        :global(.visualize-readme td) {
          border: 1px solid rgba(255, 255, 255, 0.08);
          padding: 6px 10px;
          text-align: left;
        }
        :global(.visualize-readme th) {
          background: rgba(255, 255, 255, 0.04);
          color: #fff;
        }
        :global(.visualize-readme img) {
          max-width: 100%;
          border-radius: 8px;
          margin: 12px 0;
        }
      `}</style>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}
