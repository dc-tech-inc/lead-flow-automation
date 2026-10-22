import { randomUUID } from "node:crypto";
import type { CrmClient, EnrichmentClient } from "./clients.js";
import type { LeadEvent } from "./events.js";
import type { Lead, LeadStore } from "./store.js";

export type Outcome =
  | { status: 200 | 201 | 202; body: Record<string, unknown> }
  | { status: 404 | 422; body: { error: string } };

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (msg, fields) => console.log(JSON.stringify({ level: "info", msg, ...fields })),
  warn: (msg, fields) => console.warn(JSON.stringify({ level: "warn", msg, ...fields })),
};

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined };

export interface PipelineDeps {
  store: LeadStore;
  crm: CrmClient;
  enrichment: EnrichmentClient;
  now?: () => Date;
  log?: Logger;
}

/**
 * Applies one verified event. Every branch is idempotent by externalId, so a redelivered
 * webhook never double-counts a lead, a response or a conversion.
 */
export function createPipeline({ store, crm, enrichment, now = () => new Date(), log = silentLogger }: PipelineDeps) {
  async function created(event: Extract<LeadEvent, { type: "lead.created" }>): Promise<Outcome> {
    const lead: Lead = {
      id: randomUUID(),
      externalId: event.externalId,
      source: event.source,
      email: event.email,
      name: event.name,
      company: null,
      receivedAt: event.occurredAt ? new Date(event.occurredAt) : now(),
      respondedAt: null,
      convertedAt: null,
      crmId: null,
      crmStatus: "pending",
      synthetic: false,
    };
    const { lead: stored, created: isNew } = await store.create(lead);
    if (!isNew) return { status: 200, body: { id: stored.id, duplicate: true, crmStatus: stored.crmStatus } };

    // Enrichment is best effort: a lead without a company is still a lead.
    let company: string | null = null;
    try {
      company = (await enrichment.lookup(stored.email)).company;
    } catch (err) {
      log.warn("enrichment failed", { externalId: stored.externalId, error: String(err) });
    }

    // ponytail: runs inline, so the webhook response waits for retries (bounded by RetryOptions).
    // Move to a queue/outbox when sustained volume or slow CRMs make that wait unacceptable.
    try {
      const contact = await crm.createContact({ externalId: stored.externalId, name: stored.name, email: stored.email, company });
      await store.update(stored.externalId, { company, crmId: contact.id, crmStatus: "synced" });
      log.info("lead synced", { externalId: stored.externalId, crmId: contact.id });
      return { status: 201, body: { id: stored.id, crmStatus: "synced" } };
    } catch (err) {
      await store.update(stored.externalId, { company, crmStatus: "failed" });
      log.warn("crm sync failed", { externalId: stored.externalId, error: String(err) });
      // Accepted and stored; the CRM sync is the part that is pending a retry by the operator.
      return { status: 202, body: { id: stored.id, crmStatus: "failed" } };
    }
  }

  async function mark(
    event: Extract<LeadEvent, { type: "lead.responded" | "lead.converted" }>,
  ): Promise<Outcome> {
    const lead = await store.findByExternalId(event.externalId);
    if (!lead) return { status: 404, body: { error: "unknown lead" } };
    const at = event.occurredAt ? new Date(event.occurredAt) : now();
    if (at < lead.receivedAt) return { status: 422, body: { error: "event predates the lead" } };

    if (event.type === "lead.responded") {
      if (lead.respondedAt) return { status: 200, body: { id: lead.id, duplicate: true } };
      await store.update(lead.externalId, { respondedAt: at });
    } else {
      if (lead.convertedAt) return { status: 200, body: { id: lead.id, duplicate: true } };
      await store.update(lead.externalId, { convertedAt: at });
    }
    return { status: 200, body: { id: lead.id } };
  }

  return {
    handle(event: LeadEvent): Promise<Outcome> {
      return event.type === "lead.created" ? created(event) : mark(event);
    },
  };
}
