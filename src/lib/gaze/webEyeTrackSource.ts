// Experimental: WebEyeTrack (github.com/RedForestAI/WebEyeTrack, MIT) as a second gaze source.
// WebEyeTrack crops an eye patch from the MediaPipe face mesh, runs its BlazeGaze CNN
// (model in /public/web, ~0.6 MB) together with head pose, and outputs a normalised
// point of gaze in [-0.5, 0.5] (0,0 = screen centre).
//
// We do NOT use its WebEyeTrackProxy: that starts its own camera, loads MediaPipe from a
// CDN, and recalibrates on every window click. Instead we drive the WebEyeTrack class in our
// own Web Worker (wet.worker.ts) and hand it the MediaPipe result our FaceTracker already
// computed, so the face mesh runs once per frame and nothing is fetched from third-party
// servers. WebEyeTrack's per-frame work and its calibration training are heavy and almost
// entirely synchronous; in the worker they no longer block clicks, scrolling or animation.
import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { FaceFrame, FaceTracker } from "./faceTracker";
import type { WetRequest, WetResponse, WetTiming, WireOutput, WirePatch } from "./wetProtocol";

/**
 * Which gaze estimator the reader uses (see GAZE_EVAL.md):
 *  - "webeyetrack": BlazeGaze calibrated with WebEyeTrack's own adapt();
 *  - "mediapipe": MediaPipe iris/head features → our ridge `GazeModel` (the default).
 */
export type GazeEngine = "webeyetrack" | "mediapipe";
const ENGINES: GazeEngine[] = ["webeyetrack", "mediapipe"];

/**
 * Feature flag. Default "mediapipe" (MediaPipe features + ridge regression): in the one
 * side-by-side run we have (GAZE_EVAL.md) it was far steadier vertically than WebEyeTrack
 * (0.9 vs 2.5 lines per frame), and vertical accuracy is what decides the line you're on.
 * To try WebEyeTrack, set NEXT_PUBLIC_GAZE_ENGINE=webeyetrack (build time) or add
 * ?gaze=webeyetrack to the URL.
 */
