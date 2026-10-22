from dataclasses import dataclass, field
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


@dataclass
class FakeResponse:
    status_code: int
    text: str


@dataclass
class FakeSession:
    """Stands in for requests.Session. `routes` maps URL -> (status, body); unknown URLs are 404."""

    routes: dict[str, tuple[int, str]] = field(default_factory=dict)
    calls: list[tuple[str, dict[str, str], float]] = field(default_factory=list)
    raise_on: set[str] = field(default_factory=set)

    def get(self, url: str, *, headers: dict[str, str], timeout: float) -> FakeResponse:
        self.calls.append((url, headers, timeout))
        if url in self.raise_on:
            raise ConnectionError("network down")
        status, body = self.routes.get(url, (404, "not found"))
        return FakeResponse(status, body)

    @property
    def urls(self) -> list[str]:
        return [c[0] for c in self.calls]


class FakeClock:
    """Manual clock + sleep so rate-limit tests need no real waiting."""

    def __init__(self, start: float = 1000.0):
        self.now = start
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def site() -> FakeSession:
    """A two-page quotes site and a two-page books site, both with a permissive robots.txt."""
    return FakeSession(
        routes={
            "https://quotes.toscrape.com/robots.txt": (200, "User-agent: *\nDisallow: /admin\n"),
            "https://quotes.toscrape.com/": (200, fixture("quotes_page1.html")),
            "https://quotes.toscrape.com/page/2/": (200, fixture("quotes_page2.html")),
            "https://books.toscrape.com/robots.txt": (404, "missing"),
            "https://books.toscrape.com/": (200, fixture("books_page1.html")),
            "https://books.toscrape.com/catalogue/page-2.html": (200, fixture("books_page2.html")),
        }
    )
