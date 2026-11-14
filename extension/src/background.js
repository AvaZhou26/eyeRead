// Service worker: owns the offscreen camera document and relays gaze frames
// from it to the one tab that asked for eye tracking.
let eyeTabId = null;

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Webcam eye tracking (on-device) to measure which parts of an article were read.",
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

const toTab = (msg) => eyeTabId != null && chrome.tabs.sendMessage(eyeTabId, msg).catch(() => {});

async function stopEye() {
  toTab({ type: "eye:status", status: "stopped" });
  eyeTabId = null;
  await closeOffscreen().catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "eye:start": {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      (async () => {
        if (eyeTabId != null && eyeTabId !== tabId) toTab({ type: "eye:status", status: "stopped" });
        eyeTabId = tabId;
        try {
          await ensureOffscreen();
          const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "start" });
          if (res?.ok) toTab({ type: "eye:status", status: "started" });
          else if (res?.error === "permission") {
            toTab({ type: "eye:status", status: "need-permission" });
            await closeOffscreen();
            chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
          } else {
            toTab({ type: "eye:status", status: "error", error: res?.message || "Camera failed to start" });
            await closeOffscreen();
          }
        } catch (e) {
          toTab({ type: "eye:status", status: "error", error: String(e?.message || e) });
        }
      })();
      sendResponse({ ok: true });
      return;
    }
    case "eye:stop":
      stopEye();
      sendResponse({ ok: true });
      return;
    case "eye:frame":
      // From the offscreen document.
      toTab(msg);
      return;
    case "eye:error":
      toTab({ type: "eye:status", status: "error", error: msg.message });
      stopEye();
      return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === eyeTabId) stopEye();
});
