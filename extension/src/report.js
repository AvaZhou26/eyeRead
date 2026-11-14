// Turns per-word dwell times into a reading report.
// Same rules as src/lib/gaze/readingTracker.ts (buildReport):
//   • a word is "read" if it got ≥35% of the time a 240-wpm reader needs,
//     "skimmed" at 15–35%, "skipped" below that
//   • a paragraph is "read" when ≥60% of its words were read, "skipped" when
//     fewer than 35% were at least skimmed, "skimmed" otherwise
//   • coverage = (read words + ½ skimmed words) / words

export const SEC_PER_WORD = 60 / 240;
export const READ_RATIO = 0.35;
export const SKIM_RATIO = 0.15;

/**
 * @param {{ url: string, title: string, site: string, activeSec: number, eyeSec?: number,
 *           firstSeen: number, lastSeen: number,
 *           paras: { text: string, words: number, heading: boolean, dwell: number[] }[] }} rec
 */
export function buildReport(rec) {
  let totalWords = 0, readWords = 0, skimWords = 0;
  let lastHeading = null;
  const paragraphs = rec.paras.map((p, index) => {
    if (p.heading) {
      lastHeading = p.text;
      return { index, heading: true, text: p.text, words: p.words, status: null, coverage: 0, dwellSec: 0, section: null };
    }
    let read = 0, skim = 0, dwellSec = 0;
    for (let w = 0; w < p.words; w++) {
      const d = p.dwell[w] || 0;
      dwellSec += d;
      const r = d / SEC_PER_WORD;
      if (r >= READ_RATIO) read++;
      else if (r >= SKIM_RATIO) skim++;
    }
    const n = Math.max(1, p.words);
    const readShare = read / n;
    const seenShare = (read + skim) / n;
    const status = readShare >= 0.6 ? "read" : seenShare < 0.35 ? "skipped" : "skimmed";
    totalWords += p.words;
    readWords += read;
    skimWords += skim;
    return {
      index,
      heading: false,
      text: p.text,
      words: p.words,
      status,
      coverage: (read + 0.5 * skim) / n,
      dwellSec: Math.round(dwellSec * 10) / 10,
      section: lastHeading,
    };
  });

  const body = paragraphs.filter((p) => !p.heading);
  const wordsBy = (s) => body.filter((p) => p.status === s).reduce((a, p) => a + p.words, 0);

  // Contiguous runs of skipped paragraphs (headings inside a run don't break it).
  const skippedSections = [];
  let run = null;
  for (const p of paragraphs) {
    if (p.heading) continue;
    if (p.status === "skipped") {
      if (!run) run = { from: p.index, to: p.index, paragraphs: 0, words: 0, snippet: p.text.slice(0, 140), section: p.section };
      run.to = p.index;
      run.paragraphs++;
      run.words += p.words;
    } else if (run) {
      skippedSections.push(run);
      run = null;
    }
  }
  if (run) skippedSections.push(run);

  return {
    url: rec.url,
    title: rec.title,
    site: rec.site,
    firstSeen: rec.firstSeen,
    lastSeen: rec.lastSeen,
    totalWords,
    paragraphCount: body.length,
    coveragePct: totalWords ? Math.round(((readWords + 0.5 * skimWords) / totalWords) * 1000) / 10 : 0,
    wordsRead: wordsBy("read"),
    wordsSkimmed: wordsBy("skimmed"),
    wordsSkipped: wordsBy("skipped"),
    paragraphsRead: body.filter((p) => p.status === "read").length,
    paragraphsSkimmed: body.filter((p) => p.status === "skimmed").length,
    paragraphsSkipped: body.filter((p) => p.status === "skipped").length,
    activeSec: Math.round(rec.activeSec || 0),
    eyeSec: Math.round(rec.eyeSec || 0),
    expectedSec: Math.round(totalWords * SEC_PER_WORD),
    paragraphs,
    skippedSections,
  };
}

/** Article key: origin + path (query strings and #fragments ignored). */
export function articleKey(href) {
  try {
    const u = new URL(href);
    return "art:" + u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return "art:" + href;
  }
}
