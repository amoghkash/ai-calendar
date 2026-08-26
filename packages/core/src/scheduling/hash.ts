/**
 * Small stable string hash (FNV-1a). Used to derive deterministic run ids so a
 * scheduling run can be replayed byte-for-byte from the same input.
 */
export function stableHash(parts: readonly (string | number)[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