export function gazeEngine(): GazeEngine {
  if (typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search).get("gaze") as GazeEngine | null;
    if (q && ENGINES.includes(q)) return q;
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

/** How old (seconds) a WebEyeTrack result may be and still count for the current frame. */
export const WET_MAX_AGE_S = 0.35;

type Pending = { resolve: (r: Extract<WetResponse, { ok: true }>["result"]) => void; reject: (e: Error) => void };
type OnTiming = (t: WetTiming) => void;
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** Talks to wet.worker.ts: one request → one response, matched by id. */
class WetWorker {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  onTiming: OnTiming | null = null;

  constructor() {
    this.worker = new Worker(new URL("./wet.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WetResponse>) => {
      const r = e.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.ok && r.timing) this.onTiming?.(r.timing);
      if (r.ok) p.resolve(r.result);
      else p.reject(new Error(r.error));
    };
    this.worker.onerror = (e) => {
      const err = new Error(`WebEyeTrack worker failed: ${e.message || "unknown error"}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  call(msg: WithoutId<WetRequest>, transfer: Transferable[] = []) {
    const id = this.nextId++;
    return new Promise<Extract<WetResponse, { ok: true }>["result"]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id } as WetRequest, transfer);
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

/** A plain, structured-clone-safe copy of the MediaPipe result fields WebEyeTrack reads. */
function plainLandmarks(res: FaceLandmarkerResult): FaceLandmarkerResult {
  return {
    faceLandmarks: res.faceLandmarks.slice(0, 1).map((f) => f.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }))),
    facialTransformationMatrixes: (res.facialTransformationMatrixes ?? []).slice(0, 1).map((m) => ({ rows: m.rows, columns: m.columns, data: Array.from(m.data) })),
    faceBlendshapes: [],
  };
}

const toImageData = (p: WirePatch) => new ImageData(p.data, p.width, p.height);
const fromWire = (o: WireOutput): WetOutput => ({ ...o, eyePatch: toImageData(o.eyePatch) });

/**
 * WebEyeTrack instance(s), running in a worker, fed from our FaceTracker:
 *  - `calibrated` is personalised with WebEyeTrack's own adapt() (affine fit + MLP fine-tune);
 *  - `raw` (gaze lab only, `withRaw`) is never adapted, so its output can feed our own ridge.
 */
export class WebEyeTrackSource {
  private lastAt = 0;
  private unsub: (() => void) | null = null;
  /** True while a frame is in the worker; new frames are skipped until it answers. */
  busy = false;
  fps = 0;
  /** Why the last step failed (null once a step succeeds). Shown in /gaze-lab. */
  lastError: string | null = null;
  adapted = false;
  /** Latest result from attach(): gaze output + the FaceFrame time it belongs to. */
  latest: { out: WetOutput; t: number; seq: number } | null = null;
  private seq = 0;

  /** Smoothed per-step timings from the worker (ms), for diagnostics (see /gaze-lab). */
  timing: WetTiming | null = null;

  private constructor(
    private worker: WetWorker,
    private withRaw: boolean,
  ) {
    worker.onTiming = (t) => {
      const p = this.timing;
      const mix = (a: number, b: number) => (p ? 0.9 * a + 0.1 * b : b);
      this.timing = {
        backend: t.backend,
        pixels: mix(p?.pixels ?? 0, t.pixels),
        prepare: mix(p?.prepare ?? 0, t.prepare),
        model: mix(p?.model ?? 0, t.model),
        total: mix(p?.total ?? 0, t.total),
      };
    };
  }

  static async create({ withRaw = false } = {}): Promise<WebEyeTrackSource> {
    const worker = new WetWorker();
    try {
      await worker.call({ type: "init", withRaw }); // loads /web/model.json in the worker
    } catch (e) {
      worker.terminate();
      throw e;
    }
    return new WebEyeTrackSource(worker, withRaw);
  }

  /** Send camera frames of `tracker` to the worker (one at a time), keeping `latest` up to date. */
  attach(tracker: FaceTracker) {
    this.unsub?.();
    this.unsub = tracker.subscribeRaw((res, video, f) => {
      if (!f.features) {
        this.latest = null; // blink / no face
        return;
      }
      if (this.busy) {
        this.skipped++; // worker still on the previous frame: skip this one, but count it
        return;
      }
      const t = f.t;
      const frames = 1 + this.skipped;
      this.skipped = 0;
      void this.process(res, video, frames).then((o) => {
        if (!o) return;
        this.latest = { out: o.cal, t, seq: ++this.seq };
        this.glideTo(o.cal.normPog);
      });
    });
  }

  /** Face frames skipped since the last one sent to the worker (keeps its smoothing in real time). */
  private skipped = 0;

  // Glide: results arrive ~10–15 times a second but the gaze is read on every ~30 fps camera
  // frame. Holding each result and then jumping looks jerky, so the estimator moves smoothly
  // from where it was to the newest result over one typical update interval (~1 update of lag).
  private glide: { from: [number, number]; to: [number, number]; at: number } | null = null;
  private updateMs = 80;

  private glideTo(p: [number, number]) {
    const now = performance.now();
    if (this.glide) this.updateMs = Math.min(400, 0.8 * this.updateMs + 0.2 * (now - this.glide.at));
    // Start from wherever the dot is right now, so a result that lands mid-glide doesn't jump.
    const from = this.glidePos(now) ?? p;
    this.glide = { from, to: [p[0], p[1]], at: now };
  }

  private glidePos(now: number): [number, number] | null {
    const g = this.glide;
    if (!g) return null;
    const a = Math.max(0, Math.min(1, (now - g.at) / this.updateMs));
    return [g.from[0] + a * (g.to[0] - g.from[0]), g.from[1] + a * (g.to[1] - g.from[1])];
  }

  detach() {
    this.unsub?.();
    this.unsub = null;
    this.latest = null;
    this.glide = null;
  }

  /** Stop the worker for good (frees its GPU memory). The source can't be used afterwards. */
  dispose() {
    this.detach();
    this.worker.terminate();
  }

  /** Gaze for a frame: the newest WebEyeTrack result, if it's recent (it lags a frame or two). */
  estimator(): GazeEstimator {
    return {
      predict: (f) => {
        const l = this.latest;
        if (!f.features || !l || f.t - l.t > WET_MAX_AGE_S || !this.adapted) return null;
        return normToPx(this.glidePos(performance.now()) ?? l.out.normPog);
      },
    };
  }

  /** Forget previous calibration (affine + support set) before recalibrating. */
  reset(): Promise<void> {
    this.adapted = false;
    // The worker handles messages in order, so a following adapt() sees the reset.
    return this.worker.call({ type: "reset" }).then(() => {});
  }

  /** Run both instances on one frame in the worker. Returns null if busy, eyes closed or no face. */
  async process(res: FaceLandmarkerResult, video: HTMLVideoElement, frames = 1): Promise<{ cal: WetOutput; raw: WetOutput } | null> {
    if (this.busy || !res.faceLandmarks?.length || !res.facialTransformationMatrixes?.length) return null;
    if (!video.videoWidth || !video.videoHeight) return null;
    this.busy = true;
    try {
      const landmarks = plainLandmarks(res);
      // Snapshot of the current video frame; transferred (not copied) to the worker.
      const frame = await createImageBitmap(video);
      const out = await this.worker.call({ type: "step", frame, landmarks, ts: performance.now(), frames }, [frame]);
      const now = performance.now();
      if (this.lastAt) this.fps = 0.9 * this.fps + 0.1 * (1000 / Math.max(1, now - this.lastAt));
      this.lastAt = now;
      this.lastError = null;
      if (!out) return null;
      const cal = fromWire(out.cal);
      return { cal, raw: this.withRaw && out.raw ? fromWire(out.raw) : cal };
    } catch (e) {
      console.warn("[webeyetrack] step failed", e);
      this.lastError = (e as Error).message || String(e);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** Personalise the `calibrated` instance with WebEyeTrack's own few-shot adapt(), in the worker. */
  async adapt(samples: WetCalibSample[], stepsInner = 1, innerLR = 1e-5) {
    if (samples.length < 4) throw new Error("WebEyeTrack needs at least 4 calibration samples");
    const w = window.innerWidth, h = window.innerHeight;
    // The worker queues this behind any in-flight step, so the two never race on the model.
    // Eye patches are copied (not transferred): callers may keep using their samples.
    await this.worker.call({
      type: "adapt",
      samples: samples.map((s) => ({
        eyePatch: { data: s.eyePatch.data as Uint8ClampedArray<ArrayBuffer>, width: s.eyePatch.width, height: s.eyePatch.height },
        headVector: s.headVector,
        faceOrigin3D: s.faceOrigin3D,
        target: [s.x / w - 0.5, s.y / h - 0.5] as [number, number],
      })),
      stepsInner,
      innerLR,
    });
    this.adapted = true;
  }
}

/** Normalised gaze → viewport CSS px. */
export function normToPx(p: [number, number]): { x: number; y: number } {
  return { x: (p[0] + 0.5) * window.innerWidth, y: (p[1] + 0.5) * window.innerHeight };
}
