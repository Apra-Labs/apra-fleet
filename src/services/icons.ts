// 8 colors × 2 shapes (circle + square) = 16 icons
// Circles assigned first (primary), squares second (for pairing)
const ICON_POOL = [
  '🔵', '🟢', '🔴', '🟡', '🟣', '🟠', '🟤', '⚫',  // circles
  '🟦', '🟩', '🟥', '🟨', '🟪', '🟧', '🟫', '⬛',  // squares
];

export const DEFAULT_ICON = '⚪';

// Named aliases so callers don't need to type emoji
// Pattern: {color}-{shape} — consistent 8 colors × 2 shapes
const ICON_NAMES: Record<string, string> = {
  'blue-circle': '🔵', 'green-circle': '🟢', 'red-circle': '🔴',
  'yellow-circle': '🟡', 'purple-circle': '🟣', 'orange-circle': '🟠',
  'brown-circle': '🟤', 'black-circle': '⚫',
  'blue-square': '🟦', 'green-square': '🟩', 'red-square': '🟥',
  'yellow-square': '🟨', 'purple-square': '🟪', 'orange-square': '🟧',
  'brown-square': '🟫', 'black-square': '⬛',
};

/** Resolve a named icon to its emoji, or return the input if already emoji. */
export function resolveIcon(input: string): string {
  return ICON_NAMES[input.toLowerCase()] ?? input;
}

/**
 * Pick the first unused icon from the pool.
 * If all are taken, append a number suffix (e.g., "🔵2").
 */
export function assignIcon(existingIcons: string[]): string {
  const used = new Set(existingIcons);
  for (const icon of ICON_POOL) {
    if (!used.has(icon)) return icon;
  }
  // All base icons taken — append a number suffix
  // Safety cap at 99 to avoid unbounded loop
  for (let n = 2; n <= 99; n++) {
    for (const icon of ICON_POOL) {
      const candidate = `${icon}${n}`;
      if (!used.has(candidate)) return candidate;
    }
  }
  // Extremely unlikely: all 16 * 98 suffixed slots taken, just return last candidate
  return `${ICON_POOL[0]}100`;
}

// Pattern for overflow icons: emoji + digits (e.g., "🔵2", "🔵100")
const OVERFLOW_PATTERN = /^.{1,2}\d+$/u;

/**
 * Check if an icon string is valid: must be in the pool, match the overflow
 * pattern (emoji + digits), or contain at least one character in the emoji
 * Unicode range (codepoint >= 0x1F000). Rejects ASCII-only strings and
 * control characters.
 */
export function isValidIcon(icon: string): boolean {
  if (!icon || icon.length > 8) return false;
  if (ICON_POOL.includes(icon)) return true;
  if (OVERFLOW_PATTERN.test(icon)) return true;
  // Must contain at least one emoji-range character (U+1F000+)
  for (const ch of icon) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1F000) return true;
  }
  return false;
}
