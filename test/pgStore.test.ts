import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgStore } from "../src/pgStore.js";
import type { Lead } from "../src/store.js";

// Integration test: needs a real PostgreSQL. CI provides one; locally set DATABASE_URL to run it.
const url = process.env.DATABASE_URL;

const mk = (over: Partial<Lead> = {}): Lead => ({
  id: randomUUID(),
  externalId: `pg-test-${randomUUID()}`,
  source: "website-form",
  email: "pg@example.com",
  name: "Pg Test",
  company: null,
  receivedAt: new Date(),
  respondedAt: null,
  convertedAt: null,
  crmId: null,
  crmStatus: "pending",
  synthetic: true,
  ...over,
});

describe.skipIf(!url)("PgStore (needs DATABASE_URL)", () => {
  let store: PgStore;
  beforeAll(async () => {
    store = PgStore.connect(url as string);
    await store.migrate();
    await store.migrate(); // idempotent
  });
  afterAll(async () => {
    await store.close();
  });

  it("round-trips a lead and enforces external_id uniqueness", async () => {
    const lead = mk();
    const first = await store.create(lead);
    expect(first.created).toBe(true);
    expect(first.lead).toMatchObject({ externalId: lead.externalId, crmStatus: "pending", synthetic: true });

    const dup = await store.create(mk({ externalId: lead.externalId, name: "Other" }));
    expect(dup.created).toBe(false);
    expect(dup.lead.name).toBe("Pg Test");
    expect(await store.findByExternalId("does-not-exist")).toBeNull();
  });

  it("updates only the patched columns", async () => {
    const lead = mk();
    await store.create(lead);
    const respondedAt = new Date(lead.receivedAt.getTime() + 60_000);
    const updated = await store.update(lead.externalId, { respondedAt, crmStatus: "synced", crmId: "crm_9", company: "Acme" });
    expect(updated).toMatchObject({ crmStatus: "synced", crmId: "crm_9", company: "Acme", name: "Pg Test" });
    expect(updated?.respondedAt?.getTime()).toBe(respondedAt.getTime());
    expect((await store.update(lead.externalId, {}))?.externalId).toBe(lead.externalId);
    expect(await store.update("ghost", { company: "x" })).toBeNull();
  });

  it("refuses a response that predates the lead (CHECK constraint)", async () => {
    const lead = mk();
    await store.create(lead);
    await expect(store.update(lead.externalId, { respondedAt: new Date(lead.receivedAt.getTime() - 1000) })).rejects.toThrow();
  });

  it("lists leads from a date, oldest first, and counts", async () => {
    const base = Date.now() + 10 * 86_400_000; // far-future window so other tests' rows are excluded
    const a = mk({ receivedAt: new Date(base + 2000) });
    const b = mk({ receivedAt: new Date(base + 1000) });
    await store.create(a);
    await store.create(b);
    const listed = await store.list(new Date(base));
    expect(listed.map((l) => l.externalId)).toEqual([b.externalId, a.externalId]);
    expect(await store.count()).toBeGreaterThanOrEqual(2);
  });
});
