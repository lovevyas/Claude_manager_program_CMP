# IELTS Writing Rater

A small web app that gives a practice band estimate for IELTS Writing Task 1 and Task 2. A candidate pastes their response (and optionally the Task 1 chart image). The server asks Claude to assess it on the four public IELTS criteria and returns band scores with specific feedback.

This is an independent implementation. It is not affiliated with IELTS or any commercial rating service, and its scores are AI estimates, not official results.

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or copy .env.example and load it yourself
npm start                              # http://localhost:3000
npm test                               # 12 tests, no network or API key needed
```

Requires Node.js 22 or newer. Configuration (port, model, rate limit) is in `.env.example`.

## How it works

1. The page POSTs `{ task, prompt, essay, image? }` to `/api/grade`. The server validates it and returns `202 { jobId }` immediately.
2. The server grades in the background. `grader.js` sends the response (and the chart image for Task 1) to Claude with an examiner system prompt and a Zod schema, so the result always has the same structure: a band, comment, strengths and improvements for each of the four criteria, plus a list of key errors with corrections.
3. The page polls `GET /api/jobs/:id` until the job is `completed` or `failed`.
4. The overall band is computed in code from the four criterion bands (mean, rounded to the nearest half band), never taken from the model. Criterion bands are clamped to 0-9 in half bands.

| Criterion | Task 1 | Task 2 |
|---|---|---|
| 1 | Task Achievement | Task Response |
| 2 | Coherence & Cohesion | Coherence & Cohesion |
| 3 | Lexical Resource | Lexical Resource |
| 4 | Grammatical Range & Accuracy | Grammatical Range & Accuracy |

## Safeguards

- The candidate's text is fenced in tags and the system prompt tells the model to treat it as data, so instructions hidden in an essay are not followed.
- All model output is rendered with `textContent`, never as HTML.
- Per-IP rate limit, 8 MB request cap, 5 MB image cap, 1000-word cap, image type allow-list.
- Refusals, truncation and unreadable output become clear error messages; unexpected errors are logged server-side and masked in the response.
- The server-side refusal fallback (`fallbacks: "default"`) is on by default; set `GRADER_FALLBACKS=off` to disable it.

## Limits to know about

- Jobs live in memory and expire after 30 minutes, so restarting the server loses pending results. Use a database or queue if you need persistence or several instances.
- The scores are not calibrated against official examiners. Before offering this to learners, compare its bands with scored sample essays and adjust the rubric in `grader.js`.
- The in-memory rate limiter is per process and keyed on the socket address. Behind a proxy, put real limits at the proxy.
- There are no user accounts or saved history.
