"use client";

// ── Customer feedback form ──────────────────────────────────────────
// Shown on `/track/:token` once a job reaches `completed`. Fully
// self-contained: fetches its own "has feedback already been submitted"
// state and posts to the same token-gated endpoint — no props beyond the
// token and a display name, no account, no separate page.

import { useEffect, useState } from "react";
import {
  FEEDBACK_IMPROVEMENT_TAGS,
  FEEDBACK_IMPROVEMENT_TAG_LABEL,
  FEEDBACK_POSITIVE_TAGS,
  FEEDBACK_POSITIVE_TAG_LABEL,
  FEEDBACK_COMMENT_MAX_LEN,
  type FeedbackImprovementTag,
  type FeedbackPositiveTag,
} from "@/lib/types";
import { STATUS_ICON } from "@/lib/icons";

interface SubmittedFeedback {
  rating: number;
  positive_tags: FeedbackPositiveTag[];
  improvement_tags: FeedbackImprovementTag[];
  comment: string | null;
  created_at: string;
}

type FetchState =
  | { phase: "loading" }
  | { phase: "not_eligible" }
  | { phase: "form" }
  | { phase: "submitted"; feedback: SubmittedFeedback };

export function FeedbackForm({
  token,
  technicianName,
}: {
  token: string;
  technicianName: string;
}) {
  const [state, setState] = useState<FetchState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/public/jobs/${encodeURIComponent(token)}/feedback`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { eligible: boolean; submitted: boolean; feedback: SubmittedFeedback | null }) => {
        if (cancelled) return;
        if (!j.eligible) setState({ phase: "not_eligible" });
        else if (j.submitted && j.feedback) setState({ phase: "submitted", feedback: j.feedback });
        else setState({ phase: "form" });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "not_eligible" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.phase === "loading") return null;
  if (state.phase === "not_eligible") return null;

  return (
    <div className="card" style={{ padding: 20 }}>
      {state.phase === "submitted" ? (
        <SubmittedView feedback={state.feedback} />
      ) : (
        <FormView
          token={token}
          technicianName={technicianName}
          onSubmitted={(feedback) => setState({ phase: "submitted", feedback })}
        />
      )}
    </div>
  );
}

function Stars({
  value,
  onChange,
  size = 26,
}: {
  value: number;
  onChange?: (v: number) => void;
  size?: number;
}) {
  const [hover, setHover] = useState(0);
  const readOnly = !onChange;
  const shown = hover || value;
  return (
    <div className="row" style={{ gap: 4 }} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={readOnly}
          onMouseEnter={() => !readOnly && setHover(n)}
          onClick={() => onChange?.(n)}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          style={{
            background: "none",
            border: "none",
            padding: 2,
            cursor: readOnly ? "default" : "pointer",
            color: n <= shown ? "#e0a72e" : "var(--border-strong)",
            display: "inline-flex",
          }}
        >
          <STATUS_ICON.star size={size} strokeWidth={1.75} fill={n <= shown ? "#e0a72e" : "none"} />
        </button>
      ))}
    </div>
  );
}

function TagChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="chip"
      onClick={onClick}
      style={{
        cursor: "pointer",
        background: active ? "var(--brand)" : "var(--surface-2)",
        color: active ? "#fff" : "var(--text-muted)",
        borderColor: active ? "var(--brand)" : "var(--border)",
      }}
    >
      {label}
    </button>
  );
}

function FormView({
  token,
  technicianName,
  onSubmitted,
}: {
  token: string;
  technicianName: string;
  onSubmitted: (f: SubmittedFeedback) => void;
}) {
  const [rating, setRating] = useState(0);
  const [positive, setPositive] = useState<Set<FeedbackPositiveTag>>(new Set());
  const [improvement, setImprovement] = useState<Set<FeedbackImprovementTag>>(new Set());
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle<T>(set: Set<T>, v: T, setter: (s: Set<T>) => void) {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    setter(next);
  }

  async function submit() {
    if (rating < 1) {
      setError("Please choose a star rating.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/jobs/${encodeURIComponent(token)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rating,
          positive_tags: [...positive],
          improvement_tags: [...improvement],
          comment: comment.trim() || null,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "Couldn't submit feedback. Please try again.");
        return;
      }
      onSubmitted(j.feedback);
    } catch {
      setError("Couldn't reach CoolFix right now. Please try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <strong style={{ fontSize: 14 }}>How was your service with {technicianName}?</strong>
      <div style={{ marginTop: 10 }}>
        <Stars value={rating} onChange={setRating} />
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          What went well? <span className="faint" style={{ fontWeight: 400 }}>(optional)</span>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {FEEDBACK_POSITIVE_TAGS.map((t) => (
            <TagChip
              key={t}
              label={FEEDBACK_POSITIVE_TAG_LABEL[t]}
              active={positive.has(t)}
              onClick={() => toggle(positive, t, setPositive)}
            />
          ))}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          Anything that could be improved? <span className="faint" style={{ fontWeight: 400 }}>(optional)</span>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {FEEDBACK_IMPROVEMENT_TAGS.map((t) => (
            <TagChip
              key={t}
              label={FEEDBACK_IMPROVEMENT_TAG_LABEL[t]}
              active={improvement.has(t)}
              onClick={() => toggle(improvement, t, setImprovement)}
            />
          ))}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <label style={{ display: "block", fontSize: 12 }}>
          <span className="muted" style={{ fontWeight: 600 }}>
            Additional comments <span className="faint" style={{ fontWeight: 400 }}>(optional)</span>
          </span>
          <textarea
            className="inp"
            rows={3}
            maxLength={FEEDBACK_COMMENT_MAX_LEN}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            style={{ marginTop: 6, width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid var(--border-strong)", fontSize: 13, background: "var(--surface)" }}
          />
        </label>
        <div className="faint" style={{ fontSize: 10.5, marginTop: 3, textAlign: "right" }}>
          {comment.length}/{FEEDBACK_COMMENT_MAX_LEN}
        </div>
      </div>

      {error && (
        <p style={{ color: "var(--tier-urgent)", fontSize: 12.5, marginTop: 8 }}>{error}</p>
      )}

      <button
        className="btn btn-primary btn-lg"
        style={{ marginTop: 12, width: "100%" }}
        disabled={busy || rating < 1}
        onClick={submit}
      >
        {busy ? "Submitting…" : "Submit feedback"}
      </button>
    </div>
  );
}

function SubmittedView({ feedback }: { feedback: SubmittedFeedback }) {
  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <STATUS_ICON.check size={16} strokeWidth={2.5} color="var(--success)" />
        <strong style={{ fontSize: 14 }}>Thanks for your feedback.</strong>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stars value={feedback.rating} size={22} />
      </div>
      {(feedback.positive_tags.length > 0 || feedback.improvement_tags.length > 0) && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 10 }}>
          {feedback.positive_tags.map((t) => (
            <span key={t} className="chip" style={{ fontSize: 11 }}>
              {FEEDBACK_POSITIVE_TAG_LABEL[t]}
            </span>
          ))}
          {feedback.improvement_tags.map((t) => (
            <span key={t} className="chip" style={{ fontSize: 11 }}>
              {FEEDBACK_IMPROVEMENT_TAG_LABEL[t]}
            </span>
          ))}
        </div>
      )}
      {feedback.comment && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.5 }}>
          &ldquo;{feedback.comment}&rdquo;
        </p>
      )}
    </div>
  );
}
