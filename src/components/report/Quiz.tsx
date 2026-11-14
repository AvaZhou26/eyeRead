"use client";
import { useState } from "react";
import type { QuizQuestion } from "@/lib/types";
import { IconCheck, IconX } from "@/components/icons";

export function Quiz({ questions }: { questions: QuizQuestion[] }) {
  const [answers, setAnswers] = useState<(number | null)[]>(questions.map(() => null));
  const done = answers.filter((a) => a !== null).length;
  const correct = answers.filter((a, i) => a === questions[i].answerIndex).length;
  return (
    <div className="space-y-4">
      {questions.map((q, qi) => {
        const chosen = answers[qi];
        return (
          <div key={qi} className="card p-5">
            <div className="font-medium">
              <span className="text-muted mr-2">{qi + 1}.</span>
              {q.question}
            </div>
            <div className="mt-3 grid gap-2">
              {q.options.map((opt, oi) => {
                const isAnswer = oi === q.answerIndex;
                const picked = chosen === oi;
                const revealed = chosen !== null;
                const color = revealed && isAnswer ? "var(--read)" : revealed && picked ? "var(--skip)" : undefined;
                return (
                  <button
                    key={oi}
                    disabled={revealed}
                    onClick={() => setAnswers((a) => a.map((v, i) => (i === qi ? oi : v)))}
                    className="text-left rounded-lg border px-3.5 py-2.5 text-sm transition flex items-center gap-3 disabled:cursor-default"
                    style={{
                      borderColor: color ?? "var(--border)",
                      background: color ? `color-mix(in srgb, ${color} 10%, transparent)` : undefined,
                    }}
                  >
                    <span className="h-5 w-5 rounded-full border flex items-center justify-center shrink-0 text-[11px]" style={{ borderColor: color ?? "var(--border)", color }}>
                      {revealed && isAnswer ? <IconCheck size={12} /> : revealed && picked ? <IconX size={12} /> : String.fromCharCode(65 + oi)}
                    </span>
                    {opt}
                  </button>
                );
              })}
            </div>
            {chosen !== null && <p className="mt-3 text-sm text-muted fade-in">{q.explanation}</p>}
          </div>
        );
      })}
      {done === questions.length && (
        <p className="text-sm font-medium fade-in">
          You got {correct} of {questions.length}.{" "}
          {correct === questions.length ? "Nice, you've got the gist of what you skipped." : "Worth a quick re-read of those sections."}
        </p>
      )}
    </div>
  );
}
