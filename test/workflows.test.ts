import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store.js";

// Static checks on the exported n8n workflows, plus a contract test: the Code node from the
// "Lead intake" workflow is executed here and its output is signed the way the Crypto node
// is configured to sign it, then sent to the real app. This does not run n8n itself; CI separately
// imports the files into a real n8n container.
const dir = new URL("../n8n/workflows/", import.meta.url);

interface Node {
  id: string;
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
}
interface Workflow {
  id: string;
  name: string;
  active: boolean;
  nodes: Node[];
  connections: Record<string, { main: { node: string }[][] }>;
}

const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const load = (f: string) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as Workflow;
const workflows = files.map((f) => [f, load(f)] as const);

describe("n8n workflow exports", () => {
  it("ships the three workflows", () => {
    expect(workflows.map(([, w]) => w.name).sort()).toEqual(["Lead follow-up", "Lead intake", "Slow response alert"]);
  });

  it.each(workflows)("%s: unique ids and names, one trigger, inactive by default", (_f, w) => {
    expect(new Set(w.nodes.map((n) => n.id)).size).toBe(w.nodes.length);
    expect(new Set(w.nodes.map((n) => n.name)).size).toBe(w.nodes.length);
    expect(w.nodes.filter((n) => /webhook$|scheduleTrigger$/.test(n.type))).toHaveLength(1);
    expect(w.active).toBe(false);
  });

  it.each(workflows)("%s: every connection points at a real node and the graph is connected", (_f, w) => {
    const names = new Set(w.nodes.map((n) => n.name));
    const reached = new Set<string>();
    for (const [from, out] of Object.entries(w.connections)) {
      expect(names.has(from)).toBe(true);
      for (const target of out.main.flat()) {
        expect(names.has(target.node)).toBe(true);
        reached.add(target.node);
      }
    }
    const trigger = w.nodes.find((n) => /webhook$|scheduleTrigger$/.test(n.type));
    expect(w.nodes.filter((n) => n !== trigger).every((n) => reached.has(n.name))).toBe(true);
  });

  it.each(workflows)("%s: carries no secrets, only credential placeholders", (_f, w) => {
    const text = JSON.stringify(w);
    expect(text).not.toMatch(/bearer\s+[a-z0-9]/i);
    expect(text).not.toMatch(/api[_-]?key|password|token"/i);
    for (const n of w.nodes) for (const c of Object.values(n.credentials ?? {})) expect(c.id).toBe("CREATE_ME");
  });

  it.each(workflows)("%s: internal URLs use the compose service name, not a real host", (_f, w) => {
    const urls = w.nodes.map((n) => n.parameters.url).filter((u): u is string => typeof u === "string");
    for (const u of urls) expect(u).toMatch(/^http:\/\/service:3000\//);
  });
});

/** Runs the workflow's Code node the way n8n would: `$input`, `$execution` and `Date` available. */
function runCodeNode(w: Workflow, input: unknown, executionId = "exec-1") {
  const code = w.nodes.find((n) => n.type === "n8n-nodes-base.code")?.parameters.jsCode as string;
  const fn = new Function("$input", "$execution", code) as (i: unknown, e: unknown) => { json: Record<string, string> }[];
  return fn({ first: () => ({ json: { body: input } }) }, { id: executionId })[0]!.json;
}

describe("signing contract between the n8n workflows and the service", () => {
  const secret = "contract-secret-0123456789";
  const now = new Date("2026-06-30T12:00:00Z");
  const buildApp = (store = new MemoryStore()) =>
    createApp({
      secret,
      store,
      now: () => now,
      crm: { createContact: async () => ({ id: "crm_1" }) },
      enrichment: { lookup: async () => ({ company: null }) },
    });

  /** What the Crypto node does with the settings in the export: HMAC-SHA256 of `value`, hex. */
  function cryptoNode(w: Workflow, toSign: string) {
    const node = w.nodes.find((n) => n.type === "n8n-nodes-base.crypto")!;
    expect(node.parameters).toMatchObject({ action: "hmac", type: "SHA256", encoding: "hex", value: "={{ $json.toSign }}" });
    return createHmac("sha256", secret).update(toSign).digest("hex");
  }

  it("lead intake: the signed request is accepted by the service", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const w = load("lead-intake.json");
      const out = runCodeNode(w, { id: "form-42", email: "ana@northwind.test", name: "Ana", source: "event-signup" });
      const signature = cryptoNode(w, out.toSign!);

      const store = new MemoryStore();
      const res = await request(buildApp(store))
        .post("/webhooks/events")
        .set("content-type", "application/json")
        .set("x-timestamp", out.timestamp!) // header expression: {{ $json.timestamp }}
        .set("x-signature", "sha256=" + signature) // header expression: 'sha256=' + $json.signature
        .send(out.body!);
      expect(res.status).toBe(201);
      expect(await store.findByExternalId("form-42")).toMatchObject({ source: "event-signup", email: "ana@northwind.test" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lead follow-up: the lead.responded event is accepted and records the response", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const store = new MemoryStore();
      const app = buildApp(store);
      const intake = load("lead-intake.json");
      const created = runCodeNode(intake, { id: "form-43", email: "ben@northwind.test", name: "Ben" });
      await request(app)
        .post("/webhooks/events")
        .set("x-timestamp", created.timestamp!)
        .set("x-signature", "sha256=" + cryptoNode(intake, created.toSign!))
        .send(created.body!);

      vi.setSystemTime(new Date(now.getTime() + 120_000));
      const follow = load("lead-followup.json");
      const out = runCodeNode(follow, { externalId: "form-43", name: "Ben" });
      expect(out.reply).toContain("Ben");
      const res = await request(buildApp(store))
        .post("/webhooks/events")
        .set("x-timestamp", out.timestamp!)
        .set("x-signature", "sha256=" + cryptoNode(follow, out.toSign!))
        .send(out.body!);
      expect(res.status).toBe(200);
      expect((await store.findByExternalId("form-43"))?.respondedAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the execution id when the form sends no id", () => {
    const out = runCodeNode(load("lead-intake.json"), { email: "x@example.com", name: "X" }, "exec-99");
    expect(JSON.parse(out.body!).externalId).toBe("exec-99");
  });
});
