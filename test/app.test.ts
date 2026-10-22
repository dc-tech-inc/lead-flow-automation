import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { CrmClient, EnrichmentClient } from "../src/clients.js";
import { sign } from "../src/signature.js";
import { seedStore } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";

const secret = "test-secret-0123456789";
const now = new Date("2026-06-30T12:00:00Z");
const ts = Math.floor(now.getTime() / 1000);

const created = (over: Record<string, unknown> = {}) => ({
  type: "lead.created",
  externalId: "form-1",
  source: "website-form",
  email: "ana@northwind.test",
  name: "Ana Souza",
  ...over,
});

let store: MemoryStore;
let crm: { createContact: ReturnType<typeof vi.fn> };
let enrichment: { lookup: ReturnType<typeof vi.fn> };

function build() {
  return createApp({ secret, store, crm: crm as CrmClient, enrichment: enrichment as EnrichmentClient, now: () => now });
}

function post(app: ReturnType<typeof build>, payload: unknown, opts: { signature?: string; timestamp?: number; raw?: string } = {}) {
  const body = opts.raw ?? JSON.stringify(payload);
  const timestamp = opts.timestamp ?? ts;
  return request(app)
    .post("/webhooks/events")
    .set("content-type", "application/json")
    .set("x-timestamp", String(timestamp))
    .set("x-signature", opts.signature ?? sign(secret, timestamp, body))
    .send(body);
}

beforeEach(() => {
  store = new MemoryStore();
  crm = { createContact: vi.fn(async () => ({ id: "crm_1" })) };
  enrichment = { lookup: vi.fn(async () => ({ company: "Northwind" })) };
});

describe("POST /webhooks/events", () => {
  it("creates a lead, enriches it and syncs it to the CRM", async () => {
    const res = await post(build(), created());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ crmStatus: "synced" });
    expect(crm.createContact).toHaveBeenCalledWith({ externalId: "form-1", name: "Ana Souza", email: "ana@northwind.test", company: "Northwind" });
    expect(await store.findByExternalId("form-1")).toMatchObject({ company: "Northwind", crmId: "crm_1", crmStatus: "synced", synthetic: false });
  });

  it("rejects an unsigned request with 401 and stores nothing", async () => {
    const res = await request(build()).post("/webhooks/events").set("content-type", "application/json").send(JSON.stringify(created()));
    expect(res.status).toBe(401);
    expect(await store.count()).toBe(0);
  });

  it("rejects a wrong signature, a tampered body and a stale timestamp", async () => {
    const app = build();
    expect((await post(app, created(), { signature: "sha256=" + "0".repeat(64) })).status).toBe(401);

    const signedFor = JSON.stringify(created());
    const tampered = JSON.stringify(created({ email: "evil@x.test" }));
    expect((await post(app, null, { raw: tampered, signature: sign(secret, ts, signedFor) })).status).toBe(401);

    const old = ts - 3600;
    expect((await post(app, created(), { timestamp: old })).status).toBe(401);
    expect(await store.count()).toBe(0);
  });

  it("returns 400 for signed but invalid JSON or an invalid event", async () => {
    const app = build();
    expect((await post(app, null, { raw: "{not json" })).status).toBe(400);
    const bad = await post(app, created({ email: "not-an-email" }));
    expect(bad.status).toBe(400);
    expect(bad.body.issues[0].path).toBe("email");
    expect((await post(app, { type: "lead.deleted", externalId: "x" })).status).toBe(400);
  });

  it("is idempotent: a redelivered lead.created does not duplicate or call the CRM twice", async () => {
    const app = build();
    await post(app, created());
    const again = await post(app, created());
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(await store.count()).toBe(1);
    expect(crm.createContact).toHaveBeenCalledTimes(1);
  });

  it("keeps the lead when enrichment fails", async () => {
    enrichment.lookup.mockRejectedValue(new Error("enrichment down"));
    const res = await post(build(), created());
    expect(res.status).toBe(201);
    expect(await store.findByExternalId("form-1")).toMatchObject({ company: null, crmStatus: "synced" });
  });

  it("keeps the lead and answers 202 when the CRM sync fails", async () => {
    crm.createContact.mockRejectedValue(new Error("crm down"));
    const res = await post(build(), created());
    expect(res.status).toBe(202);
    expect(res.body.crmStatus).toBe("failed");
    expect(await store.findByExternalId("form-1")).toMatchObject({ crmStatus: "failed", crmId: null });
  });

  it("records the first response and the conversion once", async () => {
    const app = build();
    await post(app, created({ occurredAt: "2026-06-30T11:00:00Z" }));
    const responded = await post(app, { type: "lead.responded", externalId: "form-1", occurredAt: "2026-06-30T11:05:00Z" });
    expect(responded.status).toBe(200);
    const second = await post(app, { type: "lead.responded", externalId: "form-1", occurredAt: "2026-06-30T11:30:00Z" });
    expect(second.body.duplicate).toBe(true);
    expect((await store.findByExternalId("form-1"))?.respondedAt?.toISOString()).toBe("2026-06-30T11:05:00.000Z");

    expect((await post(app, { type: "lead.converted", externalId: "form-1" })).status).toBe(200);
    expect((await post(app, { type: "lead.converted", externalId: "form-1" })).body.duplicate).toBe(true);
    expect((await store.findByExternalId("form-1"))?.convertedAt).toEqual(now);
  });

  it("answers 404 for an unknown lead and 422 for an event that predates the lead", async () => {
    const app = build();
    expect((await post(app, { type: "lead.responded", externalId: "ghost" })).status).toBe(404);
    await post(app, created({ occurredAt: "2026-06-30T11:00:00Z" }));
    const early = await post(app, { type: "lead.responded", externalId: "form-1", occurredAt: "2026-06-30T10:00:00Z" });
    expect(early.status).toBe(422);
  });
});

describe("GET /api/metrics", () => {
  it("returns an empty, labelled result on a fresh store", async () => {
    const res = await request(build()).get("/api/metrics");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dataset: "empty", leads: 0, windowDays: 30 });
  });

  it("computes metrics from stored leads and labels synthetic data", async () => {
    await seedStore(store, { count: 100, days: 30, seed: 7, now });
    const res = await request(build()).get("/api/metrics?days=7");
    expect(res.body.dataset).toBe("synthetic");
    expect(res.body.windowDays).toBe(7);
    expect(res.body.leads).toBeGreaterThan(0);
    expect(res.body.leads).toBeLessThan(100);
  });

  it("clamps the window and ignores garbage", async () => {
    const app = build();
    expect((await request(app).get("/api/metrics?days=100000")).body.windowDays).toBe(90);
    expect((await request(app).get("/api/metrics?days=abc")).body.windowDays).toBe(30);
    expect((await request(app).get("/api/metrics?days=-5")).body.windowDays).toBe(1);
  });
});

describe("misc routes", () => {
  it("serves health and the dashboard", async () => {
    const app = build();
    expect((await request(app).get("/healthz")).body).toEqual({ status: "ok" });
    const page = await request(app).get("/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Lead desk");
  });

  it("mounts the fakes only when asked", async () => {
    expect((await request(build()).get("/fake/crm/contacts")).status).toBe(404);
    const app = createApp({ secret, store, crm: crm as CrmClient, enrichment: enrichment as EnrichmentClient, fakes: {} });
    expect((await request(app).get("/fake/crm/contacts")).status).toBe(200);
  });

  it("turns an unexpected failure into a 500 without leaking details", async () => {
    vi.spyOn(store, "list").mockRejectedValue(new Error("db password is hunter2"));
    const res = await request(build()).get("/api/metrics");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });
});
