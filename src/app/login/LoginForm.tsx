"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Role } from "@/lib/types";

type Mode = "signin" | "signup";
interface Demo {
  id: string;
  name: string;
  role: Role;
}

export function LoginForm({ demos }: { demos: Demo[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [role, setRole] = useState<Role>("student");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError("");
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "Something went wrong.");
      setBusy(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "signin") void post("/api/auth/login", { email, password });
    else void post("/api/auth/signup", { name, email, password, role });
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{mode === "signin" ? "Welcome back" : "Create your account"}</h1>
      <p className="text-muted mt-1.5 mb-7 text-[15px]">
        {mode === "signin" ? "Sign in to pick up your readings." : "Teachers create courses; students join them with a code."}
      </p>

      <form onSubmit={submit} className="space-y-4">
        {mode === "signup" && (
          <>
            <div>
              <span className="label">I am a…</span>
              <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-surface-2 border border-border">
                {(["student", "professor"] as Role[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(r)}
                    className={`rounded-lg py-2 text-sm font-medium transition ${role === r ? "bg-surface shadow-sm text-fg" : "text-muted hover:text-fg"}`}
                  >
                    {r === "student" ? "Student" : "Teacher"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label" htmlFor="name">Name</label>
              <input id="name" className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Chen" autoComplete="name" />
            </div>
          </>
        )}
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="alex@school.edu" autoComplete="email" />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            required
            minLength={mode === "signup" ? 8 : undefined}
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "signup" ? "At least 8 characters" : ""}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </div>
        {error && <p className="text-sm text-skip">{error}</p>}
        <button className="btn btn-primary w-full !py-2.5" disabled={busy}>
          {busy ? "One moment…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      <p className="text-sm text-muted mt-4 text-center">
        {mode === "signin" ? "New here? " : "Already have an account? "}
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError("");
          }}
        >
          {mode === "signin" ? "Create an account" : "Sign in"}
        </button>
      </p>

      {demos.length > 0 && (
        <div className="mt-8 pt-6 border-t border-border">
          <div className="text-xs font-medium text-muted mb-2.5">Or try a demo account (no password)</div>
          <div className="grid gap-2">
            {demos.map((d) => (
              <button
                key={d.id}
                type="button"
                disabled={busy}
                onClick={() => void post("/api/auth/demo", { userId: d.id })}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm hover:border-accent transition text-left"
              >
                <span className="font-medium truncate">{d.name}</span>
                <span className="text-xs text-muted">{d.role === "professor" ? "Teacher" : "Student"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
