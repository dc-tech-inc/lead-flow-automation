"""Scrape listing pages of a practice site to JSON lines, politely."""

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TextIO

import requests

from leadflow_scraper.cache import DiskCache
from leadflow_scraper.client import DisallowedByRobotsError, FetchError, PoliteClient, Session
from leadflow_scraper.parsers import parse_books, parse_quotes
from leadflow_scraper.policy import NotAllowedError

START_URLS = {
    "quotes": ("https://quotes.toscrape.com/", parse_quotes),
    "books": ("https://books.toscrape.com/", parse_books),
}


def scrape(client: PoliteClient, target: str, pages: int, out: TextIO) -> int:
    """Walks up to `pages` listing pages, writing one JSON object per line. Returns the number of records."""
    url, parse = START_URLS[target]
    count = 0
    next_url: str | None = url
    for _ in range(pages):
        if next_url is None:
            break
        items, next_url = parse(client.get(next_url), next_url)
        for item in items:
            out.write(json.dumps(item.to_dict(), ensure_ascii=False) + "\n")
            count += 1
    return count


def main(argv: Sequence[str] | None = None, session_factory: Callable[[], Session] = requests.Session) -> int:
    parser = argparse.ArgumentParser(prog="leadflow-scraper", description=__doc__)
    parser.add_argument("target", choices=sorted(START_URLS))
    parser.add_argument("--pages", type=int, default=2, help="listing pages to fetch (default 2, max 50)")
    parser.add_argument(
        "--min-interval", type=float, default=1.0, help="seconds between network requests (min 0.5)"
    )
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache/scraper"))
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--out", type=Path, help="write JSON lines here instead of stdout")
    args = parser.parse_args(argv)

    if not 1 <= args.pages <= 50:
        parser.error("--pages must be between 1 and 50")
    if args.min_interval < 0.5:
        parser.error("--min-interval must be at least 0.5 seconds")

    client = PoliteClient(
        session_factory(),
        cache=None if args.no_cache else DiskCache(args.cache_dir),
        min_interval=args.min_interval,
    )
    try:
        if args.out:
            with args.out.open("w", encoding="utf-8") as fh:
                count = scrape(client, args.target, args.pages, fh)
        else:
            count = scrape(client, args.target, args.pages, sys.stdout)
    except (DisallowedByRobotsError, FetchError, NotAllowedError) as err:
        print(f"stopped: {err}", file=sys.stderr)
        return 1
    print(f"{count} records, {client.network_requests} network requests", file=sys.stderr)
    return 0
