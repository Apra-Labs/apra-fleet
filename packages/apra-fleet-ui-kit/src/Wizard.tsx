import { useState, type ReactNode } from "react";
import { colors, spacing, typography } from "./tokens.js";

export interface WizardStep {
  /** Unique step id, used as the React key and the step-list aria marker. */
  key: string;
  /** Step label shown in the step list. */
  title: string;
  /** Step body. Re-rendered by the caller on every keystroke via closures. */
  content: ReactNode;
  /**
   * Called before advancing past this step. Return a message naming the
   * invalid field to block the transition, or null/undefined when the step
   * is valid.
   */
  validate?: () => string | null | undefined;
}

export interface WizardProps {
  steps: WizardStep[];
  /** Called when Next/Submit is activated on the last step and validation passes. */
  onSubmit: () => void;
  /** Label for the final step's action button. Defaults to "Submit". */
  submitLabel?: string;
  /**
   * Error surfaced on the final step (e.g. a server-side submit failure).
   * The caller keeps all entered field state intact when this is set --
   * the Wizard itself never discards step content on error.
   */
  submitError?: string | null;
}

/**
 * Minimal presentational multi-step form primitive: a step list, the active
 * step's content, per-step validation and Back/Next/Submit navigation. Field
 * state and submission live entirely with the caller -- this component only
 * owns which step is active.
 */
export function Wizard({ steps, onSubmit, submitLabel = "Submit", submitError }: WizardProps) {
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const activeIndex = Math.min(index, steps.length - 1);
  const step = steps[activeIndex];
  const isLast = activeIndex === steps.length - 1;

  function handleNext() {
    const validationError = step.validate ? step.validate() : null;
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    if (isLast) {
      onSubmit();
    } else {
      setIndex((current) => current + 1);
    }
  }

  function handleBack() {
    setError(null);
    setIndex((current) => Math.max(0, current - 1));
  }

  return (
    <div style={{ fontFamily: typography.fontFamily, color: colors.textPrimary }}>
      <ol
        style={{
          display: "flex",
          gap: spacing.md,
          listStyle: "none",
          padding: 0,
          margin: 0,
          marginBottom: spacing.md
        }}
      >
        {steps.map((s, i) => (
          <li
            key={s.key}
            aria-current={i === activeIndex ? "step" : undefined}
            style={{
              fontSize: typography.fontSizeSm,
              color: i === activeIndex ? colors.accent : colors.textSecondary,
              fontWeight: i === activeIndex ? typography.fontWeightBold : typography.fontWeightRegular
            }}
          >
            {s.title}
          </li>
        ))}
      </ol>

      <div>{step.content}</div>

      {error ? (
        <p role="alert" style={{ color: colors.danger }}>
          {error}
        </p>
      ) : null}

      {isLast && submitError ? (
        <p role="alert" style={{ color: colors.danger }}>
          {submitError}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md }}>
        {activeIndex > 0 ? (
          <button type="button" onClick={handleBack}>
            Back
          </button>
        ) : null}
        <button type="button" onClick={handleNext}>
          {isLast ? submitLabel : "Next"}
        </button>
      </div>
    </div>
  );
}
