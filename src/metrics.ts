import type { Lead } from "./store.js";

export interface SourceMetrics {
  source: string;
  leads: number;
  medianResponseSec: number | null;
  conversionRate: number;
}

export interface DayMetrics {
  date: string;
  leads: number;
  medianResponseSec: number | null;
}

export interface Metrics {
  windowDays: number;
  /** "synthetic" and "mixed" must be labelled as such wherever the numbers are shown. */
  dataset: "empty" | "synthetic" | "mixed" | "live";
  leads: number;
  responded: number;
  converted: number;
  medianResponseSec: number | null;
  p90ResponseSec: number | null;
  /** converted / leads received in the window. */
  conversionRate: number;
  bySource: SourceMetrics[];
  daily: DayMetrics[];
}

/** Linear-interpolation percentile of an ascending array; null when empty. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sortedAsc[lo] as number;
  const b = sortedAsc[hi] as number;
  return a + (b - a) * (idx - lo);
}

const responseSec = (l: Lead): number | null =>
  l.respondedAt ? (l.respondedAt.getTime() - l.receivedAt.getTime()) / 1000 : null;

const sortedResponses = (leads: Lead[]): number[] =>
  leads.map(responseSec).filter((s): s is number => s !== null).sort((a, b) => a - b);

const median = (leads: Lead[]) => percentile(sortedResponses(leads), 0.5);
const rate = (leads: Lead[]) => (leads.length === 0 ? 0 : leads.filter((l) => l.convertedAt).length / leads.length);

export function computeMetrics(allLeads: Lead[], now: Date, windowDays: number): Metrics {
  const since = now.getTime() - windowDays * 86_400_000;
  const leads = allLeads.filter((l) => l.receivedAt.getTime() >= since && l.receivedAt <= now);
  const sorted = sortedResponses(leads);

  const group = <K extends string>(key: (l: Lead) => K) => {
    const m = new Map<K, Lead[]>();
    for (const l of leads) m.set(key(l), [...(m.get(key(l)) ?? []), l]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  const synthetic = leads.filter((l) => l.synthetic).length;
  return {
    windowDays,
    dataset: leads.length === 0 ? "empty" : synthetic === leads.length ? "synthetic" : synthetic > 0 ? "mixed" : "live",
    leads: leads.length,
    responded: sorted.length,
    converted: leads.filter((l) => l.convertedAt).length,
    medianResponseSec: percentile(sorted, 0.5),
    p90ResponseSec: percentile(sorted, 0.9),
    conversionRate: rate(leads),
    bySource: group((l) => l.source).map(([source, ls]) => ({
      source,
      leads: ls.length,
      medianResponseSec: median(ls),
      conversionRate: rate(ls),
    })),
    daily: group((l) => l.receivedAt.toISOString().slice(0, 10)).map(([date, ls]) => ({
      date,
      leads: ls.length,
      medianResponseSec: median(ls),
    })),
  };
}
