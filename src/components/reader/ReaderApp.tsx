"use client";
// Orchestrates a reading session: camera setup → calibration → reading → saving the report.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FaceTracker } from "@/lib/gaze/faceTracker";
import { gazeEngine, WebEyeTrackSource } from "@/lib/gaze/webEyeTrackSource";
import type { TrackingMode } from "@/lib/gaze/readingTracker";
import type { ResumeState, SessionReport } from "@/lib/types";
import { Calibration, type CalibrationResult } from "./Calibration";
import { applyReadingCalibration, ReadingCalibration } from "./ReadingCalibration";
import { ReaderView, lineHeightFor, loadPrefs, type ReaderPrefs } from "./ReaderView";
import { Setup, type CameraState } from "./Setup";

// calibrate = the dots; readcal = calibrate by reading (vertical fit + personal reading pace)
type Phase = "setup" | "calibrate" | "readcal" | "reading" | "saving";

export function ReaderApp({
  readingId,
  title,
  paragraphs,
  backHref,
  resume,
}: {
  readingId: string;
  title: string;
  paragraphs: string[];
  backHref: string;
  /** A paused session to continue, if the student has one for this reading. */
  resume: { sessionId: string; state: ResumeState } | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("setup");
  const [cameraState, setCameraState] = useState<CameraState>("off");
  const [mode, setMode] = useState<TrackingMode>("gaze");
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  /** Dot calibration result, waiting for the reading step to refine it. */
  const [dotCalibration, setDotCalibration] = useState<CalibrationResult | null>(null);
  const [prefs, setPrefs] = useState<ReaderPrefs | null>(null);
  const [saveError, setSaveError] = useState("");
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [tracker] = useState(() => new FaceTracker());
  // WebEyeTrack (default engine) rides on the FaceTracker's frames; null = MediaPipe + ridge.
  const [wet, setWet] = useState<WebEyeTrackSource | null>(null);
  const wetLoad = useRef<Promise<WebEyeTrackSource | null> | null>(null);
  const startedAt = useRef(new Date().toISOString());
  const pendingSave = useRef<{ report: SessionReport; state: ResumeState | null } | null>(null);
  const [pausing, setPausing] = useState(false);

  useEffect(() => () => tracker.stop(), [tracker]);
  useEffect(() => () => wet?.dispose(), [wet]); // stops its worker

  /** Load WebEyeTrack once. If it fails, fall back to the MediaPipe + ridge pipeline. */
  function loadWet(): Promise<WebEyeTrackSource | null> {
    if (gazeEngine() !== "webeyetrack") return Promise.resolve(null);
    wetLoad.current ??= WebEyeTrackSource.create().catch((e) => {
      console.warn("[webeyetrack] unavailable, using MediaPipe + ridge", e);
      return null;
    });
    return wetLoad.current;
  }

  async function startCamera() {
    if (!video) return;
    setCameraState("loading");
    try {
      const [, w] = await Promise.all([tracker.start(video), loadWet()]);
      if (w) w.attach(tracker);
      setWet(w);
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

  // Finishing (state = null) builds the report; pausing (state given) saves progress to resume later.
  async function save(report: SessionReport, state: ResumeState | null) {
    pendingSave.current = { report, state };
    setPausing(!!state);
    setPhase("saving");
    setSaveError("");
    wet?.detach();
    tracker.stop();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          readingId,
          sessionId: resume?.sessionId ?? null,
          startedAt: startedAt.current,
          endedAt: new Date().toISOString(),
          status: state ? "paused" : "done",
          report,
          resume: state,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      router.push(state ? `${backHref}?paused=1` : `/reports/${data.id}`);
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  const lineH = prefs ? lineHeightFor(prefs) : 50;

  return (
    <>
      {/* The camera feed lives here for the whole session (hidden; the tracker reads it). */}
      {/* aria-hidden: an empty <video> otherwise announces "Unable to play media" to screen readers. */}
      {/* suppressHydrationWarning: video extensions (speed controllers, PiP tools) tag every
          <video> with attributes like data-video="0" before React hydrates. Attributes only. */}
      <video
        suppressHydrationWarning
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
          resuming={!!resume}
        />
      )}

      {phase === "calibrate" && (
        <Calibration
          tracker={tracker}
          wet={wet}
          lineHeight={lineH}
          onCancel={() => setPhase("setup")}
          onAttentionOnly={() => beginReading("attention", null)}
          onDone={(r) => {
            setDotCalibration(r);
            setPhase("readcal");
          }}
        />
      )}

      {phase === "readcal" && dotCalibration && prefs && (
        <ReadingCalibration
          tracker={tracker}
          calibration={dotCalibration}
          prefs={prefs}
          onDone={(o) => beginReading("gaze", applyReadingCalibration(dotCalibration, o))}
          onSkip={() => beginReading("gaze", dotCalibration)}
        />
      )}

      {phase === "reading" && prefs && (
        <ReaderView
          title={title}
          paragraphs={paragraphs}
          tracker={mode === "none" ? null : tracker}
          wet={wet}
          mode={mode}
          calibration={calibration}
          initialPrefs={prefs}
          resume={resume?.state ?? null}
          onFinish={(r) => save(r, null)}
          onPause={(r, st) => save(r, st)}
        />
      )}

      {phase === "saving" && (
        <div className="fixed inset-0 flex items-center justify-center bg-bg">
          <div className="text-center max-w-sm px-6">
            {saveError ? (
              <>
                <p className="font-medium">Couldn&apos;t save your session</p>
                <p className="text-sm text-muted mt-1">{saveError}</p>
                <button className="btn btn-primary mt-5" onClick={() => pendingSave.current && save(pendingSave.current.report, pendingSave.current.state)}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <div className="mx-auto h-8 w-8 rounded-full border-2 border-border border-t-accent animate-spin" />
                <p className="font-medium mt-5">{pausing ? "Saving your place…" : "Building your report…"}</p>
                <p className="text-sm text-muted mt-1">
                  {pausing ? "Your progress is kept. Pick up right where you left off any time." : "Summarizing anything you skipped. This takes a few seconds."}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
