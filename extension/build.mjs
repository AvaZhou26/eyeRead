// Builds the extension into extension/dist and copies the MediaPipe files it needs.
// Usage (from read-assist/):  node extension/build.mjs
// esbuild is fetched by npx on first run (free, nothing added to package.json).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ext = dirname(fileURLToPath(import.meta.url));
const app = join(ext, "..");
const entries = ["content", "background", "popup", "offscreen", "permission"].map((n) => join(ext, "src", n + ".js"));

execFileSync(
  "npx",
  ["--yes", "esbuild@0.25.10", ...entries, "--bundle", "--format=iife", "--target=chrome120", `--outdir=${join(ext, "dist")}`, "--log-level=warning"],
  { stdio: "inherit", cwd: app },
);
console.log("✓ Bundled scripts → extension/dist");

// MediaPipe (only needed for eye tracking). Same files the web app serves from public/.
const mp = join(app, "public", "mediapipe");
if (!existsSync(join(mp, "face_landmarker.task"))) {
  console.warn("! public/mediapipe is missing — run `npm install` in read-assist/ first (eye tracking won't work without it).");
} else {
  mkdirSync(join(ext, "mediapipe", "wasm"), { recursive: true });
  cpSync(join(mp, "face_landmarker.task"), join(ext, "mediapipe", "face_landmarker.task"));
  for (const f of ["vision_wasm_internal.js", "vision_wasm_internal.wasm"]) cpSync(join(mp, "wasm", f), join(ext, "mediapipe", "wasm", f));
  console.log("✓ Copied MediaPipe face model + wasm → extension/mediapipe");
}
