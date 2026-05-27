// agy-transcript-reader.js -- reads the Antigravity CLI conversation transcript.
//
// Tries two strategies to locate the transcript:
//   1. Direct UUID lookup: brain/<convId>/.system_generated/logs/transcript.jsonl
//      (when agy honors --conversation)
//   2. Folder-based lookup: last_conversations.json[workFolder]
//      (when agy ignores --conversation and registers under its work folder,
//      which happens for local members in a git repo)
//
// argv[1] = conversation UUID that fleet minted and passed via --conversation
// argv[2] = work folder path for the fallback lookup

const fs = require('fs');
const path = require('path');

try {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const convId = process.argv[2];
  const workDir = process.argv[3] || '';

  function readTranscript(id) {
    const tp = path.join(
      home, '.gemini', 'antigravity-cli', 'brain',
      id, '.system_generated', 'logs', 'transcript.jsonl'
    );
    if (fs.existsSync(tp)) {
      console.log('FLEET_TRANSCRIPT_START');
      console.log(fs.readFileSync(tp, 'utf8'));
      console.log('FLEET_TRANSCRIPT_END');
      return true;
    }
    return false;
  }

  // Strategy 1: direct UUID lookup
  if (convId && readTranscript(convId)) {
    process.exit(0);
  }

  // Strategy 2: folder-based lookup via last_conversations.json
  const cachePath = path.join(
    home, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json'
  );
  if (workDir && fs.existsSync(cachePath)) {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const norm = (p) => path.resolve(p).toLowerCase().split(path.sep).join('/');
    const target = norm(workDir);
    for (const k of Object.keys(cache)) {
      if (norm(k) === target) {
        if (readTranscript(cache[k])) {
          process.exit(0);
        }
        break;
      }
    }
    console.log('FLEET_TRANSCRIPT_MISSING:NOT_IN_CACHE:' + target);
  } else {
    console.log('FLEET_TRANSCRIPT_MISSING:' + (convId || 'NO_ID'));
  }
} catch (e) {
  console.log('FLEET_TRANSCRIPT_ERROR:' + e.message);
}
