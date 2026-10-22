# leadflow-scraper

A small Python tool that collects listing data from two public **practice sites** and shows how to do it politely.
It is the "ethical data collection" part of the lead-flow-automation repo. It does **not** collect people or leads:
the data it produces (quotes and book prices) is sample data only.

## What it enforces

| Rule | Where | Notes |
|---|---|---|
| Only `books.toscrape.com` and `quotes.toscrape.com` | `policy.py` | Any other host raises `NotAllowedError` before a socket is opened. Both sites exist for scraping practice. |
| `robots.txt` first | `robots.py` | Parsed with the standard library's `urllib.robotparser`. Missing file (4xx) means no rules; 5xx or network error means "assume complete disallow", as RFC 9309 section 2.3.1 prescribes. Cached at most 24 hours (section 2.4). `Crawl-delay` is honored. |
| Rate limit | `ratelimit.py` | At least 1 second between network requests by default (the CLI refuses less than 0.5). robots.txt fetches count too. |
| Disk cache | `cache.py` | 24 h TTL, keyed by the SHA-256 of the URL. Cache hits cost no request and do not touch the rate limiter. A URL that robots.txt forbids is never served, even from cache. |
| Honest User-Agent | `client.py` | Names the tool and points to https://dctech.live. |
| Timeouts, no retries | `client.py` | 10 s timeout per request. A non-200 stops the run instead of hammering the server (documented as a `ponytail:` shortcut in the code). |

## Run it

```bash
cd services/scraper
python -m venv .venv && . .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

leadflow-scraper quotes --pages 2                # JSON lines on stdout, summary on stderr
leadflow-scraper books --pages 2 --out books.jsonl
```

Example output line (`quotes`):

```json
{"text": "“The world as we have created it …”", "author": "Albert Einstein", "tags": ["change", "deep-thoughts", "thinking", "world"]}
```

## Test it

```bash
ruff check . && ruff format --check .
pytest            # fails below 90% coverage
```

The tests use a fake HTTP session and fixture HTML written for this repo, so they run offline and never contact the sites.
They cover the allow-list (including look-alike hosts and non-HTTP schemes), every robots.txt status case, cache expiry,
rate-limit spacing with a fake clock, the parsers (including malformed blocks) and the CLI.

## Limits

- It walks listing pages only (`--pages`, max 50). It does not follow product pages or login-protected areas.
- The parsers match the markup of these two sites as of writing; if the sites change, the fixtures and selectors need updating.
- Robots rules use the standard library parser, which implements the older "first match" semantics rather than RFC 9309's
  longest-match precedence. For these two sites (no restrictive rules) that makes no difference.
