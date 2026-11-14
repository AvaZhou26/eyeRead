# Gaze tracker evaluation: current pipeline vs WebEyeTrack

**Status (2026-11-14): WebEyeTrack is now the reader's default gaze engine.** This was your call after watching it live: you found the hybrid lost accuracy over time. The numbers from the single lab run are below. They show WebEyeTrack better horizontally and worse vertically; keep an eye on line-level accuracy in real sessions. To switch back to MediaPipe + ridge, set `NEXT_PUBLIC_GAZE_ENGINE=mediapipe` or open the reader with `?gaze=mediapipe`.

## WebEyeTrack: what it is and what it needs

| | |
|---|---|
| Repo | github.com/RedForestAI/WebEyeTrack (paper: arXiv 2508.19544) |
| License | MIT (both the repo and the npm package): free to use, keep the attribution |
| npm | `webeyetrack@0.0.2`, published about a year ago. The repo's `main` branch is newer and unpublished (it adds a `baseUrl` option and async `adapt`) |
| Package | One 2.7 MB UMD bundle that includes its own TF.js 4.22 and MediaPipe JS. `node_modules/webeyetrack` with its declared deps is about 36 MB on disk. It's only loaded on `/gaze-lab`, through a dynamic import |
| Model | BlazeGaze Keras→TF.js LayersModel: `model.json` (45 KB) plus one 624 KB weights shard, copied into `public/web/`. The npm build loads it from the hard-coded path `/web/model.json` |
| Browser | WebGL (TF.js) plus WebAssembly (MediaPipe). Runs on the main thread or in a Worker |
| Cost per frame | About 17 ms median (p90 25 ms) for **two** instances on one 1280×720 frame, measured in the Claude pane on this Mac. That covers the eye-patch warp, BlazeGaze and a Kalman filter; MediaPipe is shared with our tracker |
| Calibration | `adapt()` fits a 2×3 affine on BlazeGaze's outputs, then runs N Adam steps (lr 1e-5) on the gaze MLP. With 52 support frames, 5 steps took about 14 s in a throttled pane, so the lab defaults to the library's 1 step |

**Problems with using the package as shipped** (the lab works around all of them):
- `WebEyeTrackProxy` opens its **own camera stream at 640×480**.
- It loads the MediaPipe wasm from **cdn.jsdelivr.net (v0.10.3)** and the face model from Google storage at runtime.
- It adds a global `window` click listener that **recalibrates on every click**. In the reader that would retrain the model on every button press.

The lab avoids these by running the `WebEyeTrack` class directly and swapping its private `faceLandmarkerClient` for a shim that returns the MediaPipe result our `FaceTracker` already computed. So the face mesh runs once per frame, at 1280×720, with no CDN. This relies on a private field, so pin `0.0.2`.

**Prior expectation:** The paper's headline of about 2.3 cm error comes from GazeCapture (phones and tablets, close to the camera). On a MacBook (about 50 CSS px/cm), 2.3 cm is about 115 px, or about 80 px vertically. That's about 2 lines at 40 px, roughly what the app already calls "good" (under 140 px, under 2.2 lines). At laptop distance (50–60 cm) the error in cm is likely larger. So a big win isn't guaranteed. It has to be measured.

## How to run the comparison (about 2 minutes)

1. `npm run dev`, then open **http://localhost:3000/gaze-lab** in Chrome on the MacBook (not in the Claude pane: it blocks the camera).
2. Sit as you would to read, click Begin, then look at and click 13 dots. Five validation dots follow on their own.
3. Press **Validate again** 2–3 times over a few minutes. Each round reuses the same calibration, so later rounds also show drift.
4. Press **Copy JSON** and paste the numbers into the table below.

All four methods are fitted from the **same camera frames** on the same 13 dots and scored on the same validation frames:

| Method | What it is |
|---|---|
| Current | MediaPipe iris/head features → `GazeModel` ridge (exactly what the reader uses today) |
| WebEyeTrack (its own adapt) | BlazeGaze plus the library's affine and fine-tune calibration |
| WebEyeTrack raw + our ridge | Uncalibrated BlazeGaze output → small quadratic ridge |
| Hybrid | Our 14 features plus raw BlazeGaze x/y → `GazeModel` ridge |

