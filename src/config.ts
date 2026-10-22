import { z } from "zod";

// Empty strings in .env files mean "unset".
const optional = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());
const flag = z.preprocess((v) => (v === "" || v === undefined ? "false" : v), z.enum(["true", "false"]).transform((v) => v === "true"));

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEBHOOK_SECRET: z.string().min(16, "WEBHOOK_SECRET must be at least 16 characters"),
  DATABASE_URL: optional,
  ENABLE_FAKES: flag,
  CRM_URL: optional,
  ENRICH_URL: optional,
  FAKE_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  SEED_ON_START: flag,
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
