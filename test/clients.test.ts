import request from "supertest";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createCrmClient, createEnrichmentClient } from "../src/clients.js";
import { loadConfig } from "../src/config.js";
import { createFakes } from "../src/fakes.js";

/** fetch that talks to an in-process express app instead of the network. */
function appFetch(app: express.Express): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const r = await request(app).post(path).set(headers).send(String(init.body));
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function mount(failureRate = 0, random = () => 0.99) {
  const fakes = createFakes({ failureRate, random });
  const app = express();
  app.use("/fake/crm", fakes.crm);
  app.use("/fake/enrich", fakes.enrich);
  return app;
}

const noWait = { sleep: async () => undefined, random: () => 1 };

describe("fake CRM + client", () => {
  it("creates a contact and is idempotent on the key", async () => {
    const app = mount();
    const crm = createCrmClient("http://x/fake/crm", { ...noWait, fetchImpl: appFetch(app) });
    const input = { externalId: "k1", name: "Ana", email: "ana@a.test", company: null };
    const first = await crm.createContact(input);
    const second = await crm.createContact(input);
    expect(second).toEqual(first);
    expect(await crm.createContact({ ...input, externalId: "k2" })).not.toEqual(first);
    const list = await request(app).get("/fake/crm/contacts");
    expect(list.body).toHaveLength(2);
  });

  it("requires an idempotency key", async () => {
    const res = await request(mount()).post("/fake/crm/contacts").send({ name: "a" });
    expect(res.status).toBe(400);
  });

  it("retries through a flaky CRM and still succeeds", async () => {
    const outcomes = [0, 0, 0.99]; // fail, fail, succeed (failureRate 0.5)
    const app = mount(0.5, () => outcomes.shift() ?? 0.99);
    const fetchImpl = vi.fn(appFetch(app));
    const crm = createCrmClient("http://x/fake/crm", { ...noWait, fetchImpl });
    const contact = await crm.createContact({ externalId: "k", name: "A", email: "a@a.test", company: null });
    expect(contact.id).toMatch(/^crm_/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails after the retry budget when the CRM stays down", async () => {
    const crm = createCrmClient("http://x/fake/crm", { ...noWait, retries: 2, fetchImpl: appFetch(mount(1, () => 0)) });
    await expect(crm.createContact({ externalId: "k", name: "A", email: "a@a.test", company: null })).rejects.toMatchObject({ status: 503 });
  });
});

describe("fake enrichment + client", () => {
  it("derives a company from a business domain and returns null for free mail", async () => {
    const enrich = createEnrichmentClient("http://x/fake/enrich", { ...noWait, fetchImpl: appFetch(mount()) });
    expect(await enrich.lookup("ana@northwind.test")).toEqual({ company: "Northwind" });
    expect(await enrich.lookup("ana@gmail.com")).toEqual({ company: null });
    expect(await enrich.lookup("nonsense")).toEqual({ company: null });
  });
});

describe("loadConfig", () => {
  const secret = "0123456789abcdef";
  it("applies defaults and treats empty strings as unset", () => {
    const c = loadConfig({ WEBHOOK_SECRET: secret, DATABASE_URL: "", CRM_URL: "", ENABLE_FAKES: "", SEED_ON_START: "" });
    expect(c).toMatchObject({ PORT: 3000, DATABASE_URL: undefined, CRM_URL: undefined, ENABLE_FAKES: false, SEED_ON_START: false, FAKE_FAILURE_RATE: 0 });
  });
  it("parses flags and numbers", () => {
    const c = loadConfig({ WEBHOOK_SECRET: secret, PORT: "8080", ENABLE_FAKES: "true", FAKE_FAILURE_RATE: "0.25" });
    expect(c).toMatchObject({ PORT: 8080, ENABLE_FAKES: true, FAKE_FAILURE_RATE: 0.25 });
  });
  it("refuses a missing or short secret and an out-of-range port", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ WEBHOOK_SECRET: "short" })).toThrow(/at least 16/);
    expect(() => loadConfig({ WEBHOOK_SECRET: secret, PORT: "70000" })).toThrow();
  });
});
