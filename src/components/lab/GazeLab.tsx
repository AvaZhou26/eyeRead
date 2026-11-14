"use client";
// Side-by-side gaze accuracy test: the current pipeline (MediaPipe iris/head features +
// ridge) vs WebEyeTrack (BlazeGaze CNN), calibrated on the same 13 dots from the same
// camera frames, then scored on the same 5 validation dots.
import { useEffect, useRef, useState } from "react";
import { FaceTracker } from "@/lib/gaze/faceTracker";
import { GazeModel, type CalibSample } from "@/lib/gaze/gazeModel";
import { ridge, dot, median } from "@/lib/gaze/linalg";
import { normToPx, WebEyeTrackSource, type WetCalibSample } from "@/lib/gaze/webEyeTrackSource";
import { CAL_POINTS, VAL_POINTS } from "@/components/reader/Calibration";

interface Sample {
  t: number;
  point: number;
  x: number;
  y: number;
  features: number[];
  wetCal: [number, number];
  wetRaw: [number, number];
  wet: Omit<WetCalibSample, "x" | "y">;
}

type Pred = (s: Sample) => { x: number; y: number };

interface Models {
  current: GazeModel;
  hybrid: GazeModel;
  wetRidge: { predict: (p: [number, number]) => { x: number; y: number } };
}

interface Metric {
  method: string;
  meanErrPx: number;
  meanAbsDyPx: number;
  lines: number;
  biasDyPx: number;
  perFrameMedAbsDyPx: number;
  perFrameLines: number;
  n: number;
}

const METHODS: { key: string; label: string; color: string }[] = [
  { key: "current", label: "Current (MediaPipe + ridge)", color: "#3c6e71" },
  { key: "wet", label: "WebEyeTrack (its own adapt)", color: "#c2410c" },
  { key: "wetRidge", label: "WebEyeTrack raw + our ridge", color: "#7c3aed" },
  { key: "hybrid", label: "Hybrid: our features + WET raw", color: "#0369a1" },
];

/** Ridge on the uncalibrated WebEyeTrack output (2 numbers + quadratic terms). */
function fitPogRidge(samples: Sample[]) {
  const ex = (p: [number, number]) => [p[0], p[1], p[0] * p[1], p[0] * p[0], p[1] * p[1]];
  const E = samples.map((s) => ex(s.wetRaw));
  const d = E[0].length;
  const mean = Array.from({ length: d }, (_, i) => E.reduce((a, e) => a + e[i], 0) / E.length);
  const std = Array.from({ length: d }, (_, i) => Math.sqrt(E.reduce((a, e) => a + (e[i] - mean[i]) ** 2, 0) / E.length) || 1);
  const row = (e: number[]) => [1, ...e.map((v, i) => (v - mean[i]) / std[i])];
  const X = E.map(row);
  const wx = ridge(X, samples.map((s) => s.x), 1);
  const wy = ridge(X, samples.map((s) => s.y), 1);
  return { predict: (p: [number, number]) => ({ x: dot(row(ex(p)), wx), y: dot(row(ex(p)), wy) }) };
}

function toCalib(samples: Sample[], withWet: boolean): CalibSample[] {
  return samples.map((s) => ({ features: withWet ? [...s.features, s.wetRaw[0], s.wetRaw[1]] : s.features, x: s.x, y: s.y, point: s.point }));
}

function score(method: string, samples: Sample[], pred: Pred, lineH: number): Metric {
  const byPoint = new Map<number, { gx: number; gy: number; n: number; x: number; y: number }>();
  const absDy: number[] = [];
  for (const s of samples) {
    const g = pred(s);
    absDy.push(Math.abs(g.y - s.y));
    const a = byPoint.get(s.point) ?? { gx: 0, gy: 0, n: 0, x: s.x, y: s.y };
    a.gx += g.x;
    a.gy += g.y;
    a.n++;
    byPoint.set(s.point, a);
  }
  let err = 0, ady = 0, dy = 0;
  for (const a of byPoint.values()) {
    const gx = a.gx / a.n, gy = a.gy / a.n;
    err += Math.hypot(gx - a.x, gy - a.y);
    ady += Math.abs(gy - a.y);
    dy += gy - a.y;
  }
  const k = Math.max(1, byPoint.size);
  const med = median(absDy);
  return {
    method,
    meanErrPx: err / k,
    meanAbsDyPx: ady / k,
    lines: ady / k / lineH,
    biasDyPx: dy / k,
    perFrameMedAbsDyPx: med,
    perFrameLines: med / lineH,
    n: samples.length,
  };
}

