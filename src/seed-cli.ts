import { loadConfig } from "./config.js";
import { PgStore } from "./pgStore.js";
import { seedStore } from "./seed.js";

const { DATABASE_URL } = loadConfig();
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required to seed (the in-memory store lives and dies with the server process).");
  process.exit(1);
}

const store = PgStore.connect(DATABASE_URL);
await store.migrate();
const inserted = await seedStore(store, { count: 400, days: 30, seed: 42, now: new Date() });
console.log(`Inserted ${inserted} synthetic leads (already-present ones are skipped).`);
await store.close();
