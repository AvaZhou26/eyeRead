// The reading, colored by how each part was read. Server component (no JS needed).
import type { CoverageStatus, ParagraphStat } from "@/lib/types";
import { isHeading, splitWords } from "@/lib/text";

const BG: Record<CoverageStatus, string> = {
  read: "transparent",
  skimmed: "var(--skim-soft)",
  skipped: "var(--skip-soft)",
};

export function ReadingMap({
  paragraphs,
  wordStatus,
  stats,
}: {
  paragraphs: string[];
  wordStatus: CoverageStatus[];
  stats: ParagraphStat[];
}) {
  const starts: number[] = [];
  paragraphs.reduce((n, p) => {
    starts.push(n);
    return n + splitWords(p).length;
  }, 0);
  return (
    <div className="font-serif text-[17px] leading-[1.95]">
      {paragraphs.map((p, pi) => {
        const words = splitWords(p);
        const start = starts[pi];
        // group consecutive words with the same status
        const runs: { status: CoverageStatus; text: string }[] = [];
        words.forEach((w, i) => {
          const st = wordStatus[start + i] ?? "skipped";
          const last = runs[runs.length - 1];
          if (last && last.status === st) last.text += " " + w;
          else runs.push({ status: st, text: w });
        });
        const s = stats[pi];
        const Tag = isHeading(p) ? "h3" : "p";
        return (
          <div key={pi} id={`p-${pi}`} className="relative group scroll-mt-24">
            {s && s.rereads > 0 && (
              <div className="absolute -left-4 top-1 bottom-1 w-[3px] rounded-full" style={{ background: "var(--reread)" }} title={`Re-read ${s.rereads}×`} />
            )}
            <Tag className={isHeading(p) ? "font-semibold text-[1.1em] mt-2 mb-3" : "mb-5"}>
              {runs.map((r, i) => (
                <span key={i} style={{ background: BG[r.status], borderRadius: 4, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone", padding: r.status === "read" ? 0 : "1px 0" }}>
                  {r.text}
                  {i < runs.length - 1 ? " " : ""}
                </span>
              ))}
              {s && s.rereads > 0 && (
                <span className="ml-2 align-middle pill !text-[11px]" style={{ color: "var(--reread)", background: "var(--reread-soft)" }}>
                  re-read {s.rereads}×
                </span>
              )}
            </Tag>
          </div>
        );
      })}
    </div>
  );
}

export function Legend() {
  const item = (c: string, label: string, bar = false) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={bar ? "h-3.5 w-[3px] rounded-full" : "h-3 w-5 rounded"} style={{ background: c, border: c === "transparent" ? "1px solid var(--border)" : undefined }} />
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-4 text-xs text-muted">
      {item("transparent", "Read")}
      {item("var(--skim-soft)", "Skimmed")}
      {item("var(--skip-soft)", "Skipped")}
      {item("var(--reread)", "Re-read", true)}
    </div>
  );
}

/** A compact strip: one block per paragraph. */
export function ParagraphStrip({ stats }: { stats: ParagraphStat[] }) {
  const color: Record<CoverageStatus, string> = { read: "var(--read)", skimmed: "var(--skim)", skipped: "var(--skip)" };
  const total = stats.reduce((s, p) => s + p.words, 0) || 1;
  return (
    <div className="flex h-3 w-full gap-[2px] rounded-full overflow-hidden">
      {stats.map((p) => (
        <a
          key={p.index}
          href={`#p-${p.index}`}
          title={`¶${p.index + 1}: ${p.status}${p.wpm && p.status !== "skipped" ? ` · ${p.wpm} wpm` : ""}${p.rereads ? ` · re-read ${p.rereads}×` : ""}`}
          className="h-full hover:opacity-70 transition-opacity"
          style={{ width: `${(p.words / total) * 100}%`, minWidth: 3, background: color[p.status] }}
        />
      ))}
    </div>
  );
}
