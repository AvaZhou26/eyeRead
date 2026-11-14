"use client";
// Reading happens in full screen. Eye-tracking calibration maps the eyes to positions on the
// screen, so the reader only follows the eyes correctly in the same full-screen view the
// calibration was made in. Browsers only allow entering full screen from a click, so leaving
// it shows a blocking card with a button to return.
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}
// "supported|active", as a string so the snapshot is stable between calls.
const snapshot = () => `${document.fullscreenEnabled ? 1 : 0}|${document.fullscreenElement ? 1 : 0}`;

/**
 * True when full screen is required but not active. Browsers without the full-screen feature
 * (e.g. iPhone Safari) are never blocked. On the server, assume all is well (no flash).
 */
export function useOutOfFullscreen(): boolean {
  const s = useSyncExternalStore(subscribe, snapshot, () => "1|1");
  return s === "1|0";
}

/** Ask for full screen. Only works from a click; never waits. */
export function enterFullscreen() {
  try {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  } catch {
    /* not supported */
  }
}

/** The blocking card shown while out of full screen during calibration or reading. */
export function FullscreenGate({ reading }: { reading: boolean }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-bg/95 p-6" role="dialog" aria-modal="true" aria-labelledby="fs-title">
      <div className="card max-w-md w-full p-7 text-center">
        <h2 id="fs-title" className="text-xl font-semibold">Reading happens in full screen</h2>
        <p className="text-muted mt-2 leading-relaxed">
          The eye tracker is calibrated to your full screen, so it can only follow your eyes there.
          {reading ? " Your session is paused and nothing is lost." : " Calibration will start again from the first dot."}
        </p>
        <button className="btn btn-primary mt-6 !px-6 !py-2.5" onClick={enterFullscreen} autoFocus>
          Return to full screen
        </button>
      </div>
    </div>
  );
}
