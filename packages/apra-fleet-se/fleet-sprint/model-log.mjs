// One log line per settled dispatch naming the model that served it.
//
// The server reports a model id with a source: 'reported' (the provider CLI
// itself named the model that ran, e.g. the model keys of a Claude result's
// per-model usage) or 'resolved' (the id/alias the server mapped the requested
// tier to and handed to the CLI -- all that is known when the provider reports
// nothing). The line says which it is, so a provider-side substitution is not
// hidden behind the alias, and prints 'unknown' when nothing was reported.

/**
 * Collects the model id a dispatch reports and renders the log line.
 * Pass `onModelId` as the dispatch's `onModelId` option; call `line()` once
 * the dispatch settles (with the thrown error, if any).
 */
export function createModelReporter() {
    let id = null;
    let source = null;
    return {
        onModelId(modelId, meta) {
            id = modelId;
            source = (meta && meta.source) || null;
        },
        /** @param {unknown} [err] the dispatch error, if it failed */
        describe(err) {
            let modelId = id;
            let src = source;
            const d = err && typeof err === 'object' ? err.details : undefined;
            if (!modelId && d && typeof d.model === 'string' && d.model) {
                modelId = d.model;
                src = typeof d.modelSource === 'string' ? d.modelSource : null;
            }
            if (!modelId) return 'actual model unknown';
            if (src === 'reported') return `actual model ${modelId} (provider-reported)`;
            const alias = /^(cheap|standard|premium|opus|sonnet|haiku)$/i.test(modelId);
            return `actual model ${modelId} (resolved ${alias ? 'alias' : 'id'}, provider reported none)`;
        },
    };
}
