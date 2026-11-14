// Turns a PDF into clean, reflowable paragraphs for our reader.
// PDFs store text as positioned fragments, so we rebuild lines from their positions,
// then use vertical gaps + font size to find paragraph and heading breaks.
import { extractTextItems, getDocumentProxy } from "unpdf";

interface Line {
  text: string;
  y: number; // top-down position within the page
  fontSize: number;
  page: number;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function pdfToText(buffer: ArrayBuffer): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, items } = await extractTextItems(pdf);

  // 1) Rebuild lines on each page.
  const lines: Line[] = [];
  items.forEach((pageItems, pageIdx) => {
    const sorted = pageItems
      .filter((it) => it.str.trim().length > 0)
      .sort((a, b) => b.y - a.y || a.x - b.x);
    let current: { y: number; fontSize: number; parts: { x: number; text: string; width: number }[] } | null = null;
    const flush = () => {
      if (!current) return;
      current.parts.sort((a, b) => a.x - b.x);
      let text = "";
      let lastEnd = -Infinity;
      for (const p of current.parts) {
        const needsSpace = text && !text.endsWith(" ") && !p.text.startsWith(" ") && p.x - lastEnd > current.fontSize * 0.15;
        text += (needsSpace ? " " : "") + p.text;
        lastEnd = p.x + p.width;
      }
      lines.push({ text: text.replace(/\s+/g, " ").trim(), y: -current.y, fontSize: current.fontSize, page: pageIdx });
      current = null;
    };
    for (const it of sorted) {
      const fs = it.fontSize || 10;
      if (current && Math.abs(it.y - current.y) < Math.max(fs, current.fontSize) * 0.5) {
        current.parts.push({ x: it.x, text: it.str, width: it.width });
        current.fontSize = Math.max(current.fontSize, fs);
      } else {
        flush();
        current = { y: it.y, fontSize: fs, parts: [{ x: it.x, text: it.str, width: it.width }] };
      }
    }
    flush();
  });

  // 2) Drop page numbers and running headers/footers (lines repeated on many pages).
  const counts = new Map<string, number>();
  for (const l of lines) {
    const key = l.text.replace(/\d+/g, "#").toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeatThreshold = Math.max(3, totalPages * 0.4);
  const body = lines.filter((l) => {
    if (/^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(l.text)) return false;
    const key = l.text.replace(/\d+/g, "#").toLowerCase();
    return !(totalPages > 2 && (counts.get(key) ?? 0) >= repeatThreshold && l.text.length < 120);
  });

  // 3) Join lines into paragraphs.
  const bodyFont = median(body.map((l) => l.fontSize));
  // Headings (bigger font) only make sense when the body text has ONE consistent size.
  // Scanned/OCR'd PDFs give every line a slightly different size, so there we ignore font size.
  const consistentFont = body.filter((l) => Math.abs(l.fontSize - bodyFont) <= bodyFont * 0.08).length >= body.length * 0.6;
  const isHeading = (l: Line) => consistentFont && l.fontSize > bodyFont * 1.15 && l.text.length < 100;
  const gaps: number[] = [];
  for (let i = 1; i < body.length; i++) {
    if (body[i].page === body[i - 1].page) gaps.push(body[i].y - body[i - 1].y);
  }
  const normalGap = median(gaps.filter((g) => g > 0)) || bodyFont * 1.2;
  const typicalLen = median(body.map((l) => l.text.length));

  const blocks: { text: string; heading: boolean }[] = [];
  let buf = "";
  const push = (heading = false) => {
    const t = buf.trim();
    if (t) blocks.push({ text: t, heading });
    buf = "";
  };
  body.forEach((line, i) => {
    const prev = body[i - 1];
    const headingLine = isHeading(line);
    let breakBefore = i === 0;
    if (prev) {
      const gap = line.page === prev.page ? line.y - prev.y : normalGap;
      const prevHeading = isHeading(prev);
      const prevEndsSentence = /[.!?:"”)]$/.test(prev.text);
      const prevShort = prev.text.length < typicalLen * 0.75;
      if (gap > normalGap * 1.45) breakBefore = true;
      else if (headingLine !== prevHeading) breakBefore = true;
      else if (prevEndsSentence && prevShort) breakBefore = true;
    }
    if (breakBefore) push();
    if (buf.endsWith("-") && /^[a-z]/.test(line.text)) buf = buf.slice(0, -1) + line.text;
    else buf += (buf ? " " : "") + line.text;
    if (headingLine) push(true);
  });
  push();

  // 4) Don't leave line fragments as their own paragraphs (common with equations, short
  // handwritten lines and OCR): keep joining a block into the next until it has a
  // reasonable length. Real headings stay on their own.
  const MIN_WORDS = 15;
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const paragraphs: string[] = [];
  let lastHeading = true;
  for (const b of blocks) {
    const last = paragraphs.length - 1;
    const canMerge = last >= 0 && !lastHeading && !b.heading;
    if (canMerge && (words(paragraphs[last]) < MIN_WORDS || words(b.text) < 4)) {
      paragraphs[last] += " " + b.text;
    } else {
      paragraphs.push(b.text);
      lastHeading = b.heading;
    }
  }
  // A short trailing fragment joins the paragraph before it.
  const n = paragraphs.length;
  if (n >= 2 && words(paragraphs[n - 1]) < 4 && !blocks[blocks.length - 1]?.heading) {
    paragraphs[n - 2] += " " + paragraphs.pop();
  }

  return { text: paragraphs.join("\n\n"), pages: totalPages };
}
