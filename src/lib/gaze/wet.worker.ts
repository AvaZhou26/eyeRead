/// <reference lib="webworker" />
// Runs WebEyeTrack off the main thread. See webEyeTrackSource.ts for the main-thread side.
//
// Per frame, WebEyeTrack does a full-frame pixel readback, a pure-JS perspective warp of the
// eye patch, an iterative 3D face fit and a blocking GPU readback (arraySync). On the main
// thread that starved clicks and animations; here it only costs this worker's time.
// TensorFlow.js uses WebGL through OffscreenCanvas in workers (falls back to CPU if not).
//
// We drive the WebEyeTrack class directly (not its WebEyeTrackProxy: that opens its own
// camera, loads MediaPipe from a CDN and recalibrates on every click). The main thread
// already ran MediaPipe, so it sends that result along with the frame and a shim hands it
// to WebEyeTrack in place of its own face landmarker.
import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { GazeResult, WebEyeTrack } from "webeyetrack";
import type { WetRequest, WetResponse, WetTiming, WireOutput } from "./wetProtocol";

/** TF.js keeps its engine in a global map; read the active backend name for diagnostics. */
function tfBackend(): string {
  const g = (globalThis as unknown as { _tfGlobals?: Map<string, { backendName?: string }> })._tfGlobals;
  return g?.get("_tfengine")?.backendName ?? "unknown";
}

declare const self: DedicatedWorkerGlobalScope;

type Shim = { initialize: () => Promise<void>; processFrame: () => Promise<FaceLandmarkerResult | null> };

let current: FaceLandmarkerResult | null = null;
let calibrated: WebEyeTrack | null = null;
let raw: WebEyeTrack | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

async function makeTracker(): Promise<WebEyeTrack> {
  const mod = (await import("webeyetrack")) as unknown as { WebEyeTrack?: typeof WebEyeTrack; default?: { WebEyeTrack: typeof WebEyeTrack } };
  const Ctor = mod.WebEyeTrack ?? mod.default?.WebEyeTrack;
  if (!Ctor) throw new Error("webeyetrack: WebEyeTrack export not found");
  // maxPoints counts adapt() calls, not samples; we calibrate in one call.
  const w = new Ctor(50, 60);
  const shim: Shim = { initialize: async () => {}, processFrame: async () => current };
  (w as unknown as { faceLandmarkerClient: Shim }).faceLandmarkerClient = shim;
  await w.initialize(); // loads `${self.location.origin}/web/model.json`
  frameRateIndependentKalman(w);
  return w;
}

/**
 * WebEyeTrack smooths its output with a constant-velocity Kalman filter whose time step is
 * "one call" (dt = 1). It was tuned for being called on every ~30 fps camera frame. We skip
 * frames while the worker is busy, so at e.g. 10 steps/s the same filter would lag ~3x longer
 * in real time, and the gaze point would trail behind the eyes.
 *
 * So before each update, grow the filter's uncertainty by one process-noise step (Q) per
 * skipped frame. Its next update then trusts the new measurement more, which keeps the lag
 * close to real time. We deliberately do NOT run extra predict() steps: those also move the
 * estimate along its (noisy) velocity, and over several skipped frames that overshoots and
 * makes the gaze point jerk around.
 */
type MlMatrix = { clone(): MlMatrix; mul(k: number): MlMatrix; add(m: MlMatrix): MlMatrix };
const kalmanFrames = new WeakMap<WebEyeTrack, number>();
function frameRateIndependentKalman(w: WebEyeTrack) {
  const kf = (w as unknown as { kalmanFilter: { P: MlMatrix; Q: MlMatrix; step(x: number[]): number[] } }).kalmanFilter;
  const step = kf.step.bind(kf);
  kf.step = (x) => {
    const n = kalmanFrames.get(w) ?? 1;
    // ml-matrix mutates in place: clone Q so the filter's own Q is untouched.
    if (n > 1) kf.P = kf.P.add(kf.Q.clone().mul(n - 1));
    return step(x);
  };
}

function toWire(r: GazeResult, transfer: Transferable[]): WireOutput {
  const p = r.eyePatch;
  transfer.push(p.data.buffer);
  return {
    normPog: [r.normPog[0], r.normPog[1]],
    eyePatch: { data: p.data, width: p.width, height: p.height },
    headVector: r.headVector,
    faceOrigin3D: r.faceOrigin3D,
  };
}

