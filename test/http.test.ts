import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry, HttpError } from "../src/http.js";

const res = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers });

function setup(responses: (Response | Error)[]) {
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses queued");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const opts = { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async (ms: number) => void sleeps.push(ms), random: () => 1 };
  return { fetchImpl, sleeps, opts };
}

describe("fetchWithRetry", () => {
  it("returns the first successful response without sleeping", async () => {
    const { fetchImpl, sleeps, opts } = setup([res(200)]);
    expect((await fetchWithRetry("http://x", {}, opts)).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("retries 503 with exponential backoff, then succeeds", async () => {
    const { fetchImpl, sleeps, opts } = setup([res(503), res(503), res(200)]);
    await fetchWithRetry("http://x", {}, { ...opts, baseDelayMs: 100 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]); // random()=1 -> full delay, doubling each attempt
  });

  it("retries network errors", async () => {
    const { fetchImpl, opts } = setup([new TypeError("fetch failed"), res(200)]);
    await fetchWithRetry("http://x", {}, opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After seconds, capped at maxDelayMs", async () => {
    const { sleeps, opts } = setup([res(429, { "retry-after": "2" }), res(429, { "retry-after": "999" }), res(200)]);
    await fetchWithRetry("http://x", {}, { ...opts, maxDelayMs: 5_000 });
    expect(sleeps).toEqual([2_000, 5_000]);
  });

  it("honors a Retry-After HTTP date", async () => {
    const at = new Date(Date.now() + 3_000).toUTCString();
    const { sleeps, opts } = setup([res(503, { "retry-after": at }), res(200)]);
    await fetchWithRetry("http://x", {}, opts);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(3_000);
  });

  it("ignores a garbage Retry-After and falls back to backoff", async () => {
    const { sleeps, opts } = setup([res(503, { "retry-after": "soon" }), res(200)]);
    await fetchWithRetry("http://x", {}, { ...opts, baseDelayMs: 50 });
    expect(sleeps).toEqual([50]);
  });

  it("gives up after the configured retries and throws the last HttpError", async () => {
    const { fetchImpl, opts } = setup([res(500), res(500), res(502)]);
    await expect(fetchWithRetry("http://x", {}, { ...opts, retries: 2 })).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 400", async () => {
    const { fetchImpl, opts } = setup([res(400), res(200)]);
    await expect(fetchWithRetry("http://x", {}, opts)).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws the network error when it never recovers", async () => {
    const { opts } = setup([new TypeError("down"), new TypeError("down")]);
    await expect(fetchWithRetry("http://x", {}, { ...opts, retries: 1 })).rejects.toThrow("down");
  });

  it("passes an abort signal for the per-attempt timeout", async () => {
    const { fetchImpl, opts } = setup([res(200)]);
    await fetchWithRetry("http://x", { method: "POST" }, opts);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
