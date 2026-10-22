import express, { type Router } from "express";

export interface FakeOptions {
  /** Probability [0,1] that a request fails with 503, to exercise the retry logic. */
  failureRate?: number;
  random?: () => number;
}

/** In-process stand-ins for a CRM and an enrichment API. Nothing here talks to a real third party. */
export function createFakes({ failureRate = 0, random = Math.random }: FakeOptions = {}): { crm: Router; enrich: Router } {
  const flaky: express.RequestHandler = (_req, res, next) => {
    if (random() < failureRate) {
      res.status(503).set("retry-after", "0").json({ error: "simulated outage" });
      return;
    }
    next();
  };

  const contacts = new Map<string, { id: string; name: string; email: string; company: string | null }>();
  const crm = express.Router();
  crm.use(express.json({ limit: "16kb" }), flaky);
  crm.post("/contacts", (req, res) => {
    const key = req.header("idempotency-key");
    if (!key) {
      res.status(400).json({ error: "idempotency-key header required" });
      return;
    }
    let contact = contacts.get(key);
    if (!contact) {
      const { name, email, company } = req.body as { name: string; email: string; company: string | null };
      contact = { id: `crm_${contacts.size + 1}`, name, email, company: company ?? null };
      contacts.set(key, contact);
    }
    res.status(201).json(contact);
  });
  crm.get("/contacts", (_req, res) => {
    res.json([...contacts.values()]);
  });

  const enrich = express.Router();
  enrich.use(express.json({ limit: "16kb" }), flaky);
  enrich.post("/lookup", (req, res) => {
    const email = String((req.body as { email?: unknown }).email ?? "");
    const domain = email.split("@")[1] ?? "";
    const freeMail = new Set(["gmail.com", "outlook.com", "yahoo.com", "example.com"]);
    const label = domain.split(".")[0] ?? "";
    res.json({ company: freeMail.has(domain) || !label ? null : label.charAt(0).toUpperCase() + label.slice(1) });
  });

  return { crm, enrich };
}
