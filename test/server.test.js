import test from "node:test";
import assert from "node:assert/strict";
import { createApp, parseSubmission } from "../server.js";
import { GradingError } from "../grader.js";

const words = (n) => "word ".repeat(n).trim();
const good = { task: 2, prompt: "Discuss both views.", essay: words(40) };

test("parseSubmission rejects bad input with clear messages", () => {
  assert.throws(() => parseSubmission({ ...good, task: 3 }), /task must be 1 or 2/);
  assert.throws(() => parseSubmission({ ...good, prompt: " " }), /question/);
  assert.throws(() => parseSubmission({ ...good, essay: words(5) }), /at least 30 words/);
  assert.throws(() => parseSubmission({ ...good, essay: words(1001) }), /over 1000/);
  assert.throws(() => parseSubmission({ ...good, image: "data:image/png;base64,AAAA" }), /only used for Task 1/);
  assert.throws(() => parseSubmission({ ...good, task: 1, image: "data:text/html;base64,AAAA" }), /PNG, JPEG/);
  assert.deepEqual(parseSubmission({ ...good, task: 1, image: "data:image/png;base64,AAAA" }).image, { mediaType: "image/png", data: "AAAA" });
});

async function withServer(grade, fn, opts = {}) {
  const server = createApp({ grade, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const post = (base, body) => fetch(`${base}/api/grade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function waitFor(base, jobId) {
  for (let i = 0; i < 50; i++) {
    const job = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
    if (job.status !== "processing") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job never finished");
}

test("submit then poll returns the completed result", async () => {
  await withServer(async (s) => ({ overall: 7, echoedTask: s.task }), async (base) => {
    const res = await post(base, good);
    assert.equal(res.status, 202);
    const { jobId } = await res.json();
    const job = await waitFor(base, jobId);
    assert.equal(job.status, "completed");
    assert.deepEqual(job.result, { overall: 7, echoedTask: 2 });
  });
});

test("a GradingError becomes a failed job with its message; other errors are masked", async () => {
  await withServer(async () => { throw new GradingError("The grader is busy.", "rate_limited"); }, async (base) => {
    const { jobId } = await (await post(base, good)).json();
    const job = await waitFor(base, jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.error, "The grader is busy.");
  });
  const origError = console.error;
  console.error = () => {};
  try {
    await withServer(async () => { throw new Error("secret internals"); }, async (base) => {
      const { jobId } = await (await post(base, good)).json();
      const job = await waitFor(base, jobId);
      assert.equal(job.status, "failed");
      assert.doesNotMatch(job.error, /secret/);
    });
  } finally { console.error = origError; }
});

test("validation errors return 400, unknown jobs 404, and the limiter returns 429", async () => {
  await withServer(async () => ({}), async (base) => {
    assert.equal((await post(base, { ...good, essay: "short" })).status, 400);
    assert.equal((await fetch(`${base}/api/jobs/00000000-0000-0000-0000-000000000000`)).status, 404);
    assert.equal((await post(base, good)).status, 202);
    assert.equal((await post(base, good)).status, 429);
  }, { rateLimit: 2 });
});

test("static files are served and path traversal is refused", async () => {
  await withServer(async () => ({}), async (base) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /IELTS Writing Rater/);
    const evil = await fetch(`${base}/..%2Fpackage.json`);
    assert.equal(evil.status, 404);
  });
});
