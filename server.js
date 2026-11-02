// HTTP server: static page + async grading jobs (submit -> poll), no web framework.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createGrader, countWords, GradingError, MIN_WORDS } from "./grader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_WORDS = 1000;
const MAX_PROMPT_CHARS = 2000;
const MIN_WORDS_TO_GRADE = 30;
const JOB_TTL_MS = 30 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be valid JSON.");
  }
}

/** Validate and normalise the submission. Throws HttpError(400) with a user-facing message. */
export function parseSubmission(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Missing request body.");
  const task = Number(body.task);
  if (task !== 1 && task !== 2) throw new HttpError(400, "task must be 1 or 2.");

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw new HttpError(400, "Enter the question the response answers.");
  if (prompt.length > MAX_PROMPT_CHARS) throw new HttpError(400, "The question is too long.");

  const essay = typeof body.essay === "string" ? body.essay.trim() : "";
  const words = countWords(essay);
  if (words < MIN_WORDS_TO_GRADE) {
    throw new HttpError(400, `Write at least ${MIN_WORDS_TO_GRADE} words before submitting (the exam minimum is ${MIN_WORDS[task]}).`);
  }
  if (words > MAX_WORDS) throw new HttpError(400, `The response is over ${MAX_WORDS} words.`);

  let image = null;
  if (body.image != null && body.image !== "") {
    if (task !== 1) throw new HttpError(400, "A chart image is only used for Task 1.");
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image));
    if (!m) throw new HttpError(400, "The chart must be a PNG, JPEG, WebP or GIF image.");
    if (Math.floor((m[2].length * 3) / 4) > MAX_IMAGE_BYTES) throw new HttpError(400, "The chart image is over 5 MB.");
    image = { mediaType: m[1], data: m[2] };
  }
  return { task, prompt, essay, image };
}

/** Fixed-window per-IP limiter so a public deployment cannot drain the API key. */
function createLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

export function createApp({ grade = createGrader(), rateLimit = Number(process.env.RATE_LIMIT_PER_HOUR || 20) } = {}) {
  const jobs = new Map();
  const allow = createLimiter(rateLimit, 60 * 60 * 1000);

  const sweep = setInterval(() => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
  }, 5 * 60 * 1000);
  sweep.unref();

  function startJob(submission) {
    const id = crypto.randomUUID();
    const job = { id, status: "processing", createdAt: Date.now() };
    jobs.set(id, job);
    grade(submission)
      .then((result) => Object.assign(job, { status: "completed", result }))
      .catch((err) => {
        if (!(err instanceof GradingError)) console.error("grading failed:", err);
        Object.assign(job, {
          status: "failed",
          error: err instanceof GradingError ? err.message : "Something went wrong while grading.",
          code: err instanceof GradingError ? err.code : "internal",
        });
      });
    return id;
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === "/" ? "/index.html" : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, "Not found.");
    try {
      const data = await fs.readFile(file);
      send(res, 200, data, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    } catch {
      throw new HttpError(404, "Not found.");
    }
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const { pathname } = url;

      if (req.method === "GET" && pathname === "/api/health") {
        return send(res, 200, {
          ok: true,
          credentials: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
        });
      }
      if (req.method === "POST" && pathname === "/api/grade") {
        const ip = req.socket.remoteAddress || "unknown";
        if (!allow(ip)) throw new HttpError(429, "Too many submissions. Please try again later.");
        const submission = parseSubmission(await readJson(req));
        return send(res, 202, { jobId: startJob(submission) });
      }
      const m = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(pathname);
      if (req.method === "GET" && m) {
        const job = jobs.get(m[1]);
        if (!job) throw new HttpError(404, "Unknown or expired job.");
        const { id, status, result, error, code } = job;
        return send(res, 200, { id, status, result, error, code });
      }
      if (req.method === "GET" && !pathname.startsWith("/api/")) return await serveStatic(res, pathname);
      throw new HttpError(404, "Not found.");
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: "Internal server error." });
    }
  };

  return http.createServer(handler);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    const ready = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    console.log(`IELTS writing rater on http://localhost:${port}`);
    if (!ready) console.warn("Warning: ANTHROPIC_API_KEY is not set; grading requests will fail until it is.");
  });
}