/** Evenly pick up to n items. */
function pick<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(((i + 0.5) * xs.length) / n)]);
}

function predictors(m: Models): Record<string, Pred> {
  return {
    current: (s) => m.current.predict(s.features),
    wet: (s) => normToPx(s.wetCal),
    wetRidge: (s) => m.wetRidge.predict(s.wetRaw),
    hybrid: (s) => m.hybrid.predict([...s.features, s.wetRaw[0], s.wetRaw[1]]),
  };
}

/** Move each method's live gaze dot (after calibration). */
function drawLive(s: Sample, m: Models | null, els: Record<string, HTMLDivElement | null>) {
  if (!m) return;
  const P = predictors(m);
  for (const { key } of METHODS) {
    const el = els[key];
    if (!el) continue;
    const g = P[key](s);
    el.style.transform = `translate(${g.x - 9}px, ${g.y - 9}px)`;
    el.style.opacity = "0.9";
  }
}

/**
 * Test-only: replace the webcam with a same-origin still image (`?fakeImage=/face.jpg`, file in /public).
 * Exercises the whole pipeline without a camera (e.g. in a browser that blocks camera access).
 */
function installFakeCamera(src: string) {
  if (!src.startsWith("/")) return;
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const img = new Image();
  img.src = src;
  const draw = () => {
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#888";
    ctx.fillRect(0, 0, 1280, 720);
    if (img.complete && img.naturalWidth) {
      const h = 720, w = (img.naturalWidth / img.naturalHeight) * h;
      ctx.drawImage(img, (1280 - w) / 2 + Math.sin(performance.now() / 700) * 6, 0, w, h);
    }
    requestAnimationFrame(draw);
  };
  draw();
  navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(30);
}

type Phase = "loading" | "ready" | "calibrate" | "fitting" | "validate" | "result" | "error";

