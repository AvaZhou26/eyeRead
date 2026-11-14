// Everything that talks to Google Gemini lives here. It only ever runs on the server,
// so your API key is never sent to the browser.
import { GoogleGenAI } from "@google/genai";
import type { AiResult, ParagraphStat, QuizQuestion, Reading, SessionReport, SkippedSection } from "./types";
import { isHeading } from "./text";

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

function client(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === "your-key-here") return null;
  return new GoogleGenAI({ apiKey: key });
}

export function geminiConfigured(): boolean {
  return client() !== null;
}

async function generateJson<T>(prompt: string, schema: object): Promise<T> {
  const ai = client();
  if (!ai) throw new Error("GEMINI_API_KEY is not set");
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      temperature: 0.4,
    },
  });
  const text = res.text;
  if (!text) throw new Error("Gemini returned an empty response");
  return JSON.parse(text) as T;
}

/** Group neighbouring skipped/skimmed paragraphs into sections (headings are ignored). */
export function missedSections(reading: Reading, stats: ParagraphStat[]): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  for (const s of stats) {
    const missed = s.status !== "read" && !isHeading(reading.paragraphs[s.index] ?? "");
    if (missed) current.push(s.index);
    else if (current.length) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

const SESSION_SCHEMA = {
  type: "object",
  properties: {
    overview: { type: "string", description: "2-3 sentences: what the student missed and why it matters." },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: { type: "integer", description: "The section number given in the prompt." },
          title: { type: "string", description: "A 3-7 word title for the section." },
          summary: { type: "string", description: "A clear 2-4 sentence summary of the section." },
        },
        required: ["section", "title", "summary"],
      },
    },
    quiz: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
          answerIndex: { type: "integer", minimum: 0, maximum: 3 },
          explanation: { type: "string" },
        },
        required: ["question", "options", "answerIndex", "explanation"],
      },
    },
  },
  required: ["overview", "sections", "quiz"],
};

export async function generateSessionAi(reading: Reading, report: SessionReport): Promise<AiResult> {
  const groups = missedSections(reading, report.paragraphs);
  if (groups.length === 0) {
    return {
      generatedBy: "fallback",
      overview: "You covered the whole reading. Nothing was skipped, so there's nothing to summarize.",
      sections: [],
      quiz: [],
    };
  }

  if (!geminiConfigured()) return fallbackSessionAi(reading, groups, "Add a GEMINI_API_KEY to get AI summaries and quiz questions.");

  const fullText = reading.paragraphs.join("\n\n").slice(0, 60000);
  const sectionText = groups
    .map((g, i) => `SECTION ${i + 1}:\n${g.map((p) => reading.paragraphs[p]).join("\n\n")}`)
    .join("\n\n---\n\n");

  const prompt = `You are a supportive study assistant for a college student.
The student just read "${reading.title}" in a reading app that tracks which parts they actually read.
They skipped or only skimmed the sections below. Help them catch up quickly.

1. "overview": 2-3 sentences, written to the student ("you"), about what the missed parts cover and why they matter for the reading as a whole. Be encouraging, never scolding.
2. "sections": one entry per numbered section with a short title and a clear 2-4 sentence summary. Use only information from the text.
3. "quiz": exactly 3 multiple-choice questions that check understanding of the MISSED sections (not trivia). 4 options each, one correct, with a one-sentence explanation.

MISSED SECTIONS:
${sectionText}

FULL READING (for context only):
${fullText}`;

  try {
    const out = await generateJson<{
      overview: string;
      sections: { section: number; title: string; summary: string }[];
      quiz: QuizQuestion[];
    }>(prompt, SESSION_SCHEMA);
    const sections: SkippedSection[] = groups.map((g, i) => {
      const match = out.sections.find((s) => s.section === i + 1) ?? out.sections[i];
      return {
        paragraphs: g,
        title: match?.title ?? `Section ${i + 1}`,
        summary: match?.summary ?? "",
      };
    });
    const quiz = (out.quiz ?? [])
      .filter((q) => Array.isArray(q.options) && q.options.length >= 2 && q.answerIndex < q.options.length)
      .slice(0, 3);
    return { generatedBy: "gemini", overview: out.overview, sections, quiz };
  } catch (err) {
    console.error("[gemini] session summary failed:", err);
    return fallbackSessionAi(reading, groups, `Gemini request failed: ${(err as Error).message}`);
  }
}

