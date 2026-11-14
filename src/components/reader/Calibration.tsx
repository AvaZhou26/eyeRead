"use client";
// Full-screen calibration: click 13 dots while looking at them, then glance at 5 more
// (no clicking) so we can measure how accurate tracking is for *you*, right now.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FaceFrame, FaceTracker } from "@/lib/gaze/faceTracker";
import { GazeModel, validate, type CalibSample, type ValidationResult } from "@/lib/gaze/gazeModel";
import { OneEuroFilter } from "@/lib/gaze/oneEuro";
import type { ReadingFit } from "@/lib/gaze/readingCalibration";
import { gazeEngine, WET_MAX_AGE_S, type GazeEngine, type GazeEstimator, type WebEyeTrackSource, type WetCalibSample } from "@/lib/gaze/webEyeTrackSource";

export interface CalibrationResult {
  engine: GazeEngine;
  estimator: GazeEstimator;
  validation: ValidationResult;
  /** From the reading step (ReadingCalibration), when it was done and could follow the lines. */
  readingFit?: ReadingFit;
  /** The student's own reading pace from the reading step (seconds per word). */
  secPerWord?: number;
}

/** Ridge model as a frame → screen estimator. */
function ridgeEstimator(model: GazeModel): GazeEstimator {
  return { predict: (f) => (f.features ? model.predict(f.features) : null) };
}

/**
 * Hybrid: the usual eye features plus WebEyeTrack's raw (never adapted) output as two more.
 * Whenever WebEyeTrack has no fresh result for a frame, the plain model answers instead.
 */
function hybridEstimator(hybrid: GazeModel, plain: GazeModel, wet: WebEyeTrackSource): GazeEstimator {
  return {
    predict: (f) => {
      if (!f.features) return null;
      const n = wet.normFor(f);
      return n ? hybrid.predict([...f.features, n[0], n[1]]) : plain.predict(f.features);
    },
  };
}

/** One number for "how good is this for telling lines apart" (vertical error + scatter, px). */
const verticalScore = (v: ValidationResult) => v.meanAbsDyPx + (v.jitterDyPx ?? 0);

/** Validation samples in WebEyeTrack mode already hold the predicted point as their "features". */
const PREDICTED = { predict: (f: number[]) => ({ x: f[0], y: f[1] }) };

export const CAL_POINTS: [number, number][] = [
  [50, 50], [6, 8], [50, 8], [94, 8], [94, 50], [94, 92], [50, 92], [6, 92], [6, 50],
  [28, 29], [72, 29], [72, 71], [28, 71],
];
export const VAL_POINTS: [number, number][] = [[50, 40], [24, 26], [76, 26], [76, 74], [24, 74]];

type Phase = "intro" | "calibrate" | "fitting" | "validate" | "result";

