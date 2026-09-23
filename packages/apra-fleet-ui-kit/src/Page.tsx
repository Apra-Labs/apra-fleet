import type { ReactNode } from "react";
import { colors, spacing, typography } from "./tokens.js";

export interface PageProps {
  /** Page title rendered in the shell header. */
  title: string;
  /** Optional secondary text rendered under the title. */
  subtitle?: string;
  /** Content slot for the page body. */
  children?: ReactNode;
}

/**
 * Minimal presentational page shell: title (+ optional subtitle) and a
 * content slot. No data fetching, no routing.
 */
export function Page({ title, subtitle, children }: PageProps) {
  return (
    <div
      style={{
        fontFamily: typography.fontFamily,
        color: colors.textPrimary,
        backgroundColor: colors.background,
        minHeight: "100%"
      }}
    >
      <header
        style={{
          padding: spacing.lg,
          borderBottom: `1px solid ${colors.border}`
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: typography.fontSizeXl,
            fontWeight: typography.fontWeightBold
          }}
        >
          {title}
        </h1>
        {subtitle ? (
          <p
            style={{
              margin: 0,
              marginTop: spacing.xs,
              fontSize: typography.fontSizeMd,
              color: colors.textSecondary
            }}
          >
            {subtitle}
          </p>
        ) : null}
      </header>
      <div style={{ padding: spacing.lg }}>{children}</div>
    </div>
  );
}
