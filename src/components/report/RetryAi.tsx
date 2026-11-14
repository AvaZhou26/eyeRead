"use client";
// Shown on a report whose AI summary failed when the session was saved: asks the server to
// try once more, then reloads the report with the real summary and quiz.
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RetryAi({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function retry() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/sessions/${sessionId}/ai`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That didn't work. Try again in a minute.");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button className="underline underline-offset-2 hover:text-fg disabled:opacity-60" onClick={retry} disabled={busy}>
        {busy ? "Trying again…" : "Try again"}
      </button>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
