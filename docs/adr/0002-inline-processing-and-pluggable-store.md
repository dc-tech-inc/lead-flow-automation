# ADR 0002: Process events inline; store behind a small interface

Status: accepted

## Context
A `lead.created` event triggers two third-party calls (enrichment, CRM). Both can be slow or flaky.

## Decision
- The handler stores the lead first, then calls enrichment (best effort) and the CRM (with retry, backoff and jitter,
  honoring `Retry-After`), and answers when done: 201 if synced, 202 if the lead is stored but the CRM sync failed.
- Storage sits behind a `LeadStore` interface with an in-memory implementation (tests, zero-setup demo) and a PostgreSQL
  one (compose, CI integration test). The CRM call is idempotent through an `Idempotency-Key` header.

## Consequences
- Simple and easy to reason about; the response time of the webhook includes the retries (bounded by the retry options).
- A lead whose CRM sync failed stays `crm_status = 'failed'` and is not retried automatically. A queue or outbox
  would fix that and is on the roadmap, deliberately not built yet.
- The in-memory store loses data on restart; the server says so in its log when `DATABASE_URL` is unset.
