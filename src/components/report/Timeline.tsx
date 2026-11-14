import type { DistractionEvent, StateSegment } from "@/lib/types";
import { formatDuration } from "@/lib/text";

// "away" covers two different causes, which we split for the report:
//   tab    → the student switched to another tab/app (the page was hidden)
//   noface → the page was open but the camera couldn't see them facing the screen
type Kind = "reading" | "skimming" | "pausing" | "offtext" | "tab" | "noface";

const COLOR: Record<Kind, string> = {
  reading: "var(--read)",
  skimming: "var(--skim)",
  pausing: "var(--accent)",
  offtext: "var(--away)",
  noface: "var(--away)",
  tab: "var(--faint)",
};
const OPACITY: Record<Kind, number> = { reading: 0.85, skimming: 0.85, pausing: 0.85, offtext: 0.85, noface: 0.6, tab: 0.45 };

function labelFor(kind: Kind, focusOnly: boolean): string {
  if (focusOnly && (kind === "reading" || kind === "skimming" || kind === "pausing")) return "Facing the page";
  return {
    reading: "Reading",
    skimming: "Moving quickly",
    pausing: "Paused on text",
    offtext: "Looking off the text",
    noface: "Not facing the screen",
    tab: "On another tab",
  }[kind];
}

/** Which kind is an "away" segment? Whichever cause covers most of it. */
function awayKind(seg: StateSegment, distractions: DistractionEvent[]): Kind {
  let tab = 0;
  for (const d of distractions) {
    if (d.kind !== "tab") continue;
    const overlap = Math.min(seg.end, d.start + d.durationSec) - Math.max(seg.start, d.start);
    if (overlap > 0) tab += overlap;
  }
  return tab >= (seg.end - seg.start) / 2 ? "tab" : "noface";
}

export function Timeline({
  segments,
  duration,
  distractions,
  focusOnly,
}: {
  segments: StateSegment[];
  duration: number;
  distractions: DistractionEvent[];
  focusOnly: boolean;
}) {
  const total = Math.max(1, duration);
  const kinds: Kind[] = segments.map((s) => (s.state === "away" ? awayKind(s, distractions) : s.state));
  // Legend: one entry per distinct label (focus-only merges reading/skimming/pausing).
  const legend = new Map<string, Kind>();
  kinds.forEach((k) => {
    const label = labelFor(k, focusOnly);
    if (!legend.has(label)) legend.set(label, k);
  });
  return (
    <div>
      <div className="flex h-6 w-full rounded-lg overflow-hidden bg-surface-2">
        {segments.map((s, i) => {
          const k = kinds[i];
          const color = focusOnly && (k === "skimming" || k === "pausing") ? COLOR.reading : COLOR[k];
          return (
            <div
              key={i}
              title={`${labelFor(k, focusOnly)} · ${formatDuration(s.end - s.start)}`}
              style={{ width: `${((s.end - s.start) / total) * 100}%`, background: color, opacity: OPACITY[k] }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] text-muted mt-1.5 tabular-nums">
        <span>0:00</span>
        {/* The timeline spans the whole session, distractions included (not just reading time). */}
        <span>{formatDuration(total)} · session length</span>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-muted mt-2">
        {[...legend.entries()].map(([label, k]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLOR[k], opacity: OPACITY[k] }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