export function GazeLab() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackerRef = useRef<FaceTracker | null>(null);
  const wetRef = useRef<WebEyeTrackSource | null>(null);
  const modelsRef = useRef<Models | null>(null);
  const calSamples = useRef<Sample[]>([]);
  const valRounds = useRef<Sample[][]>([]);
  const collectRef = useRef<{ from: number; until: number; point: number; x: number; y: number; into: Sample[] } | null>(null);
  const liveRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState("Loading MediaPipe and WebEyeTrack…");
  const [idx, setIdx] = useState(0);
  const [collecting, setCollecting] = useState(false);
  const [lineH, setLineH] = useState(40);
  const [steps, setSteps] = useState(1); // WebEyeTrack's own default
  const [fps, setFps] = useState({ cam: 0, wet: 0 });
  const [results, setResults] = useState<{ rounds: Metric[][]; overall: Metric[]; meta: Record<string, unknown> } | null>(null);
  const [copied, setCopied] = useState(false);

  // Boot: camera + both trackers, wire up per-frame pairing.
  useEffect(() => {
    let cancelled = false;
    const tracker = new FaceTracker();
    trackerRef.current = tracker;
    let unsub = () => {};
    (async () => {
      try {
        const [wet] = await Promise.all([WebEyeTrackSource.create({ withRaw: true }), tracker.init()]);
        if (cancelled) return;
        wetRef.current = wet;
        const fake = new URLSearchParams(window.location.search).get("fakeImage");
        if (fake) installFakeCamera(fake); // pipeline smoke test without a webcam
        await tracker.start(videoRef.current!);
        if (cancelled) return;
        unsub = tracker.subscribeRaw((res, video, frame) => {
          if (!frame.features || wet.busy) return;
          const features = [...frame.features];
          const t = frame.t;
          const c = collectRef.current;
          const target = c && t >= c.from && t <= c.until ? c : null;
          void wet.process(res, video).then((out) => {
            if (!out) return;
            const s: Sample = {
              t,
              point: target?.point ?? -1,
              x: target?.x ?? 0,
              y: target?.y ?? 0,
              features,
              wetCal: out.cal.normPog,
              wetRaw: out.raw.normPog,
              wet: { eyePatch: out.raw.eyePatch, headVector: out.raw.headVector, faceOrigin3D: out.raw.faceOrigin3D },
            };
            if (target) target.into.push(s);
            drawLive(s, modelsRef.current, liveRefs.current);
          });
        });
        setPhase("ready");
        setStatus("");
      } catch (e) {
        console.error(e);
        setStatus(`Failed to start: ${(e as Error).message}`);
        setPhase("error");
      }
    })();
    const id = setInterval(() => setFps({ cam: tracker.fps, wet: wetRef.current?.fps ?? 0 }), 500);
    return () => {
      cancelled = true;
      clearInterval(id);
      unsub();
      tracker.stop();
    };
  }, []);

  const pos = (p: [number, number]) => ({ x: (p[0] / 100) * window.innerWidth, y: (p[1] / 100) * window.innerHeight });

  const collect = (point: number, at: { x: number; y: number }, delay: number, duration: number, into: Sample[]) =>
    new Promise<number>((resolve) => {
      const now = performance.now() / 1000;
      const before = into.length;
      collectRef.current = { from: now + delay, until: now + delay + duration, point, x: at.x, y: at.y, into };
      setTimeout(() => {
        collectRef.current = null;
        // let in-flight WebEyeTrack steps land
        setTimeout(() => resolve(into.length - before), 120);
      }, (delay + duration) * 1000 + 30);
    });

  async function clickDot() {
    if (collecting) return;
    setCollecting(true);
    const got = await collect(idx, pos(CAL_POINTS[idx]), 0.12, 0.85, calSamples.current);
    setCollecting(false);
    if (got < 4) return; // face wasn't visible; click again
    if (idx + 1 < CAL_POINTS.length) setIdx(idx + 1);
    else void fit();
  }

  async function fit() {
    setPhase("fitting");
    setStatus("Fitting models…");
    try {
      const cal = calSamples.current;
      const current = GazeModel.fit(toCalib(cal, false));
      const hybrid = GazeModel.fit(toCalib(cal, true));
      const wetRidge = fitPogRidge(cal);
      // WebEyeTrack adapt: up to 4 frames per dot (eye patches are big tensors).
      const byPoint = new Map<number, Sample[]>();
      for (const s of cal) byPoint.set(s.point, [...(byPoint.get(s.point) ?? []), s]);
      const support = [...byPoint.values()].flatMap((ss) => pick(ss, 4)).map((s) => ({ ...s.wet, x: s.x, y: s.y }));
      await wetRef.current!.adapt(support, steps);
      modelsRef.current = { current, hybrid, wetRidge };
      setStatus("");
      void runValidation();
    } catch (e) {
      console.error(e);
      setStatus(`Fit failed: ${(e as Error).message}`);
      setPhase("error");
    }
  }

  async function runValidation() {
    setPhase("validate");
    const round: Sample[] = [];
    for (let i = 0; i < VAL_POINTS.length; i++) {
      setIdx(i);
      await collect(100 + i, pos(VAL_POINTS[i]), 0.65, 0.95, round);
    }
    valRounds.current.push(round);
    computeResults();
    setPhase("result");
  }

  function computeResults() {
    const m = modelsRef.current!;
    const P = predictors(m);
    const rounds = valRounds.current.map((r) => METHODS.map(({ key }) => score(key, r, P[key], lineH)));
    const all = valRounds.current.flat();
    const overall = METHODS.map(({ key }) => score(key, all, P[key], lineH));
    setResults({
      rounds,
      overall,
      meta: {
        when: new Date().toISOString(),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        dpr: window.devicePixelRatio,
        camera: `${videoRef.current?.videoWidth}x${videoRef.current?.videoHeight}`,
        camFps: Math.round(trackerRef.current?.fps ?? 0),
        wetFps: Math.round(wetRef.current?.fps ?? 0),
        calSamples: calSamples.current.length,
        wetAdaptSteps: steps,
        lineHeightPx: lineH,
        currentLambda: m.current.lambda,
        userAgent: navigator.userAgent,
      },
    });
  }

  function restart() {
    calSamples.current = [];
    valRounds.current = [];
    modelsRef.current = null;
    setResults(null);
    setIdx(0);
    // WebEyeTrack's adapt is cumulative; reload to start clean.
    window.location.reload();
  }

  const json = results ? JSON.stringify(results, (_, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v), 2) : "";

  return (
    <div className="fixed inset-0 bg-bg select-none overflow-auto">
      <video ref={videoRef} className="fixed bottom-3 right-3 w-40 rounded opacity-60 -scale-x-100 pointer-events-none" muted playsInline />
      <div className="fixed bottom-3 left-3 text-xs text-muted font-mono pointer-events-none">
        cam {fps.cam.toFixed(0)} fps · WebEyeTrack {fps.wet.toFixed(0)} fps
      </div>

      {METHODS.map(({ key, color }) => (
        <div
          key={key}
          ref={(el) => {
            liveRefs.current[key] = el;
          }}
          className="pointer-events-none fixed left-0 top-0 h-[18px] w-[18px] rounded-full border-2 opacity-0 z-10"
          style={{ borderColor: color, background: `color-mix(in srgb, ${color} 30%, transparent)` }}
        />
      ))}

      {(phase === "loading" || phase === "fitting" || phase === "error") && (
        <Card>
          <h1 className="text-xl font-semibold">Gaze lab</h1>
          <p className="text-muted mt-2">{status}</p>
          {phase === "error" && <button className="btn btn-primary mt-4" onClick={restart}>Reload</button>}
        </Card>
      )}

      {phase === "ready" && (
        <Card>
          <h1 className="text-xl font-semibold">Gaze lab: current tracker vs WebEyeTrack</h1>
          <p className="text-muted mt-2 leading-relaxed">
            Both trackers watch the same camera frames. <b className="text-fg">Look at each dot and click it</b> (13 dots), then
            look at 5 more dots without clicking. Sit like you would while reading and keep your head fairly still.
          </p>
          <div className="mt-4 flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              Line height (px)
              <input type="number" className="input w-20" value={lineH} onChange={(e) => setLineH(Number(e.target.value) || 40)} />
            </label>
            <label className="flex items-center gap-2">
              WebEyeTrack adapt steps
              <input type="number" className="input w-20" value={steps} onChange={(e) => setSteps(Math.max(0, Number(e.target.value) || 0))} />
            </label>
          </div>
          <div className="mt-6 flex justify-end">
            <button className="btn btn-primary" onClick={() => { setIdx(0); setPhase("calibrate"); }}>Begin</button>
          </div>
        </Card>
      )}

      {phase === "calibrate" && (
        <>
          <Hint>Look at the dot, then click it · {idx + 1} of {CAL_POINTS.length}</Hint>
          <Dot at={pos(CAL_POINTS[idx])} onClick={clickDot} shrinking={collecting} />
        </>
      )}

      {phase === "validate" && (
        <>
          <Hint>Just look at each dot. No clicking.</Hint>
          <Dot key={idx} at={pos(VAL_POINTS[idx])} shrinking={false} />
        </>
      )}

      {phase === "result" && results && (
        <div className="max-w-4xl mx-auto p-6 mt-6 card relative z-0">
          <h1 className="text-xl font-semibold">Results ({valRounds.current.length} validation round{valRounds.current.length > 1 ? "s" : ""})</h1>
          <p className="text-sm text-muted mt-1">
            Dot-averaged error (like the app&apos;s calibration check) and per-frame median vertical error. Lines = vertical px ÷ {lineH}px.
            Live dots show each method&apos;s current estimate (colours match the table).
          </p>
          <table className="mt-4 w-full text-sm" id="gaze-lab-results">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1">Method</th><th>Mean err px</th><th>|dy| px</th><th>Lines</th><th>Bias dy</th><th>Per-frame |dy| px</th><th>Per-frame lines</th><th>n</th>
              </tr>
            </thead>
            <tbody>
              {results.overall.map((m) => {
                const meta = METHODS.find((x) => x.key === m.method)!;
                return (
                  <tr key={m.method} className="border-t border-border">
                    <td className="py-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full mr-2" style={{ background: meta.color }} />{meta.label}</td>
                    <td>{m.meanErrPx.toFixed(0)}</td>
                    <td>{m.meanAbsDyPx.toFixed(0)}</td>
                    <td>{m.lines.toFixed(2)}</td>
                    <td>{m.biasDyPx.toFixed(0)}</td>
                    <td>{m.perFrameMedAbsDyPx.toFixed(0)}</td>
                    <td>{m.perFrameLines.toFixed(2)}</td>
                    <td>{m.n}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-5 flex flex-wrap gap-2 justify-end">
            <button className="btn btn-ghost" onClick={restart}>Start over</button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                void navigator.clipboard.writeText(json).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy JSON"}
            </button>
            <button className="btn btn-primary" onClick={() => void runValidation()}>Validate again (drift check)</button>
          </div>
          <pre className="mt-4 text-xs bg-surface-2 p-3 rounded overflow-auto max-h-80 select-text" id="gaze-lab-json">{json}</pre>
        </div>
      )}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="card max-w-lg w-full p-7">{children}</div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="absolute left-1/2 top-[38%] -translate-x-1/2 text-sm text-muted pointer-events-none">{children}</div>;
}

function Dot({ at, onClick, shrinking }: { at: { x: number; y: number }; onClick?: () => void; shrinking: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label="Gaze target"
      className="absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
      style={{ left: at.x, top: at.y, width: 56, height: 56 }}
    >
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
