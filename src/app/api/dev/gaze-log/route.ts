// Development only: the reader posts its gaze-tracking internals here while you read, and they
// are appended to data/gaze-debug.jsonl so the tracker can be diagnosed from real sessions.
// Numbers only (gaze points, line positions, learned corrections): no video, no text.
// Disabled in production builds.
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

const FILE = path.join(process.cwd(), "data", "gaze-debug.jsonl");
const MAX_BODY = 2_000_000;
// The log grows by roughly 30 MB per hour of reading. Past this size it is set aside as
// gaze-debug.old.jsonl (replacing the previous one) and a fresh file is started, so a dev
// machine never holds more than about twice this.
const MAX_FILE = 100_000_000;

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const text = await req.text();
  if (text.length > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return Response.json({ error: "bad JSON" }, { status: 400 });
  }
  if (!Array.isArray(rows)) return Response.json({ error: "expected an array" }, { status: 400 });
  await mkdir(path.dirname(FILE), { recursive: true });
  const size = await stat(FILE).then((s) => s.size, () => 0);
  if (size > MAX_FILE) await rename(FILE, FILE.replace(/\.jsonl$/, ".old.jsonl")).catch(() => {});
  await appendFile(FILE, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  return Response.json({ ok: true, rows: rows.length });
}
