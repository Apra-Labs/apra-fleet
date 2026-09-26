// Custom node:test reporter -- the built-in reporters fall back to bare
// "tap" (no file grouping, no wall-clock time) whenever stdout isn't a TTY,
// which is always true when a test run's output is captured to a log file.
// This reporter prints an absolute ISO timestamp and the source file on
// every pass/fail/diagnostic line so captured logs stay readable.

function formatDuration(details) {
  const ms = details?.duration_ms;
  return typeof ms === 'number' ? `${ms.toFixed(1)}ms` : '';
}

// node:test reports a test FILE whose child process died without reporting any
// failing subtest as a single ERR_TEST_FAILURE with `stack: undefined` and
// `message: 'test failed'` -- every byte of identifying information lives in
// the sibling properties (failureType / exitCode / signal / code / cause), NOT
// in the stack. Printing only `stack || message` therefore renders such a
// failure completely anonymous: the summary says `# fail 1` and nothing in the
// log says which file, why, or with what exit status. Always dump the whole
// error shape so a CI log is self-sufficient.
function formatError(error, depth = 0) {
  if (error === null || error === undefined) return '';
  const indent = '  '.repeat(depth + 1);

  if (typeof error !== 'object') {
    return `${indent}${String(error)}\n`;
  }

  let out = '';
  if (error.stack) {
    out += `${indent}${String(error.stack).split('\n').join(`\n${indent}`)}\n`;
  } else if (error.message) {
    out += `${indent}${error.name ? `${error.name}: ` : ''}${error.message}\n`;
  }

  const meta = [];
  for (const key of ['code', 'failureType', 'exitCode', 'signal']) {
    if (error[key] !== undefined && error[key] !== null) {
      meta.push(`${key}=${String(error[key])}`);
    }
  }
  if (meta.length > 0) out += `${indent}(${meta.join(' ')})\n`;

  // A string `cause` duplicates the message on the exit-code path; only a
  // distinct cause is worth another block, and only a few levels deep so a
  // self-referential cause chain can never wedge the reporter.
  const cause = error.cause;
  const causeIsEchoedMessage =
    typeof cause === 'string' && cause === error.message;
  if (
    cause !== undefined &&
    cause !== null &&
    cause !== error &&
    !causeIsEchoedMessage &&
    depth < 3
  ) {
    const causeText = formatError(cause, depth + 1);
    if (causeText) out += `${indent}caused by:\n${causeText}`;
  }

  return out;
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
          yield formatError(details.error);
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
