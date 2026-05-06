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
