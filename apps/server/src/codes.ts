import { randomBytes, randomInt } from 'node:crypto';

/** No vowels (avoids accidental words) and no easily confused glyphs. */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export function randomRoomCode(length = 4): string {
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function newToken(): string {
  return randomBytes(18).toString('base64url');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('base64url')}`;
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{4}$/.test(code) ? code : null;
}
