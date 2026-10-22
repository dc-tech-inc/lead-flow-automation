import { createApp } from "./app.js";
import { createCrmClient, createEnrichmentClient } from "./clients.js";
import { loadConfig } from "./config.js";
import { PgStore } from "./pgStore.js";
import { consoleLogger } from "./pipeline.js";
import { seedStore } from "./seed.js";
import { MemoryStore } from "./store.js";

const config = loadConfig();
const log = consoleLogger;

const pgStore = config.DATABASE_URL ? PgStore.connect(config.DATABASE_URL) : null;
if (pgStore) await pgStore.migrate();
const store = pgStore ?? new MemoryStore();
if (!pgStore) log.warn("DATABASE_URL not set: using the in-memory store, data is lost on restart");

if (config.SEED_ON_START && (await store.count()) === 0) {
  const inserted = await seedStore(store, { count: 400, days: 30, seed: 42, now: new Date() });
  log.info("seeded synthetic leads", { inserted });
}

const self = `http://127.0.0.1:${config.PORT}`;
const app = createApp({
  secret: config.WEBHOOK_SECRET,
  store,
  crm: createCrmClient(config.CRM_URL ?? `${self}/fake/crm`),
  enrichment: createEnrichmentClient(config.ENRICH_URL ?? `${self}/fake/enrich`),
  log,
  fakes: config.ENABLE_FAKES ? { failureRate: config.FAKE_FAILURE_RATE } : false,
});

const server = app.listen(config.PORT, () => log.info("listening", { port: config.PORT }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void (pgStore?.close() ?? Promise.resolve()).then(() => process.exit(0));
    });
  });
}
