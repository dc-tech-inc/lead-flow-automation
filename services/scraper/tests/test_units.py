import pytest
from conftest import FakeClock, FakeSession, fixture

from leadflow_scraper.cache import DiskCache
from leadflow_scraper.parsers import parse_books, parse_quotes
from leadflow_scraper.policy import NotAllowedError, assert_allowed
from leadflow_scraper.ratelimit import RateLimiter
from leadflow_scraper.robots import RobotsPolicy

UA = "test-agent"


# --- allow-list ---


@pytest.mark.parametrize(
    "url", ["https://quotes.toscrape.com/", "http://books.toscrape.com/catalogue/page-2.html"]
)
def test_allow_list_accepts_practice_sites(url):
    assert_allowed(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/",
        "https://quotes.toscrape.com.evil.test/",  # look-alike suffix
        "https://evil.test/quotes.toscrape.com/",  # host appears only in the path
        "ftp://quotes.toscrape.com/",
        "file:///etc/passwd",
        "not a url",
    ],
)
def test_allow_list_rejects_everything_else(url):
    with pytest.raises(NotAllowedError):
        assert_allowed(url)


# --- robots.txt (RFC 9309) ---


def policy(status: int, body: str = "", clock=None, raises: bool = False):
    calls = []

    def fetch(url: str):
        calls.append(url)
        if raises:
            raise ConnectionError("down")
        return status, body

    return RobotsPolicy(fetch, clock=clock or (lambda: 0.0)), calls


def test_robots_2xx_is_parsed():
    p, _ = policy(200, "User-agent: *\nDisallow: /private\n")
    assert p.allowed("https://quotes.toscrape.com/public", UA)
    assert not p.allowed("https://quotes.toscrape.com/private/x", UA)


def test_robots_4xx_means_no_rules():
    p, _ = policy(404)
    assert p.allowed("https://quotes.toscrape.com/anything", UA)


@pytest.mark.parametrize("status", [500, 503])
def test_robots_5xx_means_complete_disallow(status):
    p, _ = policy(status)
    assert not p.allowed("https://quotes.toscrape.com/", UA)


def test_robots_network_error_means_complete_disallow():
    p, _ = policy(0, raises=True)
    assert not p.allowed("https://quotes.toscrape.com/", UA)
    assert p.crawl_delay("https://quotes.toscrape.com/", UA) == 0.0


def test_robots_is_cached_for_24h_then_refetched():
    clock = FakeClock(0)
    p, calls = policy(200, "User-agent: *\nAllow: /\n", clock=clock)
    p.allowed("https://quotes.toscrape.com/a", UA)
    p.allowed("https://quotes.toscrape.com/b", UA)
    assert len(calls) == 1
    clock.now += 86_401
    p.allowed("https://quotes.toscrape.com/c", UA)
    assert len(calls) == 2


def test_robots_crawl_delay_is_exposed():
    p, _ = policy(200, "User-agent: *\nCrawl-delay: 7\n")
    assert p.crawl_delay("https://quotes.toscrape.com/", UA) == 7.0


# --- rate limiter ---


def test_rate_limiter_spaces_requests():
    clock = FakeClock()
    limiter = RateLimiter(2.0, clock=clock, sleep=clock.sleep)
    limiter.wait()  # first request never waits
    clock.now += 0.5
    limiter.wait()  # 0.5s elapsed of 2s
    limiter.wait()  # immediately again
    assert clock.slept == [1.5, 2.0]


def test_rate_limiter_does_not_sleep_when_enough_time_passed():
    clock = FakeClock()
    limiter = RateLimiter(1.0, clock=clock, sleep=clock.sleep)
    limiter.wait()
    clock.now += 5
    limiter.wait()
    assert clock.slept == []


def test_rate_limiter_honors_a_larger_crawl_delay():
    clock = FakeClock()
    limiter = RateLimiter(1.0, clock=clock, sleep=clock.sleep)
    limiter.wait()
    limiter.wait(extra_interval=10)
    assert clock.slept == [10]


# --- cache ---


def test_cache_round_trip_and_ttl(tmp_path):
    clock = FakeClock(0)
    cache = DiskCache(tmp_path, ttl_seconds=60, clock=clock)
    assert cache.get("https://quotes.toscrape.com/") is None
    cache.put("https://quotes.toscrape.com/", "<html>é</html>")
    assert cache.get("https://quotes.toscrape.com/") == "<html>é</html>"
    clock.now = 61
    assert cache.get("https://quotes.toscrape.com/") is None


def test_cache_key_is_a_hash_not_a_path(tmp_path):
    cache = DiskCache(tmp_path)
    cache.put("https://quotes.toscrape.com/../../etc/passwd", "x")
    files = list(tmp_path.iterdir())
    assert len(files) == 1 and files[0].parent == tmp_path and files[0].suffix == ".json"


def test_cache_survives_a_corrupt_file(tmp_path):
    cache = DiskCache(tmp_path)
    cache.put("https://quotes.toscrape.com/", "x")
    next(tmp_path.iterdir()).write_text("{not json", encoding="utf-8")
    assert cache.get("https://quotes.toscrape.com/") is None


# --- parsers ---


def test_parse_quotes_skips_malformed_blocks_and_finds_next_page():
    quotes, nxt = parse_quotes(fixture("quotes_page1.html"), "https://quotes.toscrape.com/")
    assert [(q.text, q.author, q.tags) for q in quotes] == [
        ("“First fixture quote.”", "Ada Example", ["one", "two"]),
        ("“Second fixture quote.”", "Ben Sample", []),
    ]
    assert nxt == "https://quotes.toscrape.com/page/2/"


def test_parse_quotes_last_page_has_no_next():
    quotes, nxt = parse_quotes(fixture("quotes_page2.html"), "https://quotes.toscrape.com/page/2/")
    assert len(quotes) == 1 and nxt is None


def test_parse_books_fields_and_relative_links():
    books, nxt = parse_books(fixture("books_page1.html"), "https://books.toscrape.com/")
    assert [(b.title, b.price_gbp, b.rating, b.in_stock) for b in books] == [
        ("Fixture Book One", 51.77, 3, True),
        ("Fixture Book Two", 9.5, 5, False),
    ]
    assert books[0].url == "https://books.toscrape.com/catalogue/fixture-book-one_1/index.html"
    assert nxt == "https://books.toscrape.com/catalogue/page-2.html"


def test_parse_books_missing_rating_is_none():
    books, nxt = parse_books(fixture("books_page2.html"), "https://books.toscrape.com/catalogue/page-2.html")
    assert books[0].rating is None and books[0].in_stock and nxt is None


def test_records_serialise_to_plain_dicts():
    quotes, _ = parse_quotes(fixture("quotes_page2.html"), "https://quotes.toscrape.com/")
    assert quotes[0].to_dict() == {
        "text": "“Third fixture quote.”",
        "author": "Ada Example",
        "tags": ["three"],
    }


def test_fake_session_defaults_to_404():
    assert FakeSession().get("https://x", headers={}, timeout=1).status_code == 404
