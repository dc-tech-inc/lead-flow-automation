# ADR 0003: Make the scraper polite by construction

Status: accepted

## Context
The repo includes a scraper to show data collection skills. Scraping can easily become abusive or legally murky, and
a portfolio piece should not teach that.

## Decision
- A hard allow-list of two practice sites (`books.toscrape.com`, `quotes.toscrape.com`) lives in code, not config.
- A single `PoliteClient` is the only way the CLI fetches anything, so the rules cannot be bypassed by a new call site:
  allow-list, then robots.txt (RFC 9309 semantics for unavailable files), then disk cache, then a rate limit.
- The tool collects sample data (quotes, book prices), never people. Nothing from it is posted to the lead service.
- No automatic retries: a refusal or error stops the run.

## Consequences
- Safe to run by anyone cloning the repo; there is no flag that points it at a different site.
- Extending it to another site is a deliberate code change plus a fresh look at that site's terms.
- The stdlib robots parser uses first-match rather than longest-match rule precedence; fine for these sites, noted in the README.
