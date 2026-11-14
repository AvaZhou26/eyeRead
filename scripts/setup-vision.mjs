// Copies MediaPipe's WebAssembly files into /public and downloads the face model,
// so eye tracking works without relying on a CDN at runtime.
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const wasmSrc = "node_modules/@mediapipe/tasks-vision/wasm";
const wasmDest = "public/mediapipe/wasm";
mkdirSync(wasmDest, { recursive: true });
cpSync(wasmSrc, wasmDest, { recursive: true });
console.log("✓ Copied MediaPipe wasm files");

const modelPath = "public/mediapipe/face_landmarker.task";
if (!existsSync(modelPath)) {
  const url =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed: ${res.status}`);
  writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
  console.log("✓ Downloaded face_landmarker.task");
} else {
  console.log("✓ Face model already present");
}
