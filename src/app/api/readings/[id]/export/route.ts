import { getCurrentUser } from "@/lib/auth";
import { getCourse, getReading, sessionsForReading, studentsInCourse } from "@/lib/db";
import { attemptsPerStudent, bestPerStudent } from "@/lib/insights";

// CSV of the class insights "Students" table (one row per enrolled student, best session).
function cell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote everything that could break a CSV; also stop spreadsheet formula injection.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function GET(req: Request, ctx: RouteContext<"/api/readings/[id]/export">) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  const reading = getReading(id);
  const course = reading?.courseId ? getCourse(reading.courseId) : null;
  if (!user || !reading || !course || course.professorId !== user.id)
    return Response.json({ error: "Not allowed." }, { status: 403 });

  const all = sessionsForReading(reading.id);
  const best = bestPerStudent(all);
  const attempts = attemptsPerStudent(all);
  const origin = new URL(req.url).origin;

  const header = [
    "Student", "Email", "Status", "Coverage %", "Focus %", "Speed (wpm)", "Time (s)", "Time",
    "Distractions", "Sessions", "Best session date", "Best session link",
  ];
  const rows = studentsInCourse(course.id).map((st) => {
    const s = best.get(st.id);
    const r = s?.report;
    const mins = r ? `${Math.floor(r.durationSec / 60)}m ${r.durationSec % 60}s` : "";
    return [
      st.name,
      st.email,
      r ? `Read ${Math.round(r.coveragePct)}%` : "Not started",
      r ? Math.round(r.coveragePct) : "",
      r ? Math.round(r.focusPct) : "",
      r?.avgWpm ?? "",
      r ? r.durationSec : "",
      mins,
      r ? r.distractions.length : "",
      attempts.get(st.id) ?? 0,
      s ? new Date(s.endedAt).toLocaleDateString("en-CA") : "", // YYYY-MM-DD in local time, like the table
      s ? `${origin}/reports/${s.id}` : "",
    ];
  });

  const csv = [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
  const slug = `${course.code}-${reading.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug || "class-insights"}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