/** Without an API key we still show *something* useful: the first sentences of each missed section. */
function fallbackSessionAi(reading: Reading, groups: number[][], note: string): AiResult {
  const sections = groups.map((g, i) => {
    const text = g.map((p) => reading.paragraphs[p]).join(" ");
    const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
    return {
      paragraphs: g,
      title: `Missed section ${i + 1}`,
      summary: sentences.slice(0, 2).join(" ").trim(),
    };
  });
  return {
    generatedBy: "fallback",
    overview: `You moved quickly past ${groups.length} part${groups.length > 1 ? "s" : ""} of this reading. Here are their opening lines so you know what you missed.`,
    sections,
    quiz: [],
    note,
  };
}

// ---------- Professor class digest ----------

export interface ClassParagraphAggregate {
  index: number;
  text: string;
  skippedPct: number;
  skimmedPct: number;
  avgRereads: number;
  avgDwellRatio: number; // dwell / expected
}

export async function generateClassDigest(
  reading: Reading,
  studentCount: number,
  aggregates: ClassParagraphAggregate[],
): Promise<{ text: string; generatedBy: "gemini" | "fallback" }> {
  const body = aggregates.filter((a) => !isHeading(a.text));
  const hardest = [...body].sort((a, b) => b.avgRereads - a.avgRereads).slice(0, 3);
  const mostSkipped = [...body].sort((a, b) => b.skippedPct - a.skippedPct).slice(0, 3);

  if (!geminiConfigured()) {
    const lines = [
      `${studentCount} student${studentCount === 1 ? " has" : "s have"} read this so far.`,
      mostSkipped[0] && mostSkipped[0].skippedPct > 0
        ? `Most skipped: paragraph ${mostSkipped[0].index + 1} (${Math.round(mostSkipped[0].skippedPct)}% of students).`
        : "No paragraph was widely skipped.",
      hardest[0] && hardest[0].avgRereads > 0
        ? `Most re-read: paragraph ${hardest[0].index + 1} (${hardest[0].avgRereads.toFixed(1)} re-reads per student), which may be a confusing passage.`
        : "Re-reading was low across the text.",
      "Add a GEMINI_API_KEY for a written analysis.",
    ];
    return { text: lines.join(" "), generatedBy: "fallback" };
  }

  const table = aggregates
    .map(
      (a) =>
        `¶${a.index + 1} | skipped ${a.skippedPct.toFixed(0)}% | skimmed ${a.skimmedPct.toFixed(0)}% | re-reads/student ${a.avgRereads.toFixed(1)} | time vs expected ${a.avgDwellRatio.toFixed(2)}x | "${a.text.slice(0, 220)}"`,
    )
    .join("\n");

  const prompt = `You are helping a college professor understand how their class engaged with an assigned reading, "${reading.title}".
Data comes from a webcam reading tracker for ${studentCount} students. It's approximate, so speak in tendencies, not certainties.

Per-paragraph class data:
${table}

Write a short digest (120-180 words, plain text, no markdown headings) with:
- Which ideas the class likely struggled with (heavy re-reading or slow reading) and what those passages are about.
- Which parts were commonly skipped or skimmed, and whether that matters.
- One or two concrete suggestions for the next class meeting.
Refer to paragraphs as "¶N".`;

  try {
    const out = await generateJson<{ digest: string }>(prompt, {
      type: "object",
      properties: { digest: { type: "string" } },
      required: ["digest"],
    });
    return { text: out.digest, generatedBy: "gemini" };
  } catch (err) {
    console.error("[gemini] class digest failed:", err);
    return { text: `Couldn't reach Gemini (${(err as Error).message}).`, generatedBy: "fallback" };
  }
}

// ---------- PDF clean-up helper ----------

/** Optional: ask Gemini to repair paragraph breaks in messy PDF text. */
export async function cleanExtractedText(raw: string): Promise<string | null> {
  if (!geminiConfigured()) return null;
  try {
    const out = await generateJson<{ paragraphs: string[] }>(
      `The following text was extracted from a PDF and has broken paragraphs, stray page numbers, running headers/footers and hyphenation artifacts.
Return the body text as a clean list of paragraphs. Keep every sentence of the body verbatim (only fix line-break hyphenation). Keep section headings as their own short paragraphs. Remove page numbers, running headers/footers, and reference-list noise.

TEXT:
${raw.slice(0, 120000)}`,
      {
        type: "object",
        properties: { paragraphs: { type: "array", items: { type: "string" } } },
        required: ["paragraphs"],
      },
    );
    return out.paragraphs.join("\n\n");
  } catch (err) {
    console.error("[gemini] PDF cleanup failed:", err);
    return null;
  }
}
