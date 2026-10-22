import time
from collections.abc import Callable
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

# RFC 9309 section 2.4: a cached robots.txt SHOULD NOT be used for more than 24 hours.
ROBOTS_TTL_SECONDS = 86_400

Fetch = Callable[[str], tuple[int, str]]


class RobotsPolicy:
    """Per-host robots.txt rules, following RFC 9309 section 2.3.1 for unavailable files.

    2xx -> parse; 4xx -> treated as absent (everything allowed);
    5xx or network error -> assume complete disallow.
    """

    def __init__(self, fetch: Fetch, ttl: float = ROBOTS_TTL_SECONDS, clock: Callable[[], float] = time.time):
        self._fetch = fetch
        self._ttl = ttl
        self._clock = clock
        # host -> (fetched_at, parser or None for "disallow all")
        self._cache: dict[str, tuple[float, RobotFileParser | None]] = {}

    def _rules(self, url: str) -> RobotFileParser | None:
        parts = urlsplit(url)
        host = f"{parts.scheme}://{parts.netloc}"
        cached = self._cache.get(host)
        if cached and self._clock() - cached[0] <= self._ttl:
            return cached[1]

        parser: RobotFileParser | None
        try:
            status, body = self._fetch(f"{host}/robots.txt")
        except Exception:  # noqa: BLE001 - any failure to reach the file means "unreachable"
            parser = None
        else:
            if 200 <= status < 300:
                parser = RobotFileParser()
                parser.parse(body.splitlines())
            elif 400 <= status < 500:
                parser = RobotFileParser()
                parser.parse([])  # no rules: allow all
            else:
                parser = None
        self._cache[host] = (self._clock(), parser)
        return parser

    def allowed(self, url: str, user_agent: str) -> bool:
        rules = self._rules(url)
        return rules is not None and rules.can_fetch(user_agent, url)

    def crawl_delay(self, url: str, user_agent: str) -> float:
        rules = self._rules(url)
        delay = rules.crawl_delay(user_agent) if rules else None
        return float(delay) if delay else 0.0
