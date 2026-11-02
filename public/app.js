const $ = (id) => document.getElementById(id);
const MIN_WORDS = { 1: 150, 2: 250 };
const POLL_MS = 2000;
const POLL_LIMIT_MS = 4 * 60 * 1000;

const els = {
  form: $("form"), prompt: $("prompt"), essay: $("essay"), count: $("count"), chart: $("chart"),
  chartField: $("chart-field"), preview: $("chart-preview"), submit: $("submit"), notice: $("notice"),
  progress: $("progress"), result: $("result"),
};
let chartDataUrl = "";

const selectedTask = () => Number(document.querySelector('input[name="task"]:checked').value);
const wordCount = (s) => (s.trim().match(/\S+/g) || []).length;

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = !message;
}

function updateCount() {
  const n = wordCount(els.essay.value);
  const min = MIN_WORDS[selectedTask()];
  els.count.textContent = n < min ? `${n} words (the exam minimum is ${min})` : `${n} words`;
}

function updateTask() {
  els.chartField.hidden = selectedTask() !== 1;
  updateCount();
}

els.essay.addEventListener("input", updateCount);
document.querySelectorAll('input[name="task"]').forEach((r) => r.addEventListener("change", updateTask));

els.chart.addEventListener("change", () => {
  const file = els.chart.files[0];
  chartDataUrl = "";
  els.preview.hidden = true;
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showNotice("The chart image is over 5 MB. Choose a smaller file.");
    els.chart.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    chartDataUrl = String(reader.result);
    els.preview.src = chartDataUrl;
    els.preview.hidden = false;
    showNotice("");
  };
  reader.readAsDataURL(file);
});

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function list(items) {
  const ul = document.createElement("ul");
  items.forEach((t) => ul.append(el("li", t)));
  return ul;
}

function renderResult(r) {
  $("overall").textContent = r.overall.toFixed(1);
  $("summary").textContent = r.summary;
  const note = $("length-note");
  note.hidden = !r.underLength;
  if (r.underLength) {
    note.textContent = `Your response is ${r.wordCount} words, below the ${MIN_WORDS[r.task]}-word minimum. Real examiners penalise this.`;
  }

  const box = $("criteria");
  box.replaceChildren();
  r.criteria.forEach((c) => {
    const card = el("article", null, "criterion");
    const head = document.createElement("header");
    head.append(el("h3", c.name), el("span", c.band.toFixed(1), "score"));
    card.append(head, el("p", c.comment));
    if (c.strengths.length) card.append(el("h4", "Strengths"), list(c.strengths));
    if (c.improvements.length) card.append(el("h4", "To improve"), list(c.improvements));
    box.append(card);
  });

  const errs = $("errors");
  errs.replaceChildren();
  if (!r.keyErrors.length) errs.append(el("li", "No specific errors were flagged."));
  r.keyErrors.forEach((e) => {
    const li = document.createElement("li");
    const quote = document.createElement("q");
    quote.textContent = e.quote;
    li.append(el("span", e.category, "tag"), document.createElement("br"), quote, el("div", e.issue), el("div", `Try: ${e.suggestion}`, "fix"));
    errs.append(li);
  });
}

function setBusy(busy) {
  els.submit.disabled = busy;
  els.progress.hidden = !busy;
  if (busy) els.result.hidden = true;
}

async function poll(jobId) {
  const started = Date.now();
  while (Date.now() - started < POLL_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await fetch(`/api/jobs/${jobId}`);
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "Lost track of the grading job.");
    if (job.status === "completed") return job.result;
    if (job.status === "failed") throw new Error(job.error || "Grading failed.");
  }
  throw new Error("Grading is taking too long. Please try again.");
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showNotice("");
  const task = selectedTask();
  const body = { task, prompt: els.prompt.value, essay: els.essay.value, image: task === 1 ? chartDataUrl : "" };
  if (!body.prompt.trim()) return showNotice("Enter the question first.");
  if (wordCount(body.essay) < 30) return showNotice("Write at least 30 words before submitting.");

  setBusy(true);
  try {
    const res = await fetch("/api/grade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not submit.");
    renderResult(await poll(data.jobId));
    els.result.hidden = false;
    els.result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showNotice(err.message);
  } finally {
    setBusy(false);
  }
});

$("again").addEventListener("click", () => {
  els.result.hidden = true;
  els.form.scrollIntoView({ behavior: "smooth" });
});

fetch("/api/health").then((r) => r.json()).then((h) => {
  if (!h.credentials) showNotice("The server has no Anthropic API key configured yet. Grading will fail until ANTHROPIC_API_KEY is set.");
}).catch(() => {});

updateTask();
