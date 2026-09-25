import type { ReactNode } from "react";
import { colors, spacing, typography } from "./tokens.js";

export interface DrawerProps {
  /** Controls visibility. When false, the Drawer renders nothing. */
  open: boolean;
  /** Heading rendered at the top of the drawer. */
  title: string;
  /** Optional secondary text rendered under the title. */
  subtitle?: string;
  /** Called when the user dismisses the drawer (close button or overlay click). */
  onClose: () => void;
  /** Content slot for the drawer body. */
  children?: ReactNode;
}

/**
 * Minimal presentational side-panel primitive: an overlay plus a fixed panel
 * with a title, close control and a content slot. No data fetching -- the
 * caller owns what is shown and what each control does.
 */
export function Drawer({ open, title, subtitle, onClose, children }: DrawerProps) {
  if (!open) return null;

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        justifyContent: "flex-end",
        backgroundColor: "rgba(0, 0, 0, 0.4)",
        zIndex: 50
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(420px, 100%)",
          height: "100%",
          overflowY: "auto",
          backgroundColor: colors.surface,
          borderLeft: `1px solid ${colors.border}`,
          fontFamily: typography.fontFamily,
          color: colors.textPrimary
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            padding: spacing.lg,
            borderBottom: `1px solid ${colors.border}`
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: typography.fontSizeLg,
                fontWeight: typography.fontWeightBold
              }}
            >
              {title}
            </h2>
            {subtitle ? (
              <p
                style={{
                  margin: 0,
                  marginTop: spacing.xs,
                  fontSize: typography.fontSizeSm,
                  color: colors.textSecondary
                }}
              >
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: colors.textSecondary,
              fontSize: typography.fontSizeLg,
              cursor: "pointer"
            }}
          >
            x
          </button>
        </header>
        <div style={{ padding: spacing.lg }}>{children}</div>
      </div>
    </div>
  );
}
