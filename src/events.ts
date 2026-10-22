import { z } from "zod";

const externalId = z.string().min(1).max(128);
const occurredAt = z.iso.datetime().optional();

export const leadCreated = z.object({
  type: z.literal("lead.created"),
  externalId,
  source: z.string().min(1).max(64),
  email: z.email().max(254),
  name: z.string().min(1).max(200),
  occurredAt,
});
export const leadResponded = z.object({ type: z.literal("lead.responded"), externalId, occurredAt });
export const leadConverted = z.object({ type: z.literal("lead.converted"), externalId, occurredAt });

export const leadEvent = z.discriminatedUnion("type", [leadCreated, leadResponded, leadConverted]);
export type LeadEvent = z.infer<typeof leadEvent>;
