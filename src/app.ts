import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { CrmClient, EnrichmentClient } from "./clients.js";
import { leadEvent } from "./events.js";
import { createFakes, type FakeOptions } from "./fakes.js";
import { computeMetrics } from "./metrics.js";
import { createPipeline, silentLogger, type Logger } from "./pipeline.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "./signature.js";
import type { LeadStore } from "./store.js";

export interface AppDeps {
  secret: string;
  store: LeadStore;
  crm: CrmClient;
  enrichment: EnrichmentClient;
  now?: () => Date;
  log?: Logger;
  /** Mount the built-in fake CRM and enrichment API under /fake/*. */
  fakes?: FakeOptions | false;
}

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

export function createApp(deps: AppDeps): Express {
  const { secret, store, now = () => new Date(), log = silentLogger } = deps;
  const pipeline = createPipeline({ ...deps, now, log });
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // The body must stay raw: the signature covers the exact bytes the sender produced.
  app.post("/webhooks/events", express.raw({ type: () => true, limit: "64kb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const check = verify({
      secret,
      signature: req.header(SIGNATURE_HEADER),
      timestamp: req.header(TIMESTAMP_HEADER),
      rawBody,
      nowSec: Math.floor(now().getTime() / 1000),
    });
    if (!check.ok) {
      log.warn("webhook rejected", { reason: check.reason });
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ error: "body is not valid JSON" });
      return;
    }
    const parsed = leadEvent.safeParse(json);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid event", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      return;
    }
    const outcome = await pipeline.handle(parsed.data);
    res.status(outcome.status).json(outcome.body);
  });

  app.get("/api/metrics", async (req, res) => {
    const days = Math.min(90, Math.max(1, Number.parseInt(String(req.query.days ?? "30"), 10) || 30));
    const at = now();
    const leads = await store.list(new Date(at.getTime() - days * 86_400_000));
    res.json(computeMetrics(leads, at, days));
  });

  if (deps.fakes !== undefined && deps.fakes !== false) {
    const fakes = createFakes(deps.fakes);
    app.use("/fake/crm", fakes.crm);
    app.use("/fake/enrich", fakes.enrich);
  }

  app.use(express.static(publicDir, { index: "dashboard.html" }));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.warn("unhandled error", { error: String(err) });
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
