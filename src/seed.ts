import type { Lead, LeadStore } from "./store.js";

/** mulberry32: a tiny seeded PRNG so the same seed always yields the same dataset. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Invented sources with invented conversion rates. These numbers are inputs to the generator,
// not findings: the dashboard over this data demonstrates the pipeline, not any real effect.
const SOURCES = [
  { name: "website-form", weight: 0.5, medianMin: 6, convert: 0.24 },
  { name: "newsletter", weight: 0.3, medianMin: 14, convert: 0.17 },
  { name: "event-signup", weight: 0.2, medianMin: 25, convert: 0.31 },
] as const;

const GIVEN = ["Ada", "Ben", "Chloe", "Dev", "Elena", "Femi", "Grace", "Hugo", "Iris", "Jon", "Kira", "Leo"];
const FAMILY = ["Rivera", "Okafor", "Lindqvist", "Tanaka", "Moreau", "Haddad", "Novak", "Silva", "Brandt", "Costa"];

export interface SeedOptions {
  count: number;
  days: number;
  seed: number;
  now: Date;
}

/** Deterministic synthetic leads. Every lead is flagged `synthetic` and uses reserved example.com addresses. */
export function generateSyntheticLeads({ count, days, seed, now }: SeedOptions): Lead[] {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const leads: Lead[] = [];

  for (let i = 0; i < count; i++) {
    const roll = rnd();
    let acc = 0;
    const source = SOURCES.find((s) => (acc += s.weight) >= roll) ?? SOURCES[0];
    const receivedAt = new Date(now.getTime() - rnd() * days * 86_400_000);

    // Log-normal-ish response time around the source median (Box-Muller), 8% never answered.
    const gauss = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    const responseMs = source.medianMin * 60_000 * Math.exp(0.6 * gauss);
    const respondedAt = rnd() < 0.92 ? new Date(Math.min(receivedAt.getTime() + responseMs, now.getTime())) : null;
    const convertedAt =
      respondedAt && rnd() < source.convert
        ? new Date(Math.min(respondedAt.getTime() + (1 + rnd() * 48) * 3_600_000, now.getTime()))
        : null;

    const given = pick(GIVEN);
    const family = pick(FAMILY);
    leads.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      externalId: `synthetic-${seed}-${i}`,
      source: source.name,
      email: `${given}.${family}${i}@example.com`.toLowerCase(),
      name: `${given} ${family}`,
      company: null,
      receivedAt,
      respondedAt,
      convertedAt,
      crmId: null,
      crmStatus: "pending",
      synthetic: true,
    });
  }
  return leads;
}

export async function seedStore(store: LeadStore, opts: SeedOptions): Promise<number> {
  let inserted = 0;
  for (const lead of generateSyntheticLeads(opts)) {
    if ((await store.create(lead)).created) inserted++;
  }
  return inserted;
}
