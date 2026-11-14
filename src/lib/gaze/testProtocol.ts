// The labelled tracker test: a reading session where the app tells the reader what to do on
// each page (read it, skim it, read it twice, skip it). Because we then know what really
// happened, a recording of the session can be scored: did the report call each paragraph
// what the reader actually did? Start it by opening the reader with ?test=1 (TESTING.md, 3c).
import type { LineBox } from "./lineHmm";

export type TestStep = "read" | "skim" | "reread" | "rereadLines" | "skip";

/** What to do on page 1, 2, 3, …; repeats for longer readings. Every other page is a plain read. */
export const TEST_CYCLE: TestStep[] = ["read", "skim", "read", "reread", "read", "skip", "read", "rereadLines"];

export const stepForPage = (page: number): TestStep => TEST_CYCLE[page % TEST_CYCLE.length];

export const STEP_TEXT: Record<TestStep, { title: string; detail: string }> = {
  read: { title: "Read this page normally", detail: "Every line, once, at your usual pace. Then press →." },
  skim: { title: "Skim this page", detail: "Glance over it quickly to get the gist; don't read every word. Then press →." },
  reread: { title: "Read this page twice", detail: "Read it to the end, go back to the top and read it all again. Then press →." },
  rereadLines: { title: "Read the first line of each paragraph twice", detail: "Otherwise read normally, every line once. Then press →." },
  skip: { title: "Skip this page", detail: "Don't read it. Wait two seconds, then press →." },
};

/**
 * The step each paragraph was read under, by paragraph index. Null for paragraphs that
 * straddle pages with different steps (we can't say what was done to them as a whole).
 */
export function labelsFor(byPage: LineBox[][], paragraphCount: number): (TestStep | null)[] {
  const steps: (Set<TestStep> | undefined)[] = new Array(paragraphCount);
  byPage.forEach((lines, page) => {
    for (const l of lines) (steps[l.paragraph] ??= new Set()).add(stepForPage(page));
  });
  return Array.from({ length: paragraphCount }, (_, p) => {
    const s = steps[p];
    return s && s.size === 1 ? [...s][0] : null;
  });
}

/** What a correct report says about a paragraph read under each step. */
export function reportedCorrectly(step: TestStep, status: "read" | "skimmed" | "skipped", rereads: number): boolean {
  switch (step) {
    case "read":
      return status === "read" && rereads === 0;
    case "skim":
      return status !== "read" && rereads === 0;
    case "skip":
      return status === "skipped" && rereads === 0;
    case "reread":
    case "rereadLines":
      return status === "read" && rereads > 0;
  }
}
