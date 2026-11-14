"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Role } from "@/lib/types";

export function LoginForm() {
  const router = useRouter();
  const [role, setRole] = useState<Role>("student");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, role }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Something went wrong.");
      setBusy(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <span className="label">I am a…</span>
        <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-surface-2 border border-border">
          {(["student", "professor"] as Role[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(r)}
              className={`rounded-lg py-2 text-sm font-medium capitalize transition ${
                role === r ? "bg-surface shadow-sm text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="label" htmlFor="name">Name</label>
        <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Chen" />
      </div>
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          required
          className="input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="alex@school.edu"
        />
      </div>
      {error && <p className="text-sm text-skip">{error}</p>}
      <button className="btn btn-primary w-full !py-2.5" disabled={busy}>
        {busy ? "Signing in…" : "Continue"}
      </button>
      <p className="text-xs text-muted leading-relaxed">
        Tip: the demo professor is <code className="text-fg">prof@demo.edu</code>. New students are added to the demo
        course automatically (join code <code className="text-fg">READ01</code>).
      </p>
    </form>
  );
}
