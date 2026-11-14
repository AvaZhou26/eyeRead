// Experimental: WebEyeTrack (github.com/RedForestAI/WebEyeTrack, MIT) as a second gaze source.
// WebEyeTrack crops an eye patch from the MediaPipe face mesh, runs its BlazeGaze CNN
// (model in /public/web, ~0.6 MB) together with head pose, and outputs a normalised
// point of gaze in [-0.5, 0.5] (0,0 = screen centre).
//
// We do NOT use its WebEyeTrackProxy: that starts its own camera, loads MediaPipe from a
// CDN, and recalibrates on every window click. Instead we drive the WebEyeTrack class on
// the main thread and hand it the MediaPipe result our FaceTracker already computed, so the
// face mesh runs once per frame and nothing is fetched from third-party servers.
import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { GazeResult, WebEyeTrack } from "webeyetrack";
import type { FaceFrame, FaceTracker } from "./faceTracker";

/** Which gaze estimator the reader uses. WebEyeTrack is the default since the 2026-11 eval. */
export type GazeEngine = "webeyetrack" | "mediapipe";

/**
 * Feature flag. Default "mediapipe" (MediaPipe features + ridge regression): in the one
 * side-by-side run we have (GAZE_EVAL.md) it was far steadier vertically than WebEyeTrack
 * (0.9 vs 2.5 lines per frame), and vertical accuracy is what decides the line you're on.
 * To try WebEyeTrack, set NEXT_PUBLIC_GAZE_ENGINE=webeyetrack (build time) or add
 * ?gaze=webeyetrack to the URL.
 */
export function gazeEngine(): GazeEngine {
  if (typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search).get("gaze");
    if (q === "mediapipe" || q === "webeyetrack") return q;
  }
  return process.env.NEXT_PUBLIC_GAZE_ENGINE === "webeyetrack" ? "webeyetrack" : "mediapipe";
}

/** Anything that turns a camera frame into a screen point (viewport CSS px). */
export interface GazeEstimator {
  predict(f: FaceFrame): { x: number; y: number } | null;
}

export interface WetOutput {
  /** Normalised gaze, x/y in [-0.5, 0.5] of the window. */
  normPog: [number, number];
  eyePatch: ImageData;
  headVector: number[];
  faceOrigin3D: number[];
}

export interface WetCalibSample {
  eyePatch: ImageData;
  headVector: number[];
  faceOrigin3D: number[];
  x: number; // target, CSS px in the viewport
  y: number;
}

type Shim = { initialize: () => Promise<void>; processFrame: () => Promise<FaceLandmarkerResult | null> };

async function makeTracker(current: () => FaceLandmarkerResult | null): Promise<WebEyeTrack> {
  const mod = (await import("webeyetrack")) as unknown as { WebEyeTrack?: typeof WebEyeTrack; default?: { WebEyeTrack: typeof WebEyeTrack } };
  const Ctor = mod.WebEyeTrack ?? mod.default?.WebEyeTrack;
  if (!Ctor) throw new Error("webeyetrack: WebEyeTrack export not found");
  // maxPoints counts adapt() calls, not samples; we calibrate in one call.
  const w = new Ctor(50, 60);
  const shim: Shim = { initialize: async () => {}, processFrame: async () => current() };
  (w as unknown as { faceLandmarkerClient: Shim }).faceLandmarkerClient = shim;
  await w.initialize(); // loads /web/model.json
  return w;
}

/**
 * WebEyeTrack instance(s) fed from our FaceTracker:
 *  - `calibrated` is personalised with WebEyeTrack's own adapt() (affine fit + MLP fine-tune);
 *  - `raw` (gaze lab only, `withRaw`) is never adapted, so its output can feed our own ridge.
 */
export class WebEyeTrackSource {
  private current: FaceLandmarkerResult | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private lastAt = 0;
  private unsub: (() => void) | null = null;
  busy = false;
  fps = 0;
  adapted = false;
  /** Latest result from attach(): gaze output + the FaceFrame time it belongs to. */
  latest: { out: WetOutput; t: number; seq: number } | null = null;
  private seq = 0;

  private constructor(
    private calibrated: WebEyeTrack,
    private raw: WebEyeTrack | null,
  ) {}

  static async create({ withRaw = false } = {}): Promise<WebEyeTrackSource> {
    let src: WebEyeTrackSource | null = null;
    const get = () => src?.current ?? null;
    const [a, b] = await Promise.all([makeTracker(get), withRaw ? makeTracker(get) : Promise.resolve(null)]);
    src = new WebEyeTrackSource(a, b);
    return src;
  }

