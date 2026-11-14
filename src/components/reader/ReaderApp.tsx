"use client";
// Orchestrates a reading session: camera setup → calibration → reading → saving the report.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FaceTracker } from "@/lib/gaze/faceTracker";
import type { TrackingMode } from "@/lib/gaze/readingTracker";
import type { SessionReport } from "@/lib/types";
import { Calibration, type CalibrationResult } from "./Calibration";
import { ReaderView, lineHeightFor, loadPrefs, type ReaderPrefs } from "./ReaderView";
import { Setup, type CameraState } from "./Setup";

type Phase = "setup" | "calibrate" | "reading" | "saving";

export function ReaderApp({
  readingId,
  title,
  paragraphs,
  backHref,
}: {
  readingId: string;
  title: string;
  paragraphs: string[];
  backHref: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("setup");
  const [cameraState, setCameraState] = useState<CameraState>("off");
  const [mode, setMode] = useState<TrackingMode>("gaze");
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const [prefs, setPrefs] = useState<ReaderPrefs | null>(null);
  const [saveError, setSaveError] = useState("");
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [tracker] = useState(() => new FaceTracker());
  const startedAt = useRef(new Date().toISOString());
  const pendingReport = useRef<SessionReport | null>(null);

  useEffect(() => () => tracker.stop(), [tracker]);

  async function startCamera() {
    if (!video) return;
    setCameraState("loading");
    try {
      await tracker.start(video);
      setCameraState("on");
    } catch (e) {
      const name = (e as DOMException)?.name;
      console.warn("[camera]", e);
      tracker.stop(); // release anything half-started
      setCameraState(
        name === "NotAllowedError" || name === "SecurityError"
          ? "denied"
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "missing"
            : name === "NotReadableError" || name === "AbortError"
              ? "busy"
              : "error",
      );
    }
  }

  // Full screen keeps the page from moving under your eyes. It's optional, so never wait on it.
  function enterFullscreen() {
    try {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    } catch {
      /* not supported */
    }
  }

  function beginReading(m: TrackingMode, c: CalibrationResult | null) {
    setMode(m);
    setCalibration(c);
    startedAt.current = new Date().toISOString();
    setPhase("reading");
  }

  async function save(report: SessionReport) {
    pendingReport.current = report;
    setPhase("saving");
    setSaveError("");
    tracker.stop();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readingId, startedAt: startedAt.current, endedAt: new Date().toISOString(), report }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      router.push(`/reports/${data.id}`);
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  const lineH = prefs ? lineHeightFor(prefs) : 40;

  return (
    <>
      {/* The camera feed lives here for the whole session (hidden; the tracker reads it). */}
      {/* aria-hidden: an empty <video> otherwise announces "Unable to play media" to screen readers. */}
      <video
        ref={setVideo}
        aria-hidden="true"
        tabIndex={-1}
        className="fixed bottom-0 right-0 pointer-events-none"
        style={{ width: 160, height: 120, opacity: 0 }}
        muted
        playsInline
        disablePictureInPicture
      />

      {phase === "setup" && (
        <Setup
          tracker={tracker}
          video={video}
          cameraState={cameraState}
          onStartCamera={startCamera}
          onCalibrate={() => {
            setPrefs(loadPrefs());
            enterFullscreen();
            setPhase("calibrate");
          }}
          onSkipTracking={(m) => {
            setPrefs(loadPrefs());
            enterFullscreen();
            beginReading(m, null);
          }}
          title={title}
          backHref={backHref}
        />
      )}

      {phase === "calibrate" && (
        <Calibration
          tracker={tracker}
          lineHeight={lineH}
          onCancel={() => setPhase("setup")}
          onAttentionOnly={() => beginReading("attention", null)}
          onDone={(r) => beginReading("gaze", r)}
        />
      )}

      {phase === "reading" && prefs && (
        <ReaderView
          title={title}
          paragraphs={paragraphs}
          tracker={mode === "none" ? null : tracker}
          mode={mode}
          calibration={calibration}
          initialPrefs={prefs}
          onFinish={save}
        />
      )}

      {phase === "saving" && (
        <div className="fixed inset-0 flex items-center justify-center bg-bg">
          <div className="text-center max-w-sm px-6">
            {saveError ? (
              <>
                <p className="font-medium">Couldn&apos;t save your session</p>
                <p className="text-sm text-muted mt-1">{saveError}</p>
                <button className="btn btn-primary mt-5" onClick={() => pendingReport.current && save(pendingReport.current)}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <div className="mx-auto h-8 w-8 rounded-full border-2 border-border border-t-accent animate-spin" />
                <p className="font-medium mt-5">Building your report…</p>
                <p className="text-sm text-muted mt-1">Summarizing anything you skipped. This takes a few seconds.</p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