function reset(w: WebEyeTrack) {
  const x = w as unknown as {
    calibData: { supportX: { eyePatches: { dispose(): void }; headVectors: { dispose(): void }; faceOrigins3D: { dispose(): void } }[]; supportY: { dispose(): void }[]; timestamps: number[]; ptType: string[] };
    affineMatrix: { dispose(): void } | null;
  };
  for (const s of x.calibData.supportX) [s.eyePatches, s.headVectors, s.faceOrigins3D].forEach((t) => t.dispose());
  for (const y of x.calibData.supportY) y.dispose();
  x.calibData = { supportX: [], supportY: [], timestamps: [], ptType: [] };
  x.affineMatrix?.dispose();
  x.affineMatrix = null;
}

async function handle(msg: WetRequest): Promise<{ res: WetResponse; transfer: Transferable[] }> {
  const transfer: Transferable[] = [];
  switch (msg.type) {
    case "init": {
      [calibrated, raw] = await Promise.all([makeTracker(), msg.withRaw ? makeTracker() : Promise.resolve(null)]);
      return { res: { id: msg.id, ok: true, result: null }, transfer };
    }
    case "step": {
      const { frame, landmarks } = msg;
      try {
        if (!calibrated) throw new Error("WebEyeTrack not initialised");
        const W = frame.width, H = frame.height;
        if (!canvas || canvas.width !== W || canvas.height !== H) {
          canvas = new OffscreenCanvas(W, H);
          ctx = canvas.getContext("2d", { willReadFrequently: true });
        }
        if (!ctx) throw new Error("No 2D context in worker");
        const t0 = performance.now();
        ctx.drawImage(frame, 0, 0);
        const img = ctx.getImageData(0, 0, W, H);
        const pixels = performance.now() - t0;
        current = landmarks;
        // Cap: after a long gap (no face), don't extrapolate the old velocity for seconds.
        const frames = Math.max(1, Math.min(8, Math.round(msg.frames)));
        kalmanFrames.set(calibrated, frames);
        if (raw) kalmanFrames.set(raw, frames);
        const cal = await calibrated.step(img, msg.ts);
        const rw = raw ? await raw.step(img, msg.ts) : null;
        const d = cal.durations as { prepareInput?: number; blazeGaze?: number } | undefined;
        const timing: WetTiming = {
          backend: tfBackend(),
          pixels,
          prepare: d?.prepareInput ?? 0,
          model: d?.blazeGaze ?? 0,
          total: performance.now() - t0,
        };
        if (cal.gazeState !== "open" || (rw && rw.gazeState !== "open")) {
          return { res: { id: msg.id, ok: true, result: null, timing }, transfer };
        }
        const calOut = toWire(cal, transfer);
        return { res: { id: msg.id, ok: true, result: { cal: calOut, raw: rw ? toWire(rw, transfer) : null }, timing }, transfer };
      } finally {
        frame.close();
      }
    }
    case "reset": {
      if (calibrated) reset(calibrated);
      return { res: { id: msg.id, ok: true, result: null }, transfer };
    }
    case "adapt": {
      if (!calibrated) throw new Error("WebEyeTrack not initialised");
      const s = msg.samples;
      await calibrated.adapt(
        s.map((x) => new ImageData(x.eyePatch.data, x.eyePatch.width, x.eyePatch.height)),
        s.map((x) => x.headVector),
        s.map((x) => x.faceOrigin3D),
        s.map((x) => x.target),
        msg.stepsInner,
        msg.innerLR,
        "calib",
      );
      return { res: { id: msg.id, ok: true, result: null }, transfer };
    }
  }
}

// One message at a time, in order: the main thread relies on reset → adapt → step ordering,
// and WebEyeTrack's model must not run step() and adapt() concurrently.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<WetRequest>) => {
  const msg = e.data;
  queue = queue.then(async () => {
    try {
      const { res, transfer } = await handle(msg);
      self.postMessage(res, transfer);
    } catch (err) {
      if (msg.type === "step") msg.frame.close?.();
      self.postMessage({ id: msg.id, ok: false, error: (err as Error).message ?? String(err) } satisfies WetResponse);
    }
  });
};
