// Play a recorded reading session back through the line tracker and print what it did.
//
//   npx tsx scripts/replay.ts recording.json            what the tracker made of the session
//   npx tsx scripts/replay.ts recording.json --linear   also score it, for a recording where
//                                                       you read every page once, top to
//                                                       bottom, at an even pace
//   npx tsx scripts/replay.ts a.json b.json --linear    several recordings, one summary each
//
// Options to try a different tuning without touching the code:
//   --sigma=90        how much vertical scatter the line model expects (px)
//   --no-aligned      pretend the reading calibration wasn't done
//
// Make a recording in the reader: open it with ?record=1 in the address bar (or switch on
// "Record eye data" in the gear menu), read, then click "Save eye data". See TESTING.md.
import { readFileSync } from "node:fs";
import { replay, type GazeRecording } from "../src/lib/gaze/recorder";
import type { TrackerOptions } from "../src/lib/gaze/readingTracker";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

if (!files.length) {
  console.error("Usage: npx tsx scripts/replay.ts <recording.json> [--linear] [--sigma=90] [--no-aligned]");
  process.exit(1);
}

const pct = (x: number | undefined) => (x === undefined ? "   –" : `${Math.round(x * 100)}%`.padStart(4));
const options: Partial<TrackerOptions> = {};
if (value("sigma")) options.sigmaY = Number(value("sigma"));
if (flag("no-aligned")) options.alignedByReading = false;

for (const file of files) {
  const rec = JSON.parse(readFileSync(file, "utf8")) as GazeRecording;
  if (rec.version !== 1 || !Array.isArray(rec.events)) {
    console.error(`${file}: not a Read Assist recording`);
    continue;
  }
  const res = replay(rec, { assumeLinear: flag("linear"), options });
  const o = { ...rec.options, ...options };
  const minutes = (rec.endT - rec.t0) / 60;

  console.log(`\n=== ${file} ===`);
  console.log(`recorded ${rec.createdAt} · ${minutes.toFixed(1)} min · ${res.frames} frames (${res.gazeFrames} with gaze)`);
  console.log(`line height ${o.lineHeight}px · sigmaY ${Math.round(o.sigmaY)}px · ${o.alignedByReading ? "reading-calibrated" : "dots only"} · ${o.secPerWord ? `${Math.round(60 / o.secPerWord)} wpm (own pace)` : "240 wpm (assumed)"}`);
  if (Object.keys(rec.meta).length) console.log(`meta: ${JSON.stringify(rec.meta)}`);

  console.log("\nvisit page lines  secs  sweeps  confident  exact  ±1    bias  stretch   line every 0.5 s (. = none)");
  for (const p of res.pages) {
    const trace = p.trace.map((l) => (l < 0 ? "." : l.toString(36))).join("");
    console.log(
      `${String(p.visit).padStart(4)} ${String(p.page + 1).padStart(4)} ${String(p.lines).padStart(5)} ${p.seconds.toFixed(0).padStart(5)} ${String(p.sweeps).padStart(7)}      ${pct(p.confident)}   ${pct(p.exact)}  ${pct(p.near)}  ${String(Math.round(p.biasY)).padStart(5)}  ${p.gain.toFixed(2).padStart(7)}   ${trace}`,
    );
  }
  if (res.exact !== undefined) console.log(`\nline accuracy against a steady read: ${pct(res.exact).trim()} exact, ${pct(res.near).trim()} within one line`);

  const r = res.report;
  const count = (s: string) => r.paragraphs.filter((p) => p.status === s).length;
  console.log(
    `report: coverage ${r.coveragePct}% · focus ${r.focusPct}% · ${r.avgWpm ?? "–"} wpm · paragraphs read ${count("read")} / skimmed ${count("skimmed")} / skipped ${count("skipped")}` +
      ` · re-read ${r.paragraphs.filter((p) => p.rereads > 0).length} · distractions ${r.distractions.length}`,
  );
}
