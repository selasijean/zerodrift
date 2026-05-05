/**
 * Stable string-to-int hash (djb2-style). Used by `ModelRegistry.schemaHash`
 * and the schema compiler's per-entity `schemaVersion`. Not cryptographic —
 * just deterministic across runs and cheap. Returns a non-negative integer.
 */
export function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
