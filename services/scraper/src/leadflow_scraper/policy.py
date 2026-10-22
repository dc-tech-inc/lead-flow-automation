from urllib.parse import urlsplit

# The only hosts this tool will ever contact. Both are public sites built for scraping practice.
ALLOWED_HOSTS = frozenset({"books.toscrape.com", "quotes.toscrape.com"})


class NotAllowedError(Exception):
    """The URL is outside the allow-list."""


def assert_allowed(url: str, allowed_hosts: frozenset[str] = ALLOWED_HOSTS) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or parts.hostname not in allowed_hosts:
        raise NotAllowedError(f"{url!r} is not on the allow-list {sorted(allowed_hosts)}")
