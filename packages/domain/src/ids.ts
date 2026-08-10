// UUIDv7 helpers (_DECISIONS.md §4: UUIDv7 everywhere; time-ordered).
// Zero dependencies: uses globalThis.crypto (Node 20+/browsers). Time and
// randomness are injectable so tests stay deterministic (32 §12).

export interface Uuidv7Options {
  /** Unix epoch milliseconds; defaults to Date.now(). */
  now?: number;
  /** Fills a byte array with randomness; defaults to crypto.getRandomValues. */
  random?: (byteLength: number) => Uint8Array;
}

const HEX = "0123456789abcdef";

function defaultRandom(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** RFC 9562 UUIDv7: 48-bit unix-ms timestamp, version 7, variant 10. */
export function uuidv7(options: Uuidv7Options = {}): string {
  const now = options.now ?? Date.now();
  const random = options.random ?? defaultRandom;
  if (!Number.isInteger(now) || now < 0 || now > 2 ** 48 - 1) {
    throw new RangeError(`uuidv7: timestamp out of range: ${now}`);
  }

  const bytes = new Uint8Array(16);
  // 48-bit big-endian timestamp
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes.set(random(10), 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10

  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
    out += HEX[bytes[i]! >> 4]! + HEX[bytes[i]! & 0x0f]!;
  }
  return out;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isUuidv7(value: string): boolean {
  return isUuid(value) && value[14] === "7";
}

/** Extracts the unix-ms timestamp embedded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  if (!isUuidv7(id)) throw new RangeError(`not a UUIDv7: ${id}`);
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
