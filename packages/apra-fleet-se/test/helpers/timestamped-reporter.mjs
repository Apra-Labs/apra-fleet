// Custom node:test reporter -- the built-in reporters fall back to bare
// "tap" (no file grouping, no wall-clock time) whenever stdout isn't a TTY,
// which is always true when a test run's output is captured to a log file.
// This reporter prints an absolute ISO timestamp and the source file on
// every pass/fail/diagnostic line so captured logs stay readable.

function formatDuration(details) {
  const ms = details?.duration_ms;
  return typeof ms === 'number' ? `${ms.toFixed(1)}ms` : '';
}

export default async function* timestampedReporter(source) {
  let passCount = 0;
  let failCount = 0;

  for await (const event of source) {
    const ts = new Date().toISOString();

    switch (event.type) {
      case 'test:pass': {
        passCount += 1;
        const { file, name, details } = event.data;
        yield `[${ts}] PASS ${file ?? '(unknown file)'} :: ${name} (${formatDuration(details)})\n`;
        break;
      }
      case 'test:fail': {
        failCount += 1;
        const { file, name, details } = event.data;
        yield `[${ts}] FAIL ${file ?? '(unknown file)'} :: ${name} (${formatDuration(details)})\n`;
        if (details?.error) {
          yield `${details.error.stack || details.error.message}\n`;
        }
        break;
      }
      case 'test:diagnostic': {
        yield `[${ts}] # ${event.data.message}\n`;
        break;
      }
      case 'test:stderr': {
        yield `[${ts}] STDERR ${event.data.file ?? ''} ${event.data.message}`;
        break;
      }
      default:
        break;
    }
  }

  const ts = new Date().toISOString();
  yield `[${ts}] SUMMARY pass=${passCount} fail=${failCount}\n`;
}
