// Fixture for apra-fleet-btj9.9: FAIL-LOUD BACKSTOP (d). This file holds a
// deliberately invalid JavaScript construct -- a single-quoted string
// literal carrying a raw (unescaped) newline. Real JavaScript requires a
// literal that spans lines to be a template (backtick), so seeing this shape
// means scanModuleLiterals()'s own notion of where string literals begin and
// end has desynced from the real source. The scan must report this as a
// `parse-desync` violation (RAW_NEWLINE_IN_QUOTED_LITERAL_RE) rather than
// silently swallowing the rest of the file as a phantom string span and
// reporting the module clean.
//
// This module is never imported/executed by anything other than the
// explicit-id-create guard checker itself -- it is deliberately invalid JS,
// exactly like the constructs this backstop exists to catch.

const broken = 'this literal never closes on this line
and swallows everything after it as a phantom span until the desync backstop catches it
