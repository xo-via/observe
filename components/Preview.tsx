"use client";

import { useEffect, useState } from "react";

export type PreviewTarget = {
  name: string;
  path: string;
  kind: "html" | "md";
} | null;

type FileResponse = {
  name: string;
  kind: "html" | "md";
  content: string;
  truncated?: boolean;
  error?: string;
};

const HTML_FRAME_STYLE = `
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; }
</style>
`;

function wrapRawHtml(raw: string): string {
  // If the file already looks like a full document, leave it; otherwise wrap.
  if (/<html[\s>]/i.test(raw)) return raw;
  return `<!doctype html><html><head><meta charset="utf-8">${HTML_FRAME_STYLE}</head><body>${raw}</body></html>`;
}

export function Preview({
  target,
  gitRef,
  onClose,
}: {
  target: PreviewTarget;
  gitRef: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<FileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch("/api/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // path is relative to the root (BIG_BANG); the server resolves it.
      body: JSON.stringify({ path: target.path, ref: gitRef }),
    })
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? "load failed");
        } else {
          setData(json);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message ?? "fetch failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target, gitRef]);

  useEffect(() => {
    if (!target) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  const srcdoc =
    data?.kind === "md"
      ? data.content
      : data?.kind === "html"
        ? wrapRawHtml(data.content)
        : "";

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center p-4 md:p-10"
      onClick={onClose}
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-hidden
      />
      <div
        className="relative w-full max-w-4xl h-full max-h-[88vh] flex flex-col rounded-2xl bg-[#0a0a14] border border-white/10 shadow-[0_30px_120px_-20px_rgba(0,0,0,0.8)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{
                background: target.kind === "html" ? "#fb923c" : "#38bdf8",
                boxShadow: `0 0 10px ${
                  target.kind === "html" ? "#fb923c" : "#38bdf8"
                }`,
              }}
            />
            <span className="text-sm font-mono text-white/90 truncate">
              {target.name}
            </span>
            <span className="text-[10px] font-mono uppercase tracking-wider text-white/40 ml-1">
              {target.kind}
            </span>
            {data?.truncated && (
              <span className="text-[10px] font-mono text-amber-300/80 ml-2">
                (truncated)
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-white/50 hover:text-white text-sm px-2 py-1 rounded-md hover:bg-white/10"
            aria-label="close preview"
          >
            esc
          </button>
        </div>

        <div className="flex-1 min-h-0 relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-xs font-mono text-white/40">
              loading...
            </div>
          )}
          {error && !loading && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="text-xs font-mono text-red-300 max-w-md text-center">
                {error}
              </div>
            </div>
          )}
          {!loading && !error && data && (
            <iframe
              title={target.name}
              sandbox=""
              srcDoc={srcdoc}
              className="w-full h-full bg-[#0a0a14] border-0"
            />
          )}
        </div>
      </div>
    </div>
  );
}
