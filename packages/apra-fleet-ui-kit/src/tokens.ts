// Design tokens for the Apra Fleet dashboard UI.
// Presentational only: no data fetching, no routing, no provider identifiers.

export const colors = {
  background: "#0b0f14",
  surface: "#131a22",
  surfaceRaised: "#1b242f",
  border: "#2a3542",
  textPrimary: "#e6edf3",
  textSecondary: "#9aa7b2",
  accent: "#4f8cff",
  success: "#3fb950",
  warning: "#d29922",
  danger: "#f85149"
} as const;

export const spacing = {
  xs: "4px",
  sm: "8px",
  md: "16px",
  lg: "24px",
  xl: "32px"
} as const;

export const radii = {
  sm: "4px",
  md: "8px",
  lg: "12px"
} as const;

export const typography = {
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontSizeSm: "12px",
  fontSizeMd: "14px",
  fontSizeLg: "18px",
  fontSizeXl: "24px",
  fontWeightRegular: 400,
  fontWeightMedium: 500,
  fontWeightBold: 700
} as const;

export type Colors = typeof colors;
export type Spacing = typeof spacing;
export type Radii = typeof radii;
export type Typography = typeof typography;
