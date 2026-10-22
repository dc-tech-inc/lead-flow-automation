import { describe, expect, it } from "vitest";
import { computeMetrics, percentile } from "../src/metrics.js";
import type { Lead } from "../src/store.js";

const now = new Date("2026-06-30T12:00:00Z");

let n = 0;
function lead(over: Partial<Lead> & { respondAfterSec?: number }): Lead {
  n++;
  const receivedAt = over.receivedAt ?? new Date("2026-06-29T10:00:00Z");
  return {
    id: String(n),
    externalId: `e${n}`,
    source: "website-form",
    email: `a${n}@example.com`,
    name: "A",
    company: null,
    receivedAt,
    respondedAt: over.respondAfterSec === undefined ? (over.respondedAt ?? null) : new Date(receivedAt.getTime() + over.respondAfterSec * 1000),
    convertedAt: null,
    crmId: null,
    crmStatus: "pending",
    synthetic: true,
    ...over,
  };
}

describe("percentile", () => {
  it("returns null for no data", () => expect(percentile([], 0.5)).toBeNull());
  it("returns the only value for one sample", () => expect(percentile([7], 0.9)).toBe(7));
  it("interpolates between neighbours", () => {
    expect(percentile([10, 20], 0.5)).toBe(15);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([0, 100], 0.9)).toBeCloseTo(90);
  });
});

describe("computeMetrics", () => {
  it("reports an empty window", () => {
    const m = computeMetrics([], now, 30);
    expect(m).toMatchObject({ dataset: "empty", leads: 0, medianResponseSec: null, p90ResponseSec: null, conversionRate: 0, bySource: [], daily: [] });
  });

  it("computes median, p90 and conversion over responded leads", () => {
    const leads = [
      lead({ respondAfterSec: 60 }),
      lead({ respondAfterSec: 120 }),
      lead({ respondAfterSec: 600, convertedAt: new Date("2026-06-29T20:00:00Z") }),
      lead({}), // never answered: counts as a lead, not in the response time
    ];
    const m = computeMetrics(leads, now, 30);
    expect(m.leads).toBe(4);
    expect(m.responded).toBe(3);
    expect(m.medianResponseSec).toBe(120);
    expect(m.p90ResponseSec).toBeCloseTo(504);
    expect(m.converted).toBe(1);
    expect(m.conversionRate).toBe(0.25);
  });

  it("only counts leads inside the window", () => {
    const old = lead({ receivedAt: new Date("2026-05-01T00:00:00Z"), respondAfterSec: 99_999 });
    const recent = lead({ respondAfterSec: 30 });
    const m = computeMetrics([old, recent], now, 30);
    expect(m.leads).toBe(1);
    expect(m.medianResponseSec).toBe(30);
  });

  it("labels the dataset", () => {
    expect(computeMetrics([lead({ synthetic: true })], now, 30).dataset).toBe("synthetic");
    expect(computeMetrics([lead({ synthetic: false })], now, 30).dataset).toBe("live");
    expect(computeMetrics([lead({ synthetic: true }), lead({ synthetic: false })], now, 30).dataset).toBe("mixed");
  });

  it("groups by source and by UTC day", () => {
    const leads = [
      lead({ source: "newsletter", respondAfterSec: 100, receivedAt: new Date("2026-06-28T23:59:00Z") }),
      lead({ source: "website-form", respondAfterSec: 200, receivedAt: new Date("2026-06-29T00:01:00Z") }),
      lead({ source: "website-form", respondAfterSec: 400, receivedAt: new Date("2026-06-29T09:00:00Z") }),
    ];
    const m = computeMetrics(leads, now, 30);
    expect(m.bySource.map((s) => [s.source, s.leads])).toEqual([["newsletter", 1], ["website-form", 2]]);
    expect(m.daily).toEqual([
      { date: "2026-06-28", leads: 1, medianResponseSec: 100 },
      { date: "2026-06-29", leads: 2, medianResponseSec: 300 },
    ]);
  });

  it("ignores leads dated in the future", () => {
    const future = lead({ receivedAt: new Date("2026-07-02T00:00:00Z") });
    expect(computeMetrics([future], now, 30).leads).toBe(0);
  });
});
