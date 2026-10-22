import { readFile } from "node:fs/promises";
import pg from "pg";
import type { CrmStatus, Lead, LeadPatch, LeadStore } from "./store.js";

interface Row {
  id: string;
  external_id: string;
  source: string;
  email: string;
  name: string;
  company: string | null;
  received_at: Date;
  responded_at: Date | null;
  converted_at: Date | null;
  crm_id: string | null;
  crm_status: CrmStatus;
  synthetic: boolean;
}

const toLead = (r: Row): Lead => ({
  id: r.id,
  externalId: r.external_id,
  source: r.source,
  email: r.email,
  name: r.name,
  company: r.company,
  receivedAt: r.received_at,
  respondedAt: r.responded_at,
  convertedAt: r.converted_at,
  crmId: r.crm_id,
  crmStatus: r.crm_status,
  synthetic: r.synthetic,
});

// Fixed whitelist: patch keys map to column names here, never from user input.
const PATCH_COLUMNS: Record<keyof LeadPatch, string> = {
  company: "company",
  crmId: "crm_id",
  crmStatus: "crm_status",
  respondedAt: "responded_at",
  convertedAt: "converted_at",
};

export class PgStore implements LeadStore {
  constructor(private readonly pool: pg.Pool) {}

  static connect(connectionString: string): PgStore {
    return new PgStore(new pg.Pool({ connectionString }));
  }

  async migrate(): Promise<void> {
    const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async create(lead: Lead) {
    const inserted = await this.pool.query<Row>(
      `INSERT INTO leads (id, external_id, source, email, name, company, received_at, responded_at, converted_at, crm_id, crm_status, synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (external_id) DO NOTHING
       RETURNING *`,
      [
        lead.id,
        lead.externalId,
        lead.source,
        lead.email,
        lead.name,
        lead.company,
        lead.receivedAt,
        lead.respondedAt,
        lead.convertedAt,
        lead.crmId,
        lead.crmStatus,
        lead.synthetic,
      ],
    );
    const row = inserted.rows[0];
    if (row) return { lead: toLead(row), created: true };
    const existing = await this.findByExternalId(lead.externalId);
    if (!existing) throw new Error("lead vanished between insert and select");
    return { lead: existing, created: false };
  }

  async findByExternalId(externalId: string) {
    const res = await this.pool.query<Row>("SELECT * FROM leads WHERE external_id = $1", [externalId]);
    return res.rows[0] ? toLead(res.rows[0]) : null;
  }

  async update(externalId: string, patch: LeadPatch) {
    const keys = (Object.keys(patch) as (keyof LeadPatch)[]).filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return this.findByExternalId(externalId);
    const sets = keys.map((k, i) => `${PATCH_COLUMNS[k]} = $${i + 2}`).join(", ");
    const res = await this.pool.query<Row>(`UPDATE leads SET ${sets} WHERE external_id = $1 RETURNING *`, [
      externalId,
      ...keys.map((k) => patch[k]),
    ]);
    return res.rows[0] ? toLead(res.rows[0]) : null;
  }

  async list(since: Date) {
    const res = await this.pool.query<Row>("SELECT * FROM leads WHERE received_at >= $1 ORDER BY received_at", [since]);
    return res.rows.map(toLead);
  }

  async count() {
    const res = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM leads");
    return Number(res.rows[0]?.n ?? 0);
  }
}