  /** Run on every camera frame of `tracker`, keeping `latest` up to date. */
  attach(tracker: FaceTracker) {
    this.unsub?.();
    this.unsub = tracker.subscribeRaw((res, video, f) => {
      if (!f.features) {
        this.latest = null; // blink / no face
        return;
      }
      const t = f.t;
      void this.process(res, video).then((o) => {
        if (o) this.latest = { out: o.cal, t, seq: ++this.seq };
      });
    });
  }

  detach() {
    this.unsub?.();
    this.unsub = null;
    this.latest = null;
  }

  /** Gaze for a frame: the newest WebEyeTrack result, if it's recent (it lags ~1 frame). */
  estimator(): GazeEstimator {
    return {
      predict: (f) => {
        const l = this.latest;
        if (!f.features || !l || f.t - l.t > 0.2 || !this.adapted) return null;
        return normToPx(l.out.normPog);
      },
    };
  }

  /** Forget previous calibration (affine + support set) before recalibrating. */
  reset() {
    const w = this.calibrated as unknown as {
      calibData: { supportX: { eyePatches: { dispose(): void }; headVectors: { dispose(): void }; faceOrigins3D: { dispose(): void } }[]; supportY: { dispose(): void }[]; timestamps: number[]; ptType: string[] };
      affineMatrix: { dispose(): void } | null;
    };
    for (const s of w.calibData.supportX) [s.eyePatches, s.headVectors, s.faceOrigins3D].forEach((x) => x.dispose());
    for (const y of w.calibData.supportY) y.dispose();
    w.calibData = { supportX: [], supportY: [], timestamps: [], ptType: [] };
    w.affineMatrix?.dispose();
    w.affineMatrix = null;
    this.adapted = false;
  }

  /** Run both instances on one frame. Returns null if busy, eyes closed or no face. */
  async process(res: FaceLandmarkerResult, video: HTMLVideoElement): Promise<{ cal: WetOutput; raw: WetOutput } | null> {
    if (this.busy || !res.faceLandmarks?.length || !res.facialTransformationMatrixes?.length) return null;
    this.busy = true;
    try {
      const W = video.videoWidth, H = video.videoHeight;
      if (!W || !H) return null;
      this.canvas ??= document.createElement("canvas");
      const c = this.canvas;
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, W, H);
      const img = ctx.getImageData(0, 0, W, H);
      this.current = res;
      const ts = performance.now();
      const cal = await this.calibrated.step(img, ts);
      const raw = this.raw ? await this.raw.step(img, ts) : cal;
      const now = performance.now();
      if (this.lastAt) this.fps = 0.9 * this.fps + 0.1 * (1000 / Math.max(1, now - this.lastAt));
      this.lastAt = now;
      if (cal.gazeState !== "open" || raw.gazeState !== "open") return null;
      return { cal: toOut(cal), raw: toOut(raw) };
    } catch (e) {
      console.warn("[webeyetrack] step failed", e);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** Personalise the `calibrated` instance with WebEyeTrack's own few-shot adapt(). */
  async adapt(samples: WetCalibSample[], stepsInner = 1, innerLR = 1e-5) {
    if (samples.length < 4) throw new Error("WebEyeTrack needs at least 4 calibration samples");
    const w = window.innerWidth, h = window.innerHeight;
    // Wait for any in-flight step so the two don't race on the model.
    while (this.busy) await new Promise((r) => setTimeout(r, 10));
    this.busy = true;
    try {
      await this.calibrated.adapt(
        samples.map((s) => s.eyePatch),
        samples.map((s) => s.headVector),
        samples.map((s) => s.faceOrigin3D),
        samples.map((s) => [s.x / w - 0.5, s.y / h - 0.5]),
        stepsInner,
        innerLR,
        "calib",
      );
      this.adapted = true;
    } finally {
      this.busy = false;
    }
  }
}

function toOut(r: GazeResult): WetOutput {
  return {
    normPog: [r.normPog[0], r.normPog[1]],
    eyePatch: r.eyePatch,
    headVector: r.headVector,
    faceOrigin3D: r.faceOrigin3D,
  };
}

/** Normalised gaze → viewport CSS px. */
export function normToPx(p: [number, number]): { x: number; y: number } {
  return { x: (p[0] + 0.5) * window.innerWidth, y: (p[1] + 0.5) * window.innerHeight };
}
