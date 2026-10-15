import { randomBytes } from 'node:crypto';

/**
 * ALPHABET is the RFC 4648 base32 alphabet in lowercase, chosen so ids are safe
 * in URLs, shells and SQL without quoting.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/**
 * ID_LENGTH is the number of random characters after the prefix (20, i.e. 100
 * bits).
 */
const ID_LENGTH = 20;

/**
 * IdPrefix names the kinds of ids agent-link mints: ag (agent), cv
 * (conversation), msg (message), tok (token), ev (event), inc (guard incident).
 */
export type IdPrefix = 'ag' | 'cv' | 'msg' | 'tok' | 'ev' | 'inc';

/**
 * newId returns a fresh identifier of the form <prefix>_<20 lowercase base32
 * chars>, drawn from crypto randomness; collisions are negligible and callers
 * may treat ids as unique.
 */
export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes(ID_LENGTH);
  let out = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ALPHABET[(bytes[i] ?? 0) & 31];
  }
  return `${prefix}_${out}`;
}
