export type CrmStatus = "pending" | "synced" | "failed";

export interface Lead {
  id: string;
  externalId: string;
  source: string;
  email: string;
  name: string;
  company: string | null;
  receivedAt: Date;
  respondedAt: Date | null;
  convertedAt: Date | null;
  crmId: string | null;
  crmStatus: CrmStatus;
  synthetic: boolean;
}

export type LeadPatch = Partial<Pick<Lead, "company" | "crmId" | "crmStatus" | "respondedAt" | "convertedAt">>;

export interface LeadStore {
  /** Inserts the lead, or returns the existing one with `created: false` when externalId is already known. */
  create(lead: Lead): Promise<{ lead: Lead; created: boolean }>;
  findByExternalId(externalId: string): Promise<Lead | null>;
  update(externalId: string, patch: LeadPatch): Promise<Lead | null>;
  /** Leads received at or after `since`, oldest first. */
  list(since: Date): Promise<Lead[]>;
  count(): Promise<number>;
}

export class MemoryStore implements LeadStore {
  private readonly byExternalId = new Map<string, Lead>();

  async create(lead: Lead) {
    const existing = this.byExternalId.get(lead.externalId);
    if (existing) return { lead: existing, created: false };
    this.byExternalId.set(lead.externalId, lead);
    return { lead, created: true };
  }

  async findByExternalId(externalId: string) {
    return this.byExternalId.get(externalId) ?? null;
  }

  async update(externalId: string, patch: LeadPatch) {
    const current = this.byExternalId.get(externalId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.byExternalId.set(externalId, next);
    return next;
  }

  async list(since: Date) {
    return [...this.byExternalId.values()]
      .filter((l) => l.receivedAt >= since)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  async count() {
    return this.byExternalId.size;
  }
}
