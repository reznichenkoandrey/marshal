// Floating toolbar renderer. Every button is just a hot link to a main-side
// IPC handler. The toolbar holds no state of its own except for the
// recording-toggled visual, which it learns from the same recording-paused
// channel the indicator window listens on.

const api = window.marshalToolbar;
const btnArea = document.getElementById("btn-area");
const btnFullscreen = document.getElementById("btn-fullscreen");
const btnRecord = document.getElementById("btn-record");
const btnGif = document.getElementById("btn-gif");
const btnHistory = document.getElementById("btn-history");
const btnClose = document.getElementById("btn-close");
const iconIdle = document.getElementById("record-icon-idle");
const iconStop = document.getElementById("record-icon-stop");

if (!api) {
  document.body.textContent = "Toolbar API unavailable.";
} else {
  btnArea?.addEventListener("click", () => void api.captureArea());
  btnFullscreen?.addEventListener("click", () => void api.captureFullscreen());
  btnRecord?.addEventListener("click", () => void api.toggleRecording());
  btnGif?.addEventListener("click", () => void api.openGifConverter());
  btnHistory?.addEventListener("click", () => void api.openHistory());
  btnClose?.addEventListener("click", () => void api.close());

  // Keep the record button in sync with the actual recorder state.
  api.onRecordingState((_event, payload) => setRecording(Boolean(payload?.recording)));

  void api.pollRecordingState().then((state) => setRecording(Boolean(state?.recording)));
}

function setRecording(isRecording) {
  if (!btnRecord) return;
  btnRecord.classList.toggle("recording", isRecording);
  iconIdle?.classList.toggle("hidden", isRecording);
  iconStop?.classList.toggle("hidden", !isRecording);
  btnRecord.title = isRecording ? "Stop recording" : "Start recording (⌘⌥6)";
}
