// Deck renderer (#277). Main owns the deck and pushes its whole state on every
// change; this window draws it and sends intents: build, present, export,
// close. Each slide is a full document shown in a sandboxed frame with no
// scripts. No timers.

const api = window.marshalDecks;
const t = (key, params) => window.MarshalI18n?.t(key, params) ?? key;
const $ = (id) => document.getElementById(id);

const title = $("deck-title");
const statusChip = $("deck-status");
const counter = $("counter");
const errorLine = $("error");
const empty = $("empty");
const body = $("body");
const rail = $("rail");
let frame = $("frame");
const notes = $("notes");
const words = $("words");

let state = { status: "empty", id: null, title: "", slides: [], partial: null, error: null, presenting: false };
let selected = 1;
// While a deck builds the view follows the newest slide, until the owner picks one.
let following = true;
let shownDocument = null;

function builtCount() {
  return state.slides.filter((slide) => slide.document).length;
}

function errorText() {
  if (!state.error) return "";
  if (state.error === "no-model") return t("deck.error.noModel");
  if (state.error === "no-slides") return t("deck.error.noSlides");
  return t("deck.error.stopped", { reason: state.error });
}

function show(index) {
  selected = Math.min(Math.max(index, 1), Math.max(state.slides.length, 1));
  draw();
}

function draw() {
  const hasSlides = state.slides.length > 0;
  document.body.dataset.presenting = String(state.presenting && hasSlides);
  title.textContent = state.title || t("deck.title");
  empty.classList.toggle("hidden", hasSlides);
  body.classList.toggle("hidden", !hasSlides);

  const error = errorText();
  errorLine.textContent = error;
  errorLine.classList.toggle("hidden", !error);

  const chip = { building: ["deck.status.building", "warn"], ready: ["deck.status.ready", "ok"] }[state.status];
  statusChip.classList.toggle("hidden", !chip);
  if (chip) {
    statusChip.textContent = t(chip[0]);
    statusChip.dataset.tone = chip[1];
  }

  const slide = state.slides[selected - 1];
  const growing = state.partial && state.partial.index === selected ? state.partial.document : null;
  const documentHtml = slide?.document ?? growing ?? "";
  if (documentHtml !== shownDocument) {
    shownDocument = documentHtml;
    // A fresh frame per document: a second srcdoc in the same sandboxed frame sometimes never paints.
    const next = frame.cloneNode(false);
    next.srcdoc = documentHtml;
    frame.replaceWith(next);
    frame = next;
  }
  notes.textContent = slide?.notes ?? "";
  counter.textContent = hasSlides ? t("deck.slideOf", { n: selected, total: state.slides.length }) : "";

  rail.replaceChildren(
    ...state.slides.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.built = String(Boolean(item.document));
      if (index + 1 === selected) button.setAttribute("aria-current", "true");
      const number = document.createElement("span");
      number.className = "n";
      number.textContent = String(index + 1);
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label || t("deck.pending");
      button.append(number, label);
      button.addEventListener("click", () => {
        following = false;
        show(index + 1);
      });
      const row = document.createElement("li");
      row.append(button);
      return row;
    })
  );

  const exportable = builtCount() > 0 && state.status !== "building";
  $("prev-btn").disabled = selected <= 1;
  $("next-btn").disabled = selected >= state.slides.length;
  $("present-btn").disabled = builtCount() === 0;
  $("html-btn").disabled = !exportable;
  $("pdf-btn").disabled = !exportable;
  $("build-btn").disabled = state.status === "building";
}

function step(delta) {
  following = false;
  show(selected + delta);
}

async function exportDeck(format) {
  const result = await api.exportDeck(format);
  if (result?.error) {
    errorLine.textContent = t("deck.error.export", { reason: result.error });
    errorLine.classList.remove("hidden");
  }
}

api.onState((_event, next) => {
  const sameDeck = next.id === state.id;
  state = next;
  if (!sameDeck) {
    following = true;
    selected = 1;
  }
  if (following && state.status === "building") {
    selected = Math.max(1, state.partial ? state.partial.index : builtCount());
  }
  show(selected);
});

$("ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = words.value.trim();
  if (!text) return;
  api.build(text);
  words.value = "";
});
$("prev-btn").addEventListener("click", () => step(-1));
$("next-btn").addEventListener("click", () => step(1));
$("present-btn").addEventListener("click", () => api.present(true));
$("html-btn").addEventListener("click", () => exportDeck("html"));
$("pdf-btn").addEventListener("click", () => exportDeck("pdf"));
$("close-btn").addEventListener("click", () => api.close());

document.addEventListener("keydown", (event) => {
  if (event.target === words) return;
  if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
    event.preventDefault();
    step(1);
  } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
    event.preventDefault();
    step(-1);
  } else if (event.key === "Escape" && state.presenting) {
    api.present(false);
  }
});

window.MarshalIcons?.apply();
window.addEventListener("marshal:language", draw);
draw();
