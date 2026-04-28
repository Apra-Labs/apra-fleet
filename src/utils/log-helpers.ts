export function logLine(tag: string, msg: string): void {
  console.error(`[fleet] ${tag} ${msg}`);
}

export function maskSecrets(text: string): string {
  return text
    .replace(/\{\{secure\.[a-zA-Z0-9_]{1,64}\}\}/g, '[REDACTED]')
    .replace(/sec:\/\/[a-zA-Z0-9_]+/g, '[REDACTED]');
}

export function truncateForLog(text: string, maxLen = 80): string {
  const single = text.replace(/[\n\t]/g, ' ');
  return single.length <= maxLen ? single : single.slice(0, maxLen) + '...';
}
