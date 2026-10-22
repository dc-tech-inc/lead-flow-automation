import { describe, expect, it } from "vitest";
import { sign, verify } from "../src/signature.js";

const secret = "test-secret-0123456789";
const body = Buffer.from(JSON.stringify({ type: "lead.created" }));
const now = 1_800_000_000;

const check = (over: Partial<Parameters<typeof verify>[0]> = {}) =>
  verify({ secret, signature: sign(secret, now, body), timestamp: String(now), rawBody: body, nowSec: now, ...over });

describe("webhook signature", () => {
  it("accepts a correctly signed body", () => {
    expect(check()).toEqual({ ok: true });
  });

  it("is a stable sha256= hex digest", () => {
    expect(sign(secret, now, body)).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sign(secret, now, body)).toBe(sign(secret, now, body.toString()));
  });

  it("rejects a tampered body", () => {
    expect(check({ rawBody: Buffer.from('{"type":"lead.converted"}') })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a different secret", () => {
    expect(check({ signature: sign("another-secret-0123456", now, body) })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects when the timestamp was swapped after signing", () => {
    expect(check({ timestamp: String(now + 1) })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects missing headers", () => {
    expect(check({ signature: undefined })).toEqual({ ok: false, reason: "missing" });
    expect(check({ timestamp: undefined })).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects malformed headers", () => {
    expect(check({ signature: "md5=abc" })).toEqual({ ok: false, reason: "malformed" });
    expect(check({ timestamp: "yesterday" })).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(check({ signature: "sha256=abcd" })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects stale and future timestamps beyond the tolerance, accepts the boundary", () => {
    const old = now - 301;
    expect(check({ timestamp: String(old), signature: sign(secret, old, body) })).toEqual({ ok: false, reason: "stale" });
    const future = now + 301;
    expect(check({ timestamp: String(future), signature: sign(secret, future, body) })).toEqual({ ok: false, reason: "stale" });
    const edge = now - 300;
    expect(check({ timestamp: String(edge), signature: sign(secret, edge, body) })).toEqual({ ok: true });
  });
});
