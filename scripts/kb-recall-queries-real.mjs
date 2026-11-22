// REAL recall-eval queries: kb_query calls agents actually made while working
// in this repository, copied VERBATIM (never edited) with relevance labels
// judged by hand against the bible entries each query should have found.
//
// Provenance: the recorded agent session transcripts of this repo's working
// copies (Claude Code session logs, one JSON line per tool call) were scanned
// on 2026-11-06 for every mcp__apra-fleet__kb_query tool_use input. That gave
// 78 recorded calls, 76 distinct query strings, issued 2026-10-10 .. 2026-11-06
// across 40+ sessions; none carried error_text. The planning document that
// first listed real queries is not in this checkout, so this recorded traffic
// is the source. `session` is the first 8 chars of the recording session id,
// `at` the recorded call time; together they identify the call.
//
// Of the 76 distinct strings:
//   - REAL (42): at least one bible entry answers the query; `expected` lists
//     every bible entry (8-char id prefix) a reader would accept as an answer.
//   - EXCLUDED_NO_BIBLE_ENTRY (32): no bible entry answers it (the knowledge
//     it looked for is not in the bible -- several such entries exist only in
//     a maintainer's local KB). Kept here so the judgement is auditable; they
//     are not scored, since a query with no relevant entry can never hit.
//   - 2 more were issued by the session that built this file (queries about
//     the eval itself) and are left out entirely.
//
// Real queries are exempt from the leakage cap (scripts/kb-recall-leakage.mjs):
// they were written by agents that did not know the answer, so any overlap
// with the target entry is how real traffic looks, not a restated answer.
// Their leakage is still computed and printed by the eval test.
export const REAL = [
  { query: 'kb_bible_commit', expected: ['7ec3c926'], session: 'dad08c49', at: '2026-10-10T03:42:50.173Z' },
  { query: 'kb-server token file bearer', expected: ['2d11a53b', '81df596b'], session: '69019da7', at: '2026-10-30T04:33:53.659Z' },
  { query: 'credentials.json write atomic credential store', expected: ['2e85c726'], session: '403799f3', at: '2026-10-30T04:45:41.026Z' },
  { query: 'HttpKbProvider token offline queue tryFlushQueue', expected: ['2d11a53b'], session: 'b8c81bf9', at: '2026-10-30T05:03:19.190Z' },
  { query: 'fleet_status kbHealthSummary KB provider', expected: ['81df596b', '176d4504'], session: 'b8c81bf9', at: '2026-10-30T05:03:19.950Z' },
  { query: 'named secret lookup credential store token_ref', expected: ['c4fb3b10', '2d11a53b'], session: 'b8c81bf9', at: '2026-10-30T05:03:20.383Z' },
  { query: 'member command environment provider auth env vars built for member', expected: ['bcd7c247', '93bbfb5a'], session: 'b8c81bf9', at: '2026-10-30T05:08:58.355Z' },
  { query: 'HTTP KB provider token offline queue flush', expected: ['2d11a53b'], session: '403799f3', at: '2026-10-30T05:26:07.583Z' },
  { query: 'named KB credentials secret placeholder E-KB-HTTP-AUTH kb-server token-file', expected: ['2d11a53b', '81df596b'], session: 'fa299099', at: '2026-10-30T05:44:50.767Z' },
  { query: 'secret set stdin refresher kb-server token-file e2e', expected: ['f8b2695a'], session: '403799f3', at: '2026-10-30T05:49:51.167Z' },
  { query: 'HttpKbProvider token secret credential-store', expected: ['2d11a53b', 'c4fb3b10'], session: '24aa635f', at: '2026-10-30T06:12:30.820Z' },
  { query: 'named secret 401 retry credential health lookupServerSecret secret --set', expected: ['2d11a53b', 'c4fb3b10', '81df596b', 'f8b2695a'], session: 'acd1ebc6', at: '2026-11-02T05:14:35.358Z' },
  { query: 'E-CODE-INDEX-NOT-READY retry polling code_status', expected: ['f5c5d252'], session: '51576cc7', at: '2026-11-04T03:51:52.849Z' },
  { query: 'test isolation APRA_FLEET_DATA_DIR temp git repos MCP client HTTP transport', expected: ['8e76e27c'], session: '51576cc7', at: '2026-11-04T03:56:03.850Z' },
  { query: 'indexNotReadyError readiness states code index building status.json', expected: ['f5c5d252'], session: '51576cc7', at: '2026-11-04T04:15:51.861Z' },
  { query: 'ensureDeployPermissions compose_permissions deploy permissions provisioner', expected: ['43bc4917', 'a4d684ba'], session: '8d819eda', at: '2026-11-04T04:26:28.599Z' },
  { query: 'client roots scope resolveSelfSession', expected: ['f40ed9c2'], session: '460726b7', at: '2026-11-04T05:58:56.965Z' },
  { query: 'FTS5 query sanitization orJoin tokenizer SEA build-sea native addon esbuild bundle dependency', expected: ['9b49976a', '2eadf404'], session: '4cc17777', at: '2026-11-05T09:15:28.042Z' },
  { query: 'SEA build native addon better-sqlite3 loader empty', expected: ['2eadf404', '1168f68e'], session: 'fe49bd21', at: '2026-11-05T09:31:07.321Z' },
  { query: 'fleet_status check-status KB section', expected: ['176d4504', '81df596b'], session: 'fe49bd21', at: '2026-11-05T09:31:07.809Z' },
  { query: 'KB recall evaluation sqlite provider query keyword embedding model none', expected: ['af351ced'], session: 'de69f0d9', at: '2026-11-05T10:02:32.902Z' },
  { query: 'kb_query member split read limit embedding SEA native addon', expected: ['71323701', '87f501b6'], session: '7b0a7f40', at: '2026-11-05T10:27:20.206Z' },
  { query: 'kb_query member session limit split read bible global', expected: ['71323701', '87f501b6', '48e12361'], session: '50d7ec22', at: '2026-11-05T10:48:04.750Z' },
  { query: 'FTS5 orJoinFtsTerms sanitization SqliteProvider query', expected: ['9b49976a', '45a64b2d'], session: 'd9413520', at: '2026-11-05T11:18:11.685Z' },
  { query: 'entries_fts triggers migration schema SqliteProvider init', expected: ['9b49976a', '1c6f3afa'], session: 'd9413520', at: '2026-11-05T11:18:12.382Z' },
  { query: 'sqlite kb.sqlite two handles WAL busy_timeout concurrent provider FTS', expected: ['0f432ed4', '45a64b2d'], session: '50d7ec22', at: '2026-11-05T11:51:29.765Z' },
  { query: 'SqliteProvider FTS entries_fts bm25 trigram index rebuild migration', expected: ['9b49976a'], session: '73ba9789', at: '2026-11-05T12:15:39.215Z' },
  { query: 'keyword index normalization test migration old schema', expected: ['9b49976a'], session: '73ba9789', at: '2026-11-05T12:15:39.531Z' },
  { query: 'sqlite provider fts entries_fts migration WAL busy_timeout', expected: ['9b49976a', '0f432ed4', '45a64b2d'], session: '4f280895', at: '2026-11-05T12:24:52.074Z' },
  { query: 'embedder model profile failure state embedding', expected: ['ab967e3e'], session: '786048b7', at: '2026-11-05T12:31:18.335Z' },
  { query: 'keyword index version background rebuild metadata table', expected: ['9b49976a'], session: '786048b7', at: '2026-11-05T12:31:19.083Z' },
  { query: 'background rebuild claim owner heartbeat two processes kb.sqlite', expected: ['0f432ed4'], session: '786048b7', at: '2026-11-05T12:42:31.083Z' },
  { query: 'SqliteProvider query hybrid fusion semantic vectors anchors lookupAnchors', expected: ['af351ced', '1c6f3afa'], session: 'fa2421a1', at: '2026-11-05T14:38:24.473Z' },
  { query: 'kb_query splitQuery member merge bible half', expected: ['71323701', '87f501b6'], session: 'fa2421a1', at: '2026-11-05T14:38:25.218Z' },
  { query: 'hybrid kb_query reciprocal rank fusion error_text files symbols', expected: ['af351ced'], session: '883bea9f', at: '2026-11-05T16:41:46.927Z' },
  { query: 'kb_query hybrid search reciprocal rank fusion files symbols error_text', expected: ['af351ced'], session: '9a81e5ab', at: '2026-11-05T16:44:27.022Z' },
  { query: 'kb_query hybrid vector store embedding fallback', expected: ['af351ced', '1c6f3afa', 'ab967e3e'], session: '75602fd7', at: '2026-11-05T17:10:22.415Z' },
  { query: 'embedding blocks event loop member bible view embedder', expected: ['ab967e3e'], session: '5a404b6c', at: '2026-11-05T17:32:30.376Z' },
  { query: 'embedder onnxruntime worker thread SEA wasm asset', expected: ['2eadf404', '1168f68e'], session: '495148cc', at: '2026-11-05T23:30:52.710Z' },
  { query: 'embed queue drain warm up model load retry backoff', expected: ['ab967e3e', '1c6f3afa'], session: '495148cc', at: '2026-11-05T23:56:45.795Z' },
  { query: 'embed worker thread onnxruntime model download deadline', expected: ['1168f68e', '2eadf404'], session: 'e90a4f13', at: '2026-11-06T01:25:16.997Z' },
  { query: 'embedding worker thread model download', expected: ['1168f68e'], session: '6dda15a4', at: '2026-11-06T01:40:08.749Z' },
];

