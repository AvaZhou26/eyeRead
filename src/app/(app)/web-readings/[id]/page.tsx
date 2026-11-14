// An article read on another site, measured by the browser extension and imported into
// the account (see ExtensionSync). Only the owner can see it.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getWebReading } from "@/lib/db";
import { formatDate, formatDuration } from "@/lib/text";
import { PageHeader } from "@/components/AppShell";
import { Section, Stat } from "@/components/ui";
import { RemoveWebReading } from "@/components/RemoveWebReading";

const BG = { read: "transparent", skimmed: "var(--skim-soft)", skipped: "var(--skip-soft)" } as const;
const BAR = { read: "var(--read)", skimmed: "var(--skim)", skipped: "var(--skip)" } as const;

export default async function WebReadingPage({ params }: PageProps<"/web-readings/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const w = await getWebReading(id);
  if (!w || w.userId !== user.id) notFound();

  const body = w.paragraphs.filter((p) => p.status);
  const count = (s: "read" | "skimmed" | "skipped") => body.filter((p) => p.status === s).length;
  const eyeMode = w.eyeSec >= w.activeSec * 0.5 && w.eyeSec > 0;
  const coverColor = w.coveragePct >= 85 ? "var(--read)" : w.coveragePct >= 50 ? "var(--skim)" : "var(--skip)";
  const pct = (n: number) => (w.totalWords ? Math.round((n / w.totalWords) * 100) : 0);

  return (
    <div className="max-w-4xl">
      <PageHeader
        eyebrow={`${w.site} · from the browser extension`}
        title={w.title}
        subtitle={`Last read ${formatDate(w.lastSeen)}${w.firstSeen.slice(0, 10) !== w.lastSeen.slice(0, 10) ? ` · first opened ${formatDate(w.firstSeen)}` : ""}`}
        actions={
          <>
            <a href={w.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
              Open article ↗
            </a>
            <RemoveWebReading id={w.id} />
          </>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
        <Stat label="Coverage" value={`${Math.round(w.coveragePct)}%`} color={coverColor} hint={`of ${w.totalWords.toLocaleString()} words`} />
        <Stat label="Reading time" value={formatDuration(w.activeSec)} hint={eyeMode ? "eyes on the page (eye tracking)" : "active on the page"} />
        <Stat label="Paragraphs read" value={`${count("read")}/${body.length}`} hint={`${count("skimmed")} skimmed · ${count("skipped")} skipped`} />
        <Stat label="Measured with" value={eyeMode ? "Eye tracking" : "Scrolling"} hint={eyeMode ? "webcam, on your computer" : "what was on screen while you were active"} />
      </div>

      <Section title="Where you read">
        <div className="card p-5">
          <div className="flex h-2.5 rounded-full overflow-hidden mb-2" aria-hidden>
            <span style={{ width: `${pct(w.wordsRead)}%`, background: "var(--read)" }} />
            <span style={{ width: `${pct(w.wordsSkimmed)}%`, background: "var(--skim)" }} />
            <span style={{ width: `${pct(w.wordsSkipped)}%`, background: "var(--skip)" }} />
          </div>
          <p className="text-xs text-muted mb-5">
            {pct(w.wordsRead)}% of words in paragraphs you read · {pct(w.wordsSkimmed)}% skimmed · {pct(w.wordsSkipped)}% skipped
          </p>
          <ol className="space-y-1.5">
            {w.paragraphs.map((p, i) =>
              p.status === null ? (
                <li key={i} className="pt-3 text-sm font-semibold">{p.text}</li>
              ) : (
                <li key={i} className="flex gap-3 rounded-md px-2 py-1.5 text-sm" style={{ background: BG[p.status] }}>
                  <span className="w-[3px] shrink-0 rounded-full" style={{ background: BAR[p.status] }} aria-hidden />
                  <span className="min-w-0 flex-1 text-muted truncate">{p.text}…</span>
                  <span className="shrink-0 text-xs text-muted capitalize">{p.status}</span>
                </li>
              ),
            )}
          </ol>
          <p className="text-xs text-muted mt-4">Only the first words of each paragraph are saved to your account, not the article.</p>
        </div>
      </Section>
    </div>
  );
}
