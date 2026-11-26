/**
 * Failure result shared by send_files and receive_files. The tool text stays
 * exactly what it always was; the MCP layer (tool-registry wrapTool) turns this
 * into isError: true with structuredContent {error, reason, detail}, the same
 * shape update_member's failures use. A full success stays a plain string.
 */

/** Settled reason values -- do not extend without updating the client typedefs. */
export type TransferFailureReason =
  | 'failed'             // no file succeeded, or the transfer threw
  | 'partial'            // some files failed
  | 'path-blocked'       // dest_subdir / remote_path outside the work folder
  | 'invalid-input'      // null bytes, basename collision, unreadable source, substitution failure
  | 'member-unavailable'; // member lookup / auth / key check failed

export interface TransferFailure {
  text: string;
  isError: true;
  structuredContent: { error: 'transfer-failed'; reason: TransferFailureReason; detail: string };
}

export function transferFailure(text: string, reason: TransferFailureReason): TransferFailure {
  return { text, isError: true, structuredContent: { error: 'transfer-failed', reason, detail: text } };
}
