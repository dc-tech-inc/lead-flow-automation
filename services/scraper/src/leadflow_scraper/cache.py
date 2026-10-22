import hashlib
import json
import time
from collections.abc import Callable
from pathlib import Path


class DiskCache:
    """URL -> body cache on disk with a time-to-live. The key is a hash, so a URL never becomes a path."""

    def __init__(self, directory: Path, ttl_seconds: float = 86_400, clock: Callable[[], float] = time.time):
        self.directory = directory
        self.ttl = ttl_seconds
        self.clock = clock

    def _path(self, url: str) -> Path:
        return self.directory / (hashlib.sha256(url.encode()).hexdigest() + ".json")

    def get(self, url: str) -> str | None:
        path = self._path(url)
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return None
        if self.clock() - entry["fetched_at"] > self.ttl:
            return None
        return entry["body"]

    def put(self, url: str, body: str) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        self._path(url).write_text(
            json.dumps({"url": url, "fetched_at": self.clock(), "body": body}), encoding="utf-8"
        )
