import time
from collections.abc import Callable


class RateLimiter:
    """Guarantees at least `min_interval` seconds between network requests."""

    def __init__(
        self,
        min_interval: float,
        clock: Callable[[], float] | None = None,
        sleep: Callable[[float], None] | None = None,
    ):
        self.min_interval = min_interval
        # Looked up at call time, so tests (and callers) can patch time.sleep.
        self.clock = clock or time.monotonic
        self.sleep = sleep or (lambda seconds: time.sleep(seconds))
        self._last: float | None = None

    def wait(self, extra_interval: float = 0.0) -> None:
        """Block until the next request may go out; `extra_interval` lets a Crawl-delay raise the floor."""
        interval = max(self.min_interval, extra_interval)
        if self._last is not None:
            remaining = interval - (self.clock() - self._last)
            if remaining > 0:
                self.sleep(remaining)
        self._last = self.clock()
