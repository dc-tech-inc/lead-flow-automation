// End-to-end smoke test against a running stack (used by CI after `docker compose up`).
// Usage: WEBHOOK_SECRET=... node scripts/smoke.mjs [baseUrl]
import { createHmac } from "node:crypto";

const base = process.argv[2] ?? "http://127.0.0.1:3000";
const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error("WEBHOOK_SECRET is required");

async function send(event) {
  const body = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const res = await fetch(`${base}/webhooks/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": signature },
    body,
  });
  return { status: res.status, json: await res.json() };
}

function expect(cond, message) {
  if (!cond) {
    console.error(`smoke failed: ${message}`);
    process.exit(1);
  }
  console.log(`ok: ${message}`);
}

const id = `smoke-${Date.now()}`;
const created = await send({ type: "lead.created", externalId: id, source: "website-form", email: "smoke@northwind.test", name: "Smoke Test" });
expect(created.status === 201 && created.json.crmStatus === "synced", `lead.created accepted and synced to the CRM (${created.status})`);

const responded = await send({ type: "lead.responded", externalId: id });
expect(responded.status === 200, `lead.responded accepted (${responded.status})`);

const unsigned = await fetch(`${base}/webhooks/events`, { method: "POST", body: "{}" });
expect(unsigned.status === 401, `unsigned request rejected (${unsigned.status})`);

const metrics = await (await fetch(`${base}/api/metrics?days=30`)).json();
expect(metrics.leads > 0 && metrics.dataset !== "live", `metrics endpoint returns labelled data (${metrics.leads} leads, dataset=${metrics.dataset})`);

const contacts = await (await fetch(`${base}/fake/crm/contacts`)).json();
expect(contacts.some((c) => c.email === "smoke@northwind.test"), "contact exists in the fake CRM");
