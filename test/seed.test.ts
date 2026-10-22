import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/metrics.js";
import { generateSyntheticLeads, prng, seedStore } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";

const opts = { count: 200, days: 30, seed: 42, now: new Date("2026-06-30T12:00:00Z") };

describe("synthetic seed", () => {
  it("is deterministic for a given seed", () => {
    expect(generateSyntheticLeads(opts)).toEqual(generateSyntheticLeads(opts));
    expect(generateSyntheticLeads({ ...opts, seed: 43 })).not.toEqual(generateSyntheticLeads(opts));
  });

  it("prng stays in [0,1)", () => {
    const r = prng(1);
    for (let i = 0; i < 1000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("flags every lead synthetic, uses reserved example.com addresses and unique ids", () => {
    const leads = generateSyntheticLeads(opts);
    expect(leads).toHaveLength(200);
    expect(leads.every((l) => l.synthetic && l.email.endsWith("@example.com"))).toBe(true);
    expect(new Set(leads.map((l) => l.externalId)).size).toBe(200);
    expect(new Set(leads.map((l) => l.id)).size).toBe(200);
  });

  it("keeps timestamps consistent: received <= responded <= converted <= now", () => {
    for (const l of generateSyntheticLeads(opts)) {
      expect(l.receivedAt <= opts.now).toBe(true);
      if (l.respondedAt) expect(l.respondedAt >= l.receivedAt && l.respondedAt <= opts.now).toBe(true);
      if (l.convertedAt) {
        expect(l.respondedAt).not.toBeNull();
        expect(l.convertedAt >= (l.respondedAt as Date) && l.convertedAt <= opts.now).toBe(true);
      }
    }
  });

  it("produces a populated, labelled metrics view", () => {
    const m = computeMetrics(generateSyntheticLeads(opts), opts.now, 30);
    expect(m.dataset).toBe("synthetic");
    expect(m.bySource).toHaveLength(3);
    expect(m.medianResponseSec).toBeGreaterThan(0);
    expect(m.conversionRate).toBeGreaterThan(0);
    expect(m.conversionRate).toBeLessThan(1);
  });

  it("seedStore is idempotent", async () => {
    const store = new MemoryStore();
    expect(await seedStore(store, opts)).toBe(200);
    expect(await seedStore(store, opts)).toBe(0);
    expect(await store.count()).toBe(200);
  });
});
