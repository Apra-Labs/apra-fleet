// Leakage check for the recall eval set: a query must not restate the entry it
// is labelled with. Content tokens = lowercase [a-z0-9]+ runs of length >= 3
// minus STOPWORDS; leakage = share of the query's content tokens that also
// appear in the target entry's title + summary. Cap: LEAKAGE_CAP.
export const LEAKAGE_CAP = 0.5;
export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'not', 'but', 'has', 'have',
  'had', 'its', 'any', 'can', 'all', 'also', 'into', 'than', 'then', 'there', 'when', 'what', 'which',
  'who', 'how', 'why', 'where', 'while', 'though', 'although', 'does', 'did', 'doing', 'done', 'out',
  'one', 'two', 'new', 'old', 'own', 'same', 'only', 'just', 'still', 'even', 'ever', 'after', 'before',
  'about', 'would', 'should', 'could', 'need', 'needs', 'get', 'gets', 'got', 'use', 'used', 'using',
  'say', 'says', 'see', 'sees', 'but', 'too', 'yet', 'via', 'per', 'more', 'most', 'some', 'such', 'each',
  'every', 'their', 'them', 'they', 'you', 'your', 'our', 'his', 'her', 'she', 'him', 'now', 'because',
  'since', 'until', 'over', 'under', 'between', 'without', 'within', 'being', 'been', 'will', 'want',
  'wants', 'tried', 'trying', 'try', 'like', 'seems', 'seem', 'though', 'expected', 'instead', 'something',
]);
export function contentTokens(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length >= 3 && !STOPWORDS.has(t));
}
/** Share of the query's content tokens (distinct) found in the entry title + summary. */
export function leakage(query, entry) {
  const q = [...new Set(contentTokens(query))];
  if (q.length === 0) return 0;
  const e = new Set(contentTokens(`${entry.title} ${entry.summary}`));
  return q.filter(t => e.has(t)).length / q.length;
}
