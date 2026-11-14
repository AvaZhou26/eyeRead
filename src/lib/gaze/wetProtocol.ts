// Messages between webEyeTrackSource.ts (main thread) and wet.worker.ts.
import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";

/** ImageData as plain fields, so its buffer can be transferred instead of copied. */
export interface WirePatch {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

export interface WireOutput {
  normPog: [number, number];
  eyePatch: WirePatch;
  headVector: number[];
  faceOrigin3D: number[];
}

export interface WireSample {
  eyePatch: WirePatch;
  headVector: number[];
  faceOrigin3D: number[];
  /** Normalised target, [-0.5, 0.5]. */
  target: [number, number];
}

export type WetRequest =
  | { id: number; type: "init"; withRaw: boolean }
  | {
      id: number;
      type: "step";
      frame: ImageBitmap;
      landmarks: FaceLandmarkerResult;
      ts: number;
      /** Camera frames this step stands for (1 + frames skipped while the worker was busy). */
      frames: number;
    }
  | { id: number; type: "reset" }
  | { id: number; type: "adapt"; samples: WireSample[]; stepsInner: number; innerLR: number };

/** Where a worker step spent its time (ms), and which TF.js backend ran BlazeGaze. */
export interface WetTiming {
  backend: string;
  /** Video frame → pixels (drawImage + getImageData). */
  pixels: number;
  /** WebEyeTrack prepareInput: eye-patch warp + 3D face fit. */
  prepare: number;
  /** BlazeGaze CNN (incl. GPU readback). */
  model: number;
  /** Whole step in the worker. */
  total: number;
}

export type WetResponse =
  | { id: number; ok: true; result: { cal: WireOutput; raw: WireOutput | null } | null; timing?: WetTiming }
  | { id: number; ok: false; error: string };
