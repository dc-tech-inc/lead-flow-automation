import time
from collections.abc import Callable
from typing import Protocol

from leadflow_scraper.cache import DiskCache
from leadflow_scraper.policy import assert_allowed
from leadflow_scraper.ratelimit import RateLimiter
from leadflow_scraper.robots import RobotsPolicy

USER_AGENT = "leadflow-scraper/0.1 (practice-site demo; +https://dctech.live)"


class DisallowedByRobotsError(Exception):
    """robots.txt does not permit this URL for our user agent."""


class FetchError(Exception):
    """The server answered with a non-200 status."""


class Response(Protocol):
    status_code: int
    text: str


class Session(Protocol):
    def get(self, url: str, *, headers: dict[str, str], timeout: float) -> Response: ...


class PoliteClient:
    """GET with the rules baked in: allow-list, robots.txt, disk cache, rate limit, identifying User-Agent.

    Order of checks matters: the allow-list and robots.txt come first, so a forbidden URL is never fetched,
    not even from cache; cache hits are served without touching the rate limiter or the network.
    """

    def __init__(
        self,
        session: Session,
        cache: DiskCache | None = None,
        min_interval: float = 1.0,
        user_agent: str = USER_AGENT,
        timeout: float = 10.0,
        clock: Callable[[], float] = time.time,
        limiter: RateLimiter | None = None,
    ):
        self.session = session
        self.cache = cache
        self.user_agent = user_agent
        self.timeout = timeout
        self.limiter = limiter or RateLimiter(min_interval)
        self.robots = RobotsPolicy(self._raw_get, clock=clock)
        self.network_requests = 0

    def _raw_get(self, url: str) -> tuple[int, str]:
        """Used for robots.txt: rate limited like any other request."""
        self.limiter.wait()
        self.network_requests += 1
        res = self.session.get(url, headers={"User-Agent": self.user_agent}, timeout=self.timeout)
        return res.status_code, res.text

    def get(self, url: str) -> str:
        assert_allowed(url)
        if not self.robots.allowed(url, self.user_agent):
            raise DisallowedByRobotsError(url)
        if self.cache and (hit := self.cache.get(url)) is not None:
            return hit

        self.limiter.wait(self.robots.crawl_delay(url, self.user_agent))
        self.network_requests += 1
        res = self.session.get(url, headers={"User-Agent": self.user_agent}, timeout=self.timeout)
        # ponytail: no automatic retry. A 429/503 stops the run; add backoff honoring Retry-After if needed.
        if res.status_code != 200:
            raise FetchError(f"{url} -> HTTP {res.status_code}")
        if self.cache:
            self.cache.put(url, res.text)
        return res.text
