const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** `crypto.getRandomValues` refuses to fill more than this many bytes in one call. */
const MAX_RANDOM_BYTES = 65_536;

/**
 * Random id for events and list entries (10 chars of a-z0-9 ≈ 51 bits).
 * Works in the renderer and in Node (both expose `globalThis.crypto`).
 */
export function newId(length = 10): string {
  let out = '';
  for (let done = 0; done < length; done += MAX_RANDOM_BYTES) {
    const bytes = new Uint8Array(Math.min(MAX_RANDOM_BYTES, length - done));
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}