Metrics: **dot-averaged** mean error and |dy| (the same as the app's calibration check), dy in **lines** (÷ line height, default 40 px), signed vertical bias, and **per-frame median |dy|**, which is closer to what the line HMM sees.

## Results

Run 1: 2026-11-14, MacBook Pro, Chrome 151 (Opera), viewport 1683×884 @2x, camera 1280×720 at 30 fps, WebEyeTrack 30 fps, 325 calibration frames, adapt steps 1, line height 40 px. One validation round.

| Method | Mean err px | Vertical px | Vertical lines | Vertical bias px | Per-frame lines |
|---|---|---|---|---|---|
| Current | 168 | 68 | 1.70 | +67 | 0.88 |
| WebEyeTrack (adapt) | 143 | 90 | 2.25 | +26 | 2.54 |
| WebEyeTrack raw + ridge | 142 | 79 | 1.97 | +30 | 1.81 |
| **Hybrid** | **135** | **59** | **1.46** | +59 | **0.67** |

How to read this:
- **The reader removes a constant vertical offset.** `lineHmm.adaptBias` and the first-line offset learning in `readingTracker` do this. For Current and Hybrid, vertical error ≈ vertical bias (68 vs 67, 59 vs 59): all 5 dots landed about the same distance too low, which the HMM corrects within seconds. For WebEyeTrack, |dy| (90) is far larger than its bias (26), so most of its vertical error is dot-to-dot scatter that offset correction can't fix. Its per-frame vertical error (2.5 lines) is also much noisier. **For line-level tracking, WebEyeTrack alone is a clear step down from the current pipeline.**
- WebEyeTrack's lower *total* error comes from the horizontal direction. That is likely why its live dot *looked* better, but horizontal position matters much less to the line HMM.
- Hybrid against Current: −20% total error, −14% vertical (dot-averaged), −24% per-frame vertical. That's consistent but under the 25% bar, and n is one round.

## What shipped

- **Engine flag:** `gazeEngine()` in `src/lib/gaze/webEyeTrackSource.ts`. The default is `"webeyetrack"`. `NEXT_PUBLIC_GAZE_ENGINE=mediapipe` or the URL param `?gaze=mediapipe` switches back.
- **Loading:** `ReaderApp` loads WebEyeTrack, one instance, alongside the camera. It runs on each FaceTracker frame through `subscribeRaw`. If it fails to load, the reader silently falls back to MediaPipe + ridge.
- **Calibration** (`Calibration.tsx`, same 13 + 5 dots):
  - In WebEyeTrack mode, it stores up to 4 eye-patch frames per dot and calls `reset()` then `adapt()` (affine + 1 MLP step) right after the 13th dot. The screen shows "Tuning the eye tracker to you…".
  - The 5 validation dots then score WebEyeTrack's live output. That gives the usual quality rating, and `sigmaY` for the HMM, as before.
  - Recalibrating from inside the reader also works.
- **Interface:** `CalibrationResult` now carries a `GazeEstimator` (`predict(FaceFrame) → point | null`) instead of the ridge model. `ReaderView` calls `estimator.predict(f)`. The line HMM, the bias learning and `readingTracker` are unchanged.
- **Cost:** about 8 ms per frame on the main thread, plus a one-time ~2.7 MB script and a 0.67 MB model. Both are only fetched when the camera starts.
- **Verified:**
  - `npx tsc --noEmit` and `npx eslint src` pass.
  - In the browser with a fake camera: the reader's camera setup loads WebEyeTrack, and calibration collected WebEyeTrack samples at 30 fps for dots 1–12.
  - The pane then throttled to 1 frame/s while hidden, so adapt, validation and reading with WebEyeTrack weren't exercised end-to-end in the reader. adapt itself was exercised in the lab.

## Files touched

- `src/app/gaze-lab/page.tsx`, `src/components/lab/GazeLab.tsx`: the side-by-side lab. `?fakeImage=/some-face.jpg`, with the image in `public/`, runs it on a still photo for a smoke test with no camera.
- `src/lib/gaze/webEyeTrackSource.ts`: WebEyeTrack wrapper (two instances, MediaPipe shim, adapt).
- `src/lib/gaze/faceTracker.ts`: new `subscribeRaw()` hook (the raw MediaPipe result per frame). Existing behaviour is unchanged.
- `src/components/reader/Calibration.tsx`: `CAL_POINTS` and `VAL_POINTS` are now exported (no behaviour change).
- `package.json` / `package-lock.json`: `webeyetrack@0.0.2` (exact).
- `public/web/model.json` and `public/web/group1-shard1of1.bin`: BlazeGaze weights from the repo's example app.
