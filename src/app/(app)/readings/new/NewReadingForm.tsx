"use client";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { countWords, toParagraphs } from "@/lib/text";
import type { Role } from "@/lib/types";
import { IconUpload } from "@/components/icons";

export function NewReadingForm({
  role,
  courses,
  defaultCourseId,
  aiAvailable,
}: {
  role: Role;
  courses: { id: string; label: string }[];
  defaultCourseId?: string;
  aiAvailable: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"paste" | "pdf">("paste");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [courseId, setCourseId] = useState(defaultCourseId ?? "");
  const [dueDate, setDueDate] = useState("");
  const [instructions, setInstructions] = useState("");
  const [useAi, setUseAi] = useState(false);
  const [pdfInfo, setPdfInfo] = useState("");
  const [busy, setBusy] = useState<"" | "pdf" | "save">("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const stats = useMemo(() => {
    const paragraphs = toParagraphs(text);
    return { paragraphs: paragraphs.length, words: countWords(paragraphs) };
  }, [text]);

  async function uploadPdf(file: File) {
    setBusy("pdf");
    setError("");
    setPdfInfo("");
    const form = new FormData();
    form.append("file", file);
    if (useAi) form.append("ai", "1");
    const res = await fetch("/api/pdf", { method: "POST", body: form });
    const data = await res.json();
    setBusy("");
    if (!res.ok) return setError(data.error ?? "Couldn't read that PDF.");
    setText(data.text);
    if (!title) setTitle(data.title);
    setPdfInfo(
      `Extracted ${data.pages} page${data.pages === 1 ? "" : "s"}${data.cleanedByAi ? " (cleaned up with Gemini)" : ""}. Check the text below and fix anything that looks off.`,
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save");
    setError("");
    const res = await fetch("/api/readings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        text,
        courseId: role === "professor" ? courseId || null : null,
        dueDate: dueDate || null,
        instructions,
        source: mode,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setBusy("");
      return setError(data.error ?? "Couldn't save.");
    }
    router.push(role === "professor" && courseId ? `/courses/${courseId}` : `/readings/${data.reading.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <div className="card p-6 space-y-5">
        <div>
          <label className="label" htmlFor="title">Title</label>
          <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chapter 3: Memory and Attention" />
        </div>

        <div className="inline-grid grid-cols-2 gap-1 p-1 rounded-xl bg-surface-2 border border-border">
          {(["paste", "pdf"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${mode === m ? "bg-surface shadow-sm" : "text-muted hover:text-fg"}`}
            >
              {m === "paste" ? "Paste text" : "Upload PDF"}
            </button>
          ))}
        </div>

        {mode === "pdf" && (
          <div className="space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files[0];
                if (f) uploadPdf(f);
              }}
              onClick={() => fileRef.current?.click()}
              className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
                dragging ? "border-accent bg-accent-soft" : "border-border hover:border-accent"
              }`}
            >
              <IconUpload className="mx-auto text-muted" size={24} />
              <div className="mt-2 font-medium">{busy === "pdf" ? "Reading your PDF…" : "Drop a PDF here, or click to choose"}</div>
              <div className="text-sm text-muted mt-1">We pull out the text and reformat it for comfortable reading.</div>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadPdf(f);
                  e.target.value = "";
                }}
              />
            </div>
            <label className={`flex items-center gap-2 text-sm ${aiAvailable ? "" : "opacity-50"}`}>
              <input type="checkbox" disabled={!aiAvailable} checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
              Clean up messy formatting with Gemini (slower)
              {!aiAvailable && <span className="text-muted">· needs an API key</span>}
            </label>
            {pdfInfo && <p className="text-sm text-read">{pdfInfo}</p>}
          </div>
        )}

        {(mode === "paste" || text) && (
          <div>
            <div className="flex justify-between items-end">
              <label className="label" htmlFor="text">Text</label>
              <span className="text-xs text-muted mb-1.5">
                {stats.paragraphs} paragraphs · {stats.words.toLocaleString()} words
              </span>
            </div>
            <textarea
              id="text"
              className="input font-serif leading-relaxed min-h-[320px]"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste your reading here. Leave a blank line between paragraphs."
            />
          </div>
        )}
      </div>

      {role === "professor" && (
        <div className="card p-6 space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Course</label>
              <select className="input" value={courseId} onChange={(e) => setCourseId(e.target.value)} required>
                {courses.length === 0 && <option value="">Create a course first</option>}
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Due date (optional)</label>
              <input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Instructions for students (optional)</label>
            <input
              className="input"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Pay attention to the author's argument in section 2."
            />
          </div>
        </div>
      )}

      {error && <p className="text-sm text-skip">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn btn-primary" disabled={busy !== "" || !title || stats.words === 0}>
          {busy === "save" ? "Saving…" : role === "professor" ? "Post reading" : "Save reading"}
        </button>
      </div>
    </form>
  );
}
