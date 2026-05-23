"use client";
import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 3000;

interface DocStamp {
  path: string;
  updated_at: string;
}

/**
 * Fires `onChanged` whenever the vault namespace has at least one doc
 * whose `updated_at` differs from the last poll. The hook tracks the
 * per-path stamp map between polls; an empty diff is a no-op (no
 * `onChanged()` call, no refetch), which collapses the common "poll
 * confirms nothing moved" case to zero UI work.
 *
 * In local dev the `/api/changes` SSE delivers fs-watch events instantly
 * AND we still poll — the SSE fires `onChanged` unconditionally because
 * we don't track per-path stamps there; the polling path takes over in
 * cloud where SSE is a no-op.
 *
 * SPRINT-024 Phase 4: previously this hook fired on EVERY broadcast
 * (single namespace-wide max(updated_at) changed). The per-doc map gives
 * us idempotency at the boundary the consumer cares about.
 */
export function useDocsChanged(namespace: string, onChanged: () => void) {
  const ref = useRef(onChanged);
  ref.current = onChanged;

  useEffect(() => {
    const es = new EventSource("/api/changes");
    es.onmessage = () => ref.current();

    // Map<path, updated_at>. null means "first poll hasn't completed"
    // — don't fire spuriously on mount.
    let stamps: Map<string, string> | null = null;
    let cancelled = false;
    let timer: number | null = null;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/changes-version?ns=${encodeURIComponent(namespace)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const { docs } = (await res.json()) as { version: string | null; docs: DocStamp[] };
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const d of docs) next.set(d.path, d.updated_at);

        if (stamps !== null) {
          let changed = false;
          if (next.size !== stamps.size) {
            changed = true;
          } else {
            for (const [p, ts] of next) {
              if (stamps.get(p) !== ts) { changed = true; break; }
            }
          }
          if (changed) ref.current();
        }
        stamps = next;
      } catch {
        // network blip — try again next tick
      } finally {
        if (!cancelled && document.visibilityState === "visible") {
          timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    };

    const start = () => {
      if (timer != null) return;
      poll();
    };
    const stop = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      cancelled = true;
      es.close();
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [namespace]);
}
