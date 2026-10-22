# ADR 0001: HMAC-signed webhooks over a single events endpoint

Status: accepted

## Context
Lead events arrive from outside the service (a form, an n8n workflow, another system). Anyone who can reach
the endpoint could otherwise forge a lead, a response or a conversion, and those events feed the metrics.

## Decision
- One endpoint, `POST /webhooks/events`, carrying a typed event (`lead.created`, `lead.responded`, `lead.converted`).
- The sender signs `"<unix timestamp>.<raw body>"` with HMAC-SHA256 and sends `X-Timestamp` and `X-Signature: sha256=<hex>`.
- The server verifies the signature on the raw bytes (so the body is not re-serialised first) with `crypto.timingSafeEqual`,
  and rejects timestamps more than 5 minutes from its clock.
- Every handler is idempotent by `externalId`: a redelivery changes nothing.

## Consequences
- Binding the timestamp into the signature stops a captured body being replayed with a fresh timestamp.
- Replays inside the 5-minute window are still accepted. Idempotent handlers make that harmless here; a nonce cache
  would be needed if a non-idempotent event type is ever added.
- A shared secret means one leaked secret lets an attacker sign anything. Rotate it by deploying a new value to both sides.
- This is the same scheme many webhook providers use, which keeps senders simple (n8n's Crypto node can produce it).
