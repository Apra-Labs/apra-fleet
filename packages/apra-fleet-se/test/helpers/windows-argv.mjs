/**
 * Test-side model of what a NATIVE child process actually receives when
 * Windows PowerShell 5.1 runs `curl.exe ... -d '<quoted>' ...` -- the two
 * parsing stages a `-d` payload has to survive on a PowerShell member, which
 * the older PowerShell-dialect assertions stopped one stage short of:
 *
 *   1. PowerShell parses the source text. A single-quoted string literal
 *      `'...'` yields its contents verbatim, with `''` as the one escape for
 *      a literal `'`. (nextPowerShellStringLiteral below.)
 *   2. PowerShell's LEGACY native-command argument binder (Windows PowerShell
 *      5.1, and pwsh before 7.3's $PSNativeCommandArgumentPassing='Windows')
 *      builds the child's command line from those values: a value containing
 *      whitespace is wrapped in double quotes, and NOTHING inside it is
 *      escaped. (legacyBinderCommandLine below.)
 *   3. The child's C-runtime argv parser (CommandLineToArgvW / MSVC rules)
 *      splits that command line back into argv. (crtParseCommandLine below.)
 *
 * Stage 2 + 3 are the ones that stripped every `"` out of a JSON payload on
 * a live PowerShell member (verified on powershell.exe 5.1.19041: a
 * `-d '{"title":"x y"}'` argument reached a node argv probe as
 * `{title:x y}`). These functions are written from the documented rules of
 * each stage, NOT by inverting shQuote()'s own regex, so they would decode
 * any input the same way the real stack does -- including the broken form.
 *
 * ASCII only.
 */

/**
 * Stage 1: parse ONE PowerShell single-quoted string literal starting at
 * `start` (which must be a `'`). Returns its value and the index just past
 * the closing quote.
 * @param {string} src
 * @param {number} start
 * @returns {{ value: string, end: number }}
 */
export function nextPowerShellStringLiteral(src, start) {
    if (src[start] !== "'") {
        throw new Error(`expected a PowerShell single-quoted string literal at index ${start} of: ${src}`);
    }
    let i = start + 1;
    let out = '';
    while (i < src.length) {
        if (src[i] === "'") {
            if (src[i + 1] === "'") {
                out += "'";
                i += 2;
                continue;
            }
            return { value: out, end: i + 1 };
        }
        out += src[i];
        i += 1;
    }
    throw new Error(`unterminated PowerShell single-quoted string literal starting at index ${start} of: ${src}`);
}

/**
 * Stage 2: what the legacy binder puts on the child's command line for one
 * argument VALUE. Its NeedQuotes rule, as measured on powershell.exe
 * 5.1.19041 (and matching the PowerShell source's
 * NativeCommandParameterBinder.NeedQuotes): walk the value counting every
 * `"` -- a backslash-preceded `\"` COUNTS too on 5.1 -- and wrap the whole
 * value in double quotes only if some whitespace character occurs while
 * that count is even (i.e. "outside quotes" by the binder's own reckoning).
 * Nothing is ever escaped (that is the whole defect). Two measured
 * consequences this reproduces:
 *   - `{"title":"x y"}` is NOT wrapped (the space sits after an odd number
 *     of quotes), so the CRT strips every quote and yields `{title:x y}`;
 *   - `a\"b c` is NOT wrapped either (the `\"` counted), so the CRT reads
 *     the `\"` as a literal quote and then splits at the space.
 * (The PowerShell source also doubles TRAILING backslashes when it wraps;
 * not modelled here because no value the VCS builders emit ends in a
 * backslash and it was not part of the live measurement.)
 * @param {string} value
 * @returns {string}
 */
export function legacyBinderArgument(value) {
    let quoteCount = 0;
    let needQuotes = false;
    for (const ch of value) {
        if (ch === '"') quoteCount += 1;
        else if (/\s/.test(ch) && quoteCount % 2 === 0) needQuotes = true;
    }
    return needQuotes ? `"${value}"` : value;
}

/**
 * Stage 2 for a whole argv: the command line the child sees.
 * @param {string[]} values
 * @returns {string}
 */
export function legacyBinderCommandLine(values) {
    return values.map(legacyBinderArgument).join(' ');
}

/**
 * Stage 3: the MSVC C-runtime / CommandLineToArgvW argv split:
 *   - whitespace outside double quotes separates arguments
 *   - `"` toggles in-quotes (and is removed)
 *   - 2n backslashes followed by `"` -> n backslashes, then the quote rule
 *   - 2n+1 backslashes followed by `"` -> n backslashes + a literal `"`
 *   - backslashes not followed by `"` are literal
 * (The post-2008 CRT's `""`-inside-quotes rule is deliberately NOT modelled:
 * shQuote never emits it, and CommandLineToArgvW itself does not implement
 * it either, so modelling it would only make the simulator more lenient
 * than one real parser.)
 * @param {string} commandLine
 * @returns {string[]}
 */
export function crtParseCommandLine(commandLine) {
    const args = [];
    let i = 0;
    const n = commandLine.length;
    while (i < n) {
        while (i < n && /\s/.test(commandLine[i])) i += 1;
        if (i >= n) break;
        let arg = '';
        let inQuotes = false;
        while (i < n) {
            const ch = commandLine[i];
            if (ch === '\\') {
                let count = 0;
                while (i < n && commandLine[i] === '\\') { count += 1; i += 1; }
                if (i < n && commandLine[i] === '"') {
                    arg += '\\'.repeat(Math.floor(count / 2));
                    if (count % 2 === 1) {
                        arg += '"';
                        i += 1;
                    }
                    // even: the quote is handled by the next loop iteration
                } else {
                    arg += '\\'.repeat(count);
                }
                continue;
            }
            if (ch === '"') {
                inQuotes = !inQuotes;
                i += 1;
                continue;
            }
            if (!inQuotes && /\s/.test(ch)) break;
            arg += ch;
            i += 1;
        }
        args.push(arg);
    }
    return args;
}

/**
 * Round-trip ONE shQuote()-style PowerShell-dialect word through all three
 * stages, as the single argument of a native command: returns the string
 * the child process would find in its argv for that word.
 * @param {string} quotedWord   e.g. the text after ` -d ` in a built command
 * @returns {string}
 */
export function nativeArgFromPowerShellWord(quotedWord) {
    const { value, end } = nextPowerShellStringLiteral(quotedWord, 0);
    if (end !== quotedWord.length) {
        throw new Error(`trailing text after the PowerShell string literal: ${quotedWord.slice(end)}`);
    }
    const argv = crtParseCommandLine(legacyBinderCommandLine([value]));
    if (argv.length !== 1) {
        throw new Error(`expected exactly one native argument, the CRT parser produced ${argv.length}: ${JSON.stringify(argv)}`);
    }
    return argv[0];
}

/**
 * Extract the PowerShell-dialect word following ` -d ` in a built curl
 * command and return what curl.exe would receive as its -d value.
 * @param {string} command
 * @returns {string}
 */
export function nativeDashDPayload(command) {
    const marker = ' -d ';
    const idx = command.indexOf(marker);
    if (idx === -1) throw new Error(`expected a ' -d ' flag in: ${command}`);
    const { value, end } = nextPowerShellStringLiteral(command, idx + marker.length);
    const argv = crtParseCommandLine(legacyBinderCommandLine([value]));
    if (argv.length !== 1) {
        throw new Error(`the -d word split into ${argv.length} native arguments (expected 1): ${JSON.stringify(argv)} -- from: ${command.slice(idx, end)}`);
    }
    return argv[0];
}
