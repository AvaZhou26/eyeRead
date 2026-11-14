// Browser-side text recognition for photos/scans of pages (used when there's no Gemini key).
// Tesseract runs on this device; the first use downloads its English model (~10 MB, then cached).
"use client";

export type OcrProgress = (message: string, fraction: number) => void;

/** Render every page of a (scanned) PDF to a PNG so it can be read like a photo. */
export async function pdfToImages(file: File, onProgress?: OcrProgress): Promise<Blob[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const out: Blob[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(`Preparing page ${i} of ${doc.numPages}…`, (i - 1) / doc.numPages);
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    out.push(await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("render failed"))), "image/png")));
  }
  await task.destroy();
  return out;
}

/** Read the text in each image, in order. Paragraphs are separated by blank lines. */
export async function recognizeImages(images: Blob[], onProgress?: OcrProgress): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  let current = 0;
  const worker = await createWorker("eng", 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") onProgress?.(`Reading page ${current + 1} of ${images.length}…`, (current + m.progress) / images.length);
      else if (current === 0) onProgress?.("Loading the text recognizer…", 0);
    },
  });
  try {
    const pages: string[] = [];
    for (current = 0; current < images.length; current++) {
      const { data } = await worker.recognize(images[current], {}, { blocks: true, text: true });
      const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
      pages.push(cleanOcr(lines.length ? linesToParagraphs(lines) : data.text));
    }
    return pages.filter(Boolean).join("\n\n");
  } finally {
    await worker.terminate();
  }
}

interface OcrLine {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * OCR gives us lines, not paragraphs. Start a new paragraph when the gap above a line is
 * clearly bigger than normal line spacing, when the line is indented, or when the line
 * before it stopped well short of the right margin and ended a sentence.
 */
function linesToParagraphs(lines: OcrLine[]): string {
  const real = lines.filter((l) => l.text.trim());
  if (!real.length) return "";
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
  const pitch = med(real.slice(1).map((l, i) => l.bbox.y0 - real[i].bbox.y0).filter((d) => d > 0)) || 40;
  const left = med(real.map((l) => l.bbox.x0));
  const right = med(real.map((l) => l.bbox.x1));
  const width = Math.max(1, right - left);
  let out = "";
  real.forEach((l, i) => {
    const t = l.text.replace(/\s+$/, "");
    if (i > 0) {
      const prev = real[i - 1];
      const gap = l.bbox.y0 - prev.bbox.y0;
      const indented = l.bbox.x0 - left > width * 0.04;
      const shortEnd = prev.bbox.x1 < right - width * 0.15 && /[.!?:"”’)]\s*$/.test(prev.text.trim());
      out += gap > pitch * 1.45 || indented || shortEnd ? "\n\n" : "\n";
    }
    out += t;
  });
  return out;
}

/** Drop lone page numbers / junk lines that OCR picks up from photocopies. */
function cleanOcr(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => !/^\s*(\d{1,4}|[ivxlc]{1,6})\s*$/i.test(l)) // page numbers
    .filter((l) => l.trim().length === 0 || /[A-Za-z]{2,}/.test(l)) // lines with no real words
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
