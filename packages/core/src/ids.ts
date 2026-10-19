// Ids, timestamps, tokens and random numbers, from the web platform's crypto,
// which Node and the Claude Code plugin both have.
// Part of twosystems, created by Shashikant.

const TOKEN = /^[A-Za-z0-9._:/@+-]{1,128}$/;

/** True when a value can be stored in a token field (session, model, version). */
export function isToken(value: string): boolean {
  return TOKEN.test(value);
}

/** A fresh event id. */
export function newId(): string {
  return crypto.randomUUID();
}

/** An RFC 3339 timestamp in UTC with milliseconds. */
export function timestamp(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}

/** A uniform random number in [0, 1) from 48 cryptographically random bits. */
export function secureRandom(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  const high = (words[0] ?? 0) & 0xffff;
  const low = words[1] ?? 0;
  return (high * 2 ** 32 + low) / 2 ** 48;
}
