import test from "node:test";
import assert from "node:assert/strict";
import { toBand, overallBand, normalize, countWords, createGrader, GradingError, MIN_WORDS } from "../grader.js";

const criterion = (band) => ({ band, comment: "c", strengths: ["s"], improvements: ["i"] });
const raw = (a, b, c, d) => ({
  task_achievement: criterion(a),
  coherence_cohesion: criterion(b),
  lexical_resource: criterion(c),
  grammatical_range: criterion(d),
  summary: "sum",
  key_errors: [],
});

test("toBand rounds to half bands and clamps to 0-9", () => {
  assert.equal(toBand(6.74), 6.5);
  assert.equal(toBand(6.75), 7);
  assert.equal(toBand(9.7), 9);
  assert.equal(toBand(-2), 0);
  assert.equal(toBand("x"), 0);
});

test("overall band follows the IELTS rounding rule (.25 up to .5, .75 up to the next whole)", () => {
  assert.equal(overallBand([6, 6, 6, 7]), 6.5); // mean 6.25
  assert.equal(overallBand([7, 7, 7, 6]), 7); // mean 6.75
  assert.equal(overallBand([6, 6, 6, 6]), 6);
  assert.equal(overallBand([5, 6, 6, 6]), 6); // mean 5.75
});

test("normalize names the first criterion by task and ignores any model-supplied overall", () => {
  const r1 = normalize({ ...raw(7, 7, 7, 6), overall: 9 }, 1, 160);
  const r2 = normalize(raw(7, 7, 7, 6), 2, 260);
  assert.equal(r1.criteria[0].name, "Task Achievement");
  assert.equal(r2.criteria[0].name, "Task Response");
  assert.equal(r1.overall, 7);
  assert.equal(r1.underLength, false);
});

test("normalize flags under-length responses per task", () => {
  assert.equal(normalize(raw(6, 6, 6, 6), 1, MIN_WORDS[1] - 1).underLength, true);
  assert.equal(normalize(raw(6, 6, 6, 6), 2, MIN_WORDS[2] - 1).underLength, true);
  assert.equal(normalize(raw(6, 6, 6, 6), 2, MIN_WORDS[2]).underLength, false);
});

test("countWords counts whitespace-separated words", () => {
  assert.equal(countWords("  one  two\nthree "), 3);
  assert.equal(countWords(""), 0);
});

function stubClient(response) {
  const calls = [];
  return { calls, beta: { messages: { parse: async (req) => (calls.push(req), response) } } };
}

const submission = { task: 1, prompt: "Describe the chart.", essay: "word ".repeat(40), image: { mediaType: "image/png", data: "AAAA" } };

test("grader sends the image, the fenced candidate text and structured output config", async () => {
  const client = stubClient({ stop_reason: "end_turn", parsed_output: raw(7, 7, 6, 6) });
  const result = await createGrader(client)(submission);
  const req = client.calls[0];
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.messages[0].content[0].type, "image");
  assert.match(req.messages[0].content[1].text, /<candidate_response>/);
  assert.ok(req.output_config.format);
  assert.equal(req.fallbacks, "default");
  assert.equal(result.overall, 6.5);
});

test("grader surfaces refusals, truncation and unparseable output as GradingError", async () => {
  for (const [response, code] of [
    [{ stop_reason: "refusal", parsed_output: null }, "refusal"],
    [{ stop_reason: "max_tokens", parsed_output: null }, "truncated"],
    [{ stop_reason: "end_turn", parsed_output: null }, "unparseable"],
  ]) {
    await assert.rejects(createGrader(stubClient(response))(submission), (e) => e instanceof GradingError && e.code === code);
  }
});