export function Calibration({
  tracker,
  wet,
  lineHeight,
  onDone,
  onCancel,
  onAttentionOnly,
}: {
  tracker: FaceTracker;
  /**
   * WebEyeTrack, when the engine needs it. "webeyetrack": calibrate it with its own few-shot
   * adapt instead of the ridge model. "hybrid": leave it unadapted and feed its raw output
   * into the ridge model as extra features.
   */
  wet?: WebEyeTrackSource | null;
  lineHeight: number;
  onDone: (r: CalibrationResult) => void;
  onCancel?: () => void;
  onAttentionOnly: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [idx, setIdx] = useState(0);
  const [collecting, setCollecting] = useState(false);
  const [faceOk, setFaceOk] = useState(true);
  /** Why the last dot click didn't count (empty once a click counts). */
  const [dotMsg, setDotMsg] = useState("");
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [error, setError] = useState("");
  const [size, setSize] = useState({ w: 0, h: 0 });

  const latest = useRef<FaceFrame | null>(null);
  const lastFaceAt = useRef(0);
  const calSamples = useRef<CalibSample[]>([]);
  const valSamples = useRef<CalibSample[]>([]);
  const wetSamples = useRef<(WetCalibSample & { point: number })[]>([]);
  // Hybrid engine: the same moments as calSamples / valSamples, with WebEyeTrack's two numbers added.
  const hybCal = useRef<CalibSample[]>([]);
  const hybVal = useRef<CalibSample[]>([]);
  const hybrid = !!wet && gazeEngine() === "hybrid";
  /** WebEyeTrack calibrated its own way (the "webeyetrack" engine). */
  const wetAdapt = !!wet && !hybrid;
  const lastWetSeq = useRef(-1);
  const collectRef = useRef<{ until: number; from: number; point: number; x: number; y: number; into: CalibSample[] } | null>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const filterX = useRef(new OneEuroFilter(0.6, 0.004));
  const filterY = useRef(new OneEuroFilter(0.6, 0.004));

  useEffect(() => {
    const upd = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    upd();
    window.addEventListener("resize", upd);
    return () => window.removeEventListener("resize", upd);
  }, []);

  // Listen to camera frames: collect samples, and in the result screen draw a live gaze dot.
  useEffect(() => {
    return tracker.subscribe((f) => {
      latest.current = f;
      if (f.face) lastFaceAt.current = f.t;
      const c = collectRef.current;
      if (c && f.features && f.t >= c.from && f.t <= c.until) {
        if (!wet || !wetAdapt) {
          c.into.push({ features: f.features, x: c.x, y: c.y, point: c.point });
          const n = hybrid ? wet!.normFor(f) : null;
          if (n) (c.into === valSamples.current ? hybVal : hybCal).current.push({ features: [...f.features, n[0], n[1]], x: c.x, y: c.y, point: c.point });
        } else if (c.into === valSamples.current) {
          // WebEyeTrack is already adapted by now: store its prediction.
          const g = wet.estimator().predict(f);
          if (g) c.into.push({ features: [g.x, g.y], x: c.x, y: c.y, point: c.point });
        } else {
          const l = wet.latest;
          // l.t >= c.from: the result must come from a frame after the click (results now
          // arrive from the worker a frame or two late).
          if (l && l.seq !== lastWetSeq.current && l.t >= c.from && f.t - l.t < WET_MAX_AGE_S) {
            lastWetSeq.current = l.seq;
            c.into.push({ features: f.features, x: c.x, y: c.y, point: c.point });
            const { eyePatch, headVector, faceOrigin3D } = l.out;
            wetSamples.current.push({ eyePatch, headVector, faceOrigin3D, x: c.x, y: c.y, point: c.point });
          }
        }
      }
      const g = dotRef.current && result ? result.estimator.predict(f) : null;
      if (dotRef.current && g) {
        const x = filterX.current.filter(g.x, f.t);
        const y = filterY.current.filter(g.y, f.t);
        dotRef.current.style.transform = `translate(${x - 14}px, ${y - 14}px)`;
        dotRef.current.style.opacity = "1";
      }
    });
  }, [tracker, wet, wetAdapt, hybrid, result]);

  // Face-visible hint (polled; avoids re-rendering on every frame)
  useEffect(() => {
    const id = setInterval(() => setFaceOk(performance.now() / 1000 - lastFaceAt.current < 0.6), 300);
    return () => clearInterval(id);
  }, []);

  const pos = useCallback(
    (p: [number, number]) => ({ x: (p[0] / 100) * size.w, y: (p[1] / 100) * size.h }),
    [size],
  );

  const collect = (point: number, at: { x: number; y: number }, delay: number, duration: number, into: CalibSample[]) =>
    new Promise<number>((resolve) => {
      const now = performance.now() / 1000;
      const before = into.length;
      collectRef.current = { from: now + delay, until: now + delay + duration, point, x: at.x, y: at.y, into };
      setTimeout(() => {
        collectRef.current = null;
        resolve(into.length - before);
      }, (delay + duration) * 1000 + 30);
    });

  async function clickDot() {
    if (collecting) return;
    setCollecting(true);
    setDotMsg("");
    const got = await collect(idx, pos(CAL_POINTS[idx]), 0.12, 0.85, calSamples.current);
    setCollecting(false);
    if (got < (wetAdapt ? 3 : 6)) {
      // Not enough frames for this dot: say why instead of silently staying on it.
      const faceNow = performance.now() / 1000 - lastFaceAt.current < 0.6;
      setDotMsg(
        !faceNow
          ? "That dot didn't count: we can't see your face. Check the camera and lighting, then click it again."
          : wet?.lastError
            ? `That dot didn't count: the eye tracker couldn't read your eyes (${wet.lastError}). Click it again.`
            : "That dot didn't count: we couldn't see your eyes clearly (blinking or turning away?). Look straight at it and click again.",
      );
      return;
    }
    setDotMsg("");
    if (idx + 1 < CAL_POINTS.length) setIdx(idx + 1);
    else if (wetAdapt && wet) {
      // WebEyeTrack must be adapted before the validation dots, which use its live output.
      setPhase("fitting");
      try {
        const byPoint = new Map<number, WetCalibSample[]>();
        for (const s of wetSamples.current) byPoint.set(s.point, [...(byPoint.get(s.point) ?? []), s]);
        // Up to 4 frames per dot (eye patches are large tensors), 1 fine-tune step (the library
        // default). 8 frames and 3 steps were tried (2026-11-14): no difference to accuracy,
        // only a longer wait.
        const support = [...byPoint.values()].flatMap((ss) => pickEvenly(ss, 4));
        // adapt() trains the CNN for a few seconds (longer the first time, while WebGL compiles
        // its training shaders). It runs in a worker, but let the "Tuning…" card paint first.
        await nextPaint();
        void wet.reset(); // the worker runs this before the adapt() below
        await wet.adapt(support);
        setIdx(0);
        setPhase("validate");
      } catch (e) {
        setError((e as Error).message);
        setPhase("result");
      }
    } else {
      setPhase("validate");
      setIdx(0);
    }
  }

  // Validation runs on its own: each dot shows for ~1.6s.
  useEffect(() => {
    if (phase !== "validate") return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < VAL_POINTS.length && !cancelled; i++) {
        setIdx(i);
        await collect(100 + i, pos(VAL_POINTS[i]), 0.65, 0.95, valSamples.current);
      }
      if (cancelled) return;
      try {
        if (wetAdapt && wet) {
          if (valSamples.current.length < 10) throw new Error("We couldn't see your eyes clearly enough.");
          const validation = validate(PREDICTED, valSamples.current, lineHeight);
          filterX.current.reset();
          filterY.current.reset();
          setResult({ engine: "webeyetrack", estimator: wet.estimator(), validation });
          setPhase("result");
          return;
        }
        const model = GazeModel.fit(calSamples.current);
        const validation = validate(model, valSamples.current, lineHeight);
        // Final model also learns from the validation glances (more data = better).
        const finalModel = GazeModel.fit([...calSamples.current, ...valSamples.current], model.lambda);
        filterX.current.reset();
        filterY.current.reset();
        // Hybrid: only if WebEyeTrack kept up for most of the samples AND the hybrid model does
        // at least as well vertically on the validation dots as the plain one. Otherwise the
        // extra signal isn't helping this person on this screen, and plain is the safer choice.
        if (hybrid && wet && hybCal.current.length >= 0.6 * calSamples.current.length && hybVal.current.length >= 10) {
          try {
            const hModel = GazeModel.fit(hybCal.current);
            const hValidation = validate(hModel, hybVal.current, lineHeight);
            if (verticalScore(hValidation) <= verticalScore(validation) * 1.05) {
              const hFinal = GazeModel.fit([...hybCal.current, ...hybVal.current], hModel.lambda);
              setResult({ engine: "hybrid", estimator: hybridEstimator(hFinal, finalModel, wet), validation: hValidation });
              setPhase("result");
              return;
            }
            console.info("[gaze] hybrid was no better than plain on the validation dots; using plain", { hybrid: hValidation, plain: validation });
          } catch (e) {
            console.warn("[gaze] hybrid fit failed; using plain", e);
          }
        }
        setResult({ engine: "mediapipe", estimator: ridgeEstimator(finalModel), validation });
        setPhase("result");
      } catch (e) {
        setError((e as Error).message);
        setPhase("result");
      }
    })();
    return () => {
      cancelled = true;
      collectRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function restart() {
    calSamples.current = [];
    valSamples.current = [];
    wetSamples.current = [];
    hybCal.current = [];
    hybVal.current = [];
    setResult(null);
    setError("");
    setIdx(0);
    setPhase("calibrate");
  }

  const total = CAL_POINTS.length + VAL_POINTS.length;
  const progress = phase === "calibrate" ? idx / total : phase === "validate" ? (CAL_POINTS.length + idx) / total : 1;

  return (
    <div className="fixed inset-0 z-50 bg-bg select-none">
      {(phase === "calibrate" || phase === "validate") && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-surface-2">
          <div className="h-full bg-accent transition-all duration-300" style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      {phase === "intro" && (
        <CenterCard>
          <h2 className="text-xl font-semibold">Quick calibration</h2>
          <p className="text-muted mt-2 leading-relaxed">
            Dots will appear around the screen. <b className="text-fg">Look right at each dot and click it.</b> Then
            five more dots appear on their own; just look at them. Keep your head fairly still, like you would while reading.
          </p>
          <p className="text-muted mt-3 text-sm">This teaches Read Assist how <i>your</i> eyes look on <i>this</i> screen. About 30 seconds.</p>
          <div className="mt-6 flex gap-2 justify-end">
            {onCancel && <button className="btn btn-ghost" onClick={onCancel}>Back</button>}
            <button className="btn btn-primary" onClick={() => setPhase("calibrate")}>Begin</button>
          </div>
        </CenterCard>
      )}

      {phase === "calibrate" && size.w > 0 && (
        <>
          <Hint faceOk={faceOk} note={dotMsg}>Look at the dot, then click it · {idx + 1} of {CAL_POINTS.length}</Hint>
          <Dot at={pos(CAL_POINTS[idx])} onClick={clickDot} shrinking={collecting} clickable />
        </>
      )}

      {phase === "fitting" && (
        <CenterCard>
          <p className="text-muted">Tuning the eye tracker to you…</p>
        </CenterCard>
      )}

      {phase === "validate" && size.w > 0 && (
        <>
          <Hint faceOk={faceOk}>Now just look at each dot. No clicking.</Hint>
          <Dot key={idx} at={pos(VAL_POINTS[idx])} shrinking={false} />
        </>
      )}

      {phase === "result" && (
        <>
          {result && (
            <div
              ref={dotRef}
              className="pointer-events-none fixed left-0 top-0 h-7 w-7 rounded-full border-2 opacity-0"
              style={{ borderColor: "var(--accent)", background: "color-mix(in srgb, var(--accent) 25%, transparent)" }}
            />
          )}
          {/* The live gaze circle freezes when the face is lost: say why. */}
          <div role="status" aria-live="polite" className="fixed left-0 right-0 top-6 flex justify-center pointer-events-none z-10">
            {result && !faceOk && (
              <div className="rounded-lg bg-surface px-3 py-1.5 text-sm font-medium text-skip shadow-sm">
                We can&apos;t see your face. Check the camera and lighting.
              </div>
            )}
          </div>
          <CenterCard>
            {error || !result ? (
              <>
                <h2 className="text-xl font-semibold">Calibration didn&apos;t work</h2>
                <p className="text-muted mt-2">{error || "We couldn't see your eyes clearly enough."} Check your lighting and try again.</p>
                <div className="mt-6 flex gap-2 justify-end">
                  <button className="btn btn-ghost" onClick={onAttentionOnly}>Continue without eye tracking</button>
                  <button className="btn btn-primary" onClick={restart}>Try again</button>
                </div>
              </>
            ) : (
              <ResultBody result={result} lineHeight={lineHeight} onRetry={restart} onDone={() => onDone(result)} onAttentionOnly={onAttentionOnly} />
            )}
          </CenterCard>
        </>
      )}
    </div>
  );
}

function ResultBody({
  result,
  lineHeight,
  onRetry,
  onDone,
  onAttentionOnly,
}: {
  result: CalibrationResult;
  lineHeight: number;
  onRetry: () => void;
  onDone: () => void;
  onAttentionOnly: () => void;
}) {
  const q = result.validation.quality;
  const meta = {
    good: { label: "Great", color: "var(--read)", text: "Tracking is accurate enough to follow you line by line." },
    fair: { label: "Okay", color: "var(--skim)", text: "Good enough to follow your reading. Some line-level details may be fuzzy." },
    poor: {
      label: "Rough",
      color: "var(--skip)",
      text: "Tracking is imprecise right now. Better lighting or sitting a little closer usually helps. You can still read: we'll focus on page-level insights.",
    },
  }[q];
  const lines = result.validation.meanAbsDyPx / lineHeight;
  const jitter = (result.validation.jitterDyPx ?? 0) / lineHeight;
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="pill !text-sm" style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 15%, transparent)` }}>
          {meta.label}
        </span>
        <span className="text-sm text-muted">
          off by ~{Math.round(result.validation.meanErrorPx)}px (≈{lines.toFixed(1)} lines vertically) · jitter ≈{jitter.toFixed(1)} lines
        </span>
      </div>
      <h2 className="text-xl font-semibold mt-3">Calibration complete</h2>
      <p className="text-muted mt-2 leading-relaxed">{meta.text}</p>
      <p className="text-muted mt-2 text-sm">Look around the screen: the circle should roughly follow your eyes.</p>
      <div className="mt-6 flex flex-wrap gap-2 justify-end">
        {q === "poor" && <button className="btn btn-ghost" onClick={onAttentionOnly}>Page-level only</button>}
        <button className="btn btn-ghost" onClick={onRetry}>Recalibrate</button>
        <button className="btn btn-primary" onClick={onDone}>Start reading</button>
      </div>
    </>
  );
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-none">
      <div className="card max-w-lg w-full p-7 fade-in pointer-events-auto">{children}</div>
    </div>
  );
}

function Hint({ children, faceOk, note }: { children: React.ReactNode; faceOk: boolean; note?: string }) {
  return (
    <div className="absolute left-1/2 top-[38%] -translate-x-1/2 text-center pointer-events-none max-w-md">
      <div className="text-sm text-muted">{children}</div>
      {/* role=status: screen readers announce these when they appear */}
      <div role="status" aria-live="polite">
        {note ? (
          <div className="mt-2 text-sm font-medium text-skip">{note}</div>
        ) : (
          !faceOk && <div className="mt-2 text-sm font-medium text-skip">We can&apos;t see your face. Check the camera and lighting.</div>
        )}
      </div>
    </div>
  );
}

function Dot({ at, onClick, shrinking, clickable }: { at: { x: number; y: number }; onClick?: () => void; shrinking: boolean; clickable?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      aria-label="Calibration dot"
      className="absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
      style={{ left: at.x, top: at.y, width: 56, height: 56, cursor: clickable ? "pointer" : "default" }}
    >
      {!shrinking && (
        <span className="absolute inset-3 rounded-full" style={{ background: "var(--accent)", animation: "pulse-ring 1.4s ease-out infinite" }} />
      )}
      <span
        className="relative rounded-full"
        style={{
          width: shrinking ? 6 : 22,
          height: shrinking ? 6 : 22,
          background: "var(--accent)",
          boxShadow: "0 0 0 4px var(--bg), 0 0 0 5px var(--accent)",
          transition: "width 850ms ease-in, height 850ms ease-in",
        }}
      />
      <span className="absolute h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent-fg)" }} />
    </button>
  );
}

/** Resolves after the browser has painted the current frame (rAF fires before paint, so wait two). */
function nextPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/** Evenly pick up to n items. */
function pickEvenly<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(((i + 0.5) * xs.length) / n)]);
}