/** Recorded queries with no answering bible entry (not scored; see header). */
export const EXCLUDED_NO_BIBLE_ENTRY = [
  'kb_import member session committed bible HEAD trust',
  'reconcilePrefilter hash-basis contradiction',
  'kb_import committed bible trust kb_maintainer',
  'kb_import bible trust maintainer HEAD',
  'permission denied heal dispatch-role healPermissionDenial',
  'createPermissionDenialHeal grantWithinPolicy compose_permissions heal',
  'recorded claude result fixture permission_denials test',
  'role prompt agents shared fragment loader',
  'permission denial heal compound shell grant',
  'kb-bible-backfill tmpdir listing flaky',
  'LLM CLI path resolution member PATH nvm npm prefix',
  'LLM CLI path resolution member PATH nvm',
  'member install standalone server detached start no service manager',
  'AUTOSTART_VERSION_UNKNOWN clientServerVersion expected version auto-start',
  'kb-bible-backfill tmpdir leak check',
  'member install standalone server service manager auto-start version',
  'permission denial heal shell loop nudge dispatchRole',
  'regression playbook canary claude CLI version',
  'LLM CLI path resolver member llmCli',
  'LLM CLI resolver absolute path llmCli',
  'llm cli resolver ensureMemberLlmCli probe default PATH',
  'llm cli resolver default-path probe_failed',
  'permission denial heal shell loop',
  'resolveSelfSession FULL session scope server working folder',
  'gitnexus resolvesToRequested Target not found mjs symbol',
  'gitnexus incremental analyze blank symbol rows not found',
  'kb config readKbConfigFromDisk embedding',
  'code intelligence provider import cycle KB enrich resolver',
  'recall eval queries per CONFIRMED bible entry kb-canonical',
  'KB recall eval queries.json fixture CONFIRMED bible coverage',
  'model store download sha256 models folder path',
  'built server health endpoint singleton timeout responsiveness',
];
