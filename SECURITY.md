# Security policy

This is a reference project. It ships no real credentials and talks only to built-in fake services by default.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting
(Security tab, "Report a vulnerability") on this repository. If that is unavailable, contact DCtech.
through https://dctech.live.

You can expect an acknowledgement within a few working days. This is a small project without a bounty program.

## Scope and design notes

- Webhooks are authenticated with HMAC-SHA256 over `timestamp.body` and a 5-minute tolerance window.
  Replays inside that window are accepted by design; every handler is idempotent (see `docs/adr/0001-signed-webhooks.md`).
- `WEBHOOK_SECRET` is read from the environment. Never commit a real one; `.env` is git-ignored and
  CI runs gitleaks over the full history.
- The scraper in `services/scraper/` only talks to allow-listed practice sites and obeys `robots.txt`.
