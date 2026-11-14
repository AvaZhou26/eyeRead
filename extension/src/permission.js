// A visible extension page whose only job is to show Chrome's camera prompt once,
// so the hidden offscreen document is allowed to use the camera afterwards.
const status = document.getElementById("status");
document.getElementById("allow").addEventListener("click", async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach((t) => t.stop());
    status.textContent = "Camera allowed. You can close this tab, go back to the article and press “Try again”.";
    status.className = "ok";
  } catch (e) {
    status.textContent = `Camera not allowed (${e.name}). If you blocked it, click the camera icon in the address bar to allow it.`;
    status.className = "err";
  }
});
