import { z } from "zod";
import { fetchWithRetry, type RetryOptions } from "./http.js";

const contactResponse = z.object({ id: z.string() });
const enrichResponse = z.object({ company: z.string().nullable() });

export interface CrmClient {
  /** Idempotent on externalId: calling twice returns the same CRM id. */
  createContact(input: { externalId: string; name: string; email: string; company: string | null }): Promise<{ id: string }>;
}

export interface EnrichmentClient {
  lookup(email: string): Promise<{ company: string | null }>;
}

const jsonHeaders = { "content-type": "application/json" };

export function createCrmClient(baseUrl: string, retry?: RetryOptions): CrmClient {
  return {
    async createContact(input) {
      const res = await fetchWithRetry(
        `${baseUrl}/contacts`,
        {
          method: "POST",
          headers: { ...jsonHeaders, "idempotency-key": input.externalId },
          body: JSON.stringify({ name: input.name, email: input.email, company: input.company }),
        },
        retry,
      );
      return contactResponse.parse(await res.json());
    },
  };
}

export function createEnrichmentClient(baseUrl: string, retry?: RetryOptions): EnrichmentClient {
  return {
    async lookup(email) {
      const res = await fetchWithRetry(
        `${baseUrl}/lookup`,
        { method: "POST", headers: jsonHeaders, body: JSON.stringify({ email }) },
        retry,
      );
      return enrichResponse.parse(await res.json());
    },
  };
}
