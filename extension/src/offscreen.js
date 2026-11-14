// Offscreen document (reason USER_MEDIA): runs the web app's FaceTracker on the webcam
// and streams compact eye-feature frames to the service worker.
//
// Offscreen documents are never visible, and Chrome may not run requestAnimationFrame
// for hidden documents, so FaceTracker's rAF loop is driven by a ~30 fps timer instead.
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 33);
window.cancelAnimationFrame = (id) => clearTimeout(id);

import { FaceTracker } from "../../src/lib/gaze/faceTracker";

let tracker = null;
let unsub = null;
let watchdog = 0;

async function start() {
  if (tracker) return { ok: true };
  try {
    // Check permission first: an offscreen document can't show the camera prompt.
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    probe.getTracks().forEach((t) => t.stop());
  } catch (e) {
    const name = e?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError") return { ok: false, error: "permission" };
    return { ok: false, error: "camera", message: `${name}: ${e?.message || e}` };
  }
  try {
    tracker = new FaceTracker();
    const video = document.getElementById("cam");
    await tracker.start(video);
    let frames = 0;
    unsub = tracker.subscribe((f) => {
      frames++;
      chrome.runtime
        .sendMessage({
          type: "eye:frame",
          frame: { t: f.t, face: f.face, blink: f.blink, features: f.features },
        })
        .catch(() => {});
    });
    // If no frame arrives within 8 s, video decoding is probably paused in this hidden page.
    watchdog = setTimeout(() => {
      if (frames === 0) {
        chrome.runtime.sendMessage({ type: "eye:error", message: "The camera started but no video frames reached the face tracker (offscreen video may be paused by Chrome)." }).catch(() => {});
        stop();
      }
    }, 8000);
    return { ok: true };
  } catch (e) {
    stop();
    return { ok: false, error: "tracker", message: String(e?.message || e) };
  }
}

function stop() {
  clearTimeout(watchdog);
  unsub?.();
  unsub = null;
  tracker?.stop();
  tracker = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start") {
    start().then(sendResponse);
    return true;
  }
  if (msg.type === "stop") {
    stop();
    sendResponse({ ok: true });
  }
});
