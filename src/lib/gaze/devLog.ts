// Development only: batches diagnostic rows and posts them to /api/dev/gaze-log every 2 s,
// which appends them to data/gaze-debug.jsonl, so real sessions can be diagnosed afterwards.
// Numbers only (eye/head features, gaze points, line positions): no video, no text.
// Does nothing in production builds.

export interface DevGazeLog {
  page: number;
  push(row: unknown): void;
  flush(): void;
}

let shared: { log: DevGazeLog; users: number } | null = null;

/** Start (or join) the shared logger. Call the returned function to leave it. */
export function joinDevGazeLog(): { log: DevGazeLog | null; leave: () => void } {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return { log: null, leave: () => {} };
  if (!shared) {
    let buf: unknown[] = [];
    const send = () => {
      if (!buf.length) return;
      const body = JSON.stringify(buf);
      buf = [];
      void fetch("/api/dev/gaze-log", { method: "POST", body, keepalive: body.length < 60_000 }).catch(() => {});
    };
    const id = setInterval(send, 2000);
    const log: DevGazeLog = {
      page: -1,
      push: (row) => buf.push(row),
      flush: () => {
        send();
        clearInterval(id);
      },
    };
    shared = { log, users: 0 };
  }
  const s = shared;
  s.users++;
  return {
    log: s.log,
    leave: () => {
      if (--s.users > 0) return;
      s.log.flush();
      if (shared === s) shared = null;
    },
  };
}

/** Round each feature for the log (they're small numbers; 4 decimals is plenty). */
export const roundFeatures = (f: number[] | null) => (f ? f.map((v) => Math.round(v * 1e4) / 1e4) : null);
