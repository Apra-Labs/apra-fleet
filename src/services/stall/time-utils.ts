/** Format elapsed milliseconds as MM:SS for status display, e.g. "02:14". */
export function fmtElapsed(ms: number): string {
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function toLocalISOString(ms: number): string {
  const offset = new Date(ms).getTimezoneOffset();
  const offsetMin = offset;
  const sign = offsetMin <= 0 ? '+' : '-';
  const absOffsetMin = Math.abs(offsetMin);
  const hours = Math.floor(absOffsetMin / 60);
  const minutes = absOffsetMin % 60;
  const pad = (n: number) => String(n).padStart(2, '0');

  // Adjust ms to local time by subtracting the offset
  const localMs = ms - offsetMin * 60000;
  const localDate = new Date(localMs);

  // Get ISO string and replace Z with the correct offset
  const isoStr = localDate.toISOString();
  return isoStr.replace('Z', `${sign}${pad(hours)}:${pad(minutes)}`);
}
