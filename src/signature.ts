import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-signature";
export const TIMESTAMP_HEADER = "x-timestamp";
const PREFIX = "sha256=";

/** Signature over `${timestamp}.${rawBody}`, so a captured body cannot be replayed with a new timestamp. */
export function sign(secret: string, timestamp: number | string, rawBody: string | Buffer): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return PREFIX + mac;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

export interface VerifyInput {
  secret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer;
  nowSec: number;
  toleranceSec?: number;
}

// ponytail: no nonce store, so a replay inside the tolerance window is accepted; every event
// handler is idempotent by externalId. Add a nonce cache if non-idempotent events appear.
export function verify(input: VerifyInput): VerifyResult {
  const { secret, signature, timestamp, rawBody, nowSec, toleranceSec = 300 } = input;
  if (!signature || !timestamp) return { ok: false, reason: "missing" };
  if (!/^\d{1,12}$/.test(timestamp) || !signature.startsWith(PREFIX)) return { ok: false, reason: "malformed" };
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) return { ok: false, reason: "stale" };
  const expected = Buffer.from(sign(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}
