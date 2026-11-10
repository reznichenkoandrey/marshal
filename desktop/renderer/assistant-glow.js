// desktop/renderer/assistant-glow.js — main sends "listening" or "speaking" (#285).
const frame = document.getElementById("frame");
window.marshalAssistant.onState((_event, view) => {
  frame.dataset.state = view.state === "speaking" ? "speaking" : "listening";
});
