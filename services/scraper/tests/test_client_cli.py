import json

import pytest
from conftest import FakeSession

from leadflow_scraper import cli
from leadflow_scraper.cache import DiskCache
from leadflow_scraper.client import USER_AGENT, DisallowedByRobotsError, FetchError, PoliteClient
from leadflow_scraper.policy import NotAllowedError
from leadflow_scraper.ratelimit import RateLimiter


def make_client(site, clock, cache=None, interval=1.0):
    limiter = RateLimiter(interval, clock=clock, sleep=clock.sleep)
    return PoliteClient(site, cache=cache, limiter=limiter, clock=clock)


def test_fetches_robots_first_then_the_page_with_an_identifying_user_agent(site, clock):
    body = make_client(site, clock).get("https://quotes.toscrape.com/")
    assert "First fixture quote" in body
    assert site.urls == ["https://quotes.toscrape.com/robots.txt", "https://quotes.toscrape.com/"]
    assert all(call[1]["User-Agent"] == USER_AGENT for call in site.calls)
    assert "dctech.live" in USER_AGENT
    assert all(call[2] == 10.0 for call in site.calls)  # a timeout is always set


def test_requests_are_spaced_by_the_rate_limit(site, clock):
    client = make_client(site, clock, interval=1.0)
    client.get("https://quotes.toscrape.com/")
    client.get("https://quotes.toscrape.com/page/2/")
    # robots.txt, page 1, page 2 = 3 network requests -> two enforced waits
    assert clock.slept == [1.0, 1.0]


def test_a_host_outside_the_allow_list_is_never_contacted(site, clock):
    client = make_client(site, clock)
    with pytest.raises(NotAllowedError):
        client.get("https://example.com/")
    assert site.calls == []


def test_robots_disallow_blocks_the_fetch_even_when_cached(site, clock, tmp_path):
    cache = DiskCache(tmp_path, clock=clock)
    cache.put("https://quotes.toscrape.com/admin/panel", "secret")
    site.routes["https://quotes.toscrape.com/admin/panel"] = (200, "secret")
    client = make_client(site, clock, cache=cache)
    with pytest.raises(DisallowedByRobotsError):
        client.get("https://quotes.toscrape.com/admin/panel")
    assert "https://quotes.toscrape.com/admin/panel" not in site.urls


def test_unreachable_robots_stops_everything(clock):
    site = FakeSession(raise_on={"https://quotes.toscrape.com/robots.txt"})
    with pytest.raises(DisallowedByRobotsError):
        make_client(site, clock).get("https://quotes.toscrape.com/")
    assert site.urls == ["https://quotes.toscrape.com/robots.txt"]


def test_second_read_is_served_from_cache_without_network(site, clock, tmp_path):
    client = make_client(site, clock, cache=DiskCache(tmp_path, clock=clock))
    first = client.get("https://quotes.toscrape.com/")
    before = client.network_requests
    assert client.get("https://quotes.toscrape.com/") == first
    assert client.network_requests == before


def test_expired_cache_entry_is_refetched(site, clock, tmp_path):
    client = make_client(site, clock, cache=DiskCache(tmp_path, ttl_seconds=10, clock=clock))
    client.get("https://quotes.toscrape.com/")
    clock.now += 11
    client.get("https://quotes.toscrape.com/")
    assert site.urls.count("https://quotes.toscrape.com/") == 2


def test_non_200_raises_and_is_not_cached(site, clock, tmp_path):
    site.routes["https://quotes.toscrape.com/boom"] = (503, "busy")
    cache = DiskCache(tmp_path, clock=clock)
    with pytest.raises(FetchError, match="503"):
        make_client(site, clock, cache=cache).get("https://quotes.toscrape.com/boom")
    assert cache.get("https://quotes.toscrape.com/boom") is None


def test_crawl_delay_in_robots_raises_the_wait(clock):
    site = FakeSession(
        routes={
            "https://quotes.toscrape.com/robots.txt": (200, "User-agent: *\nCrawl-delay: 5\n"),
            "https://quotes.toscrape.com/": (200, "<html></html>"),
        }
    )
    make_client(site, clock, interval=1.0).get("https://quotes.toscrape.com/")
    assert clock.slept == [5.0]


# --- CLI ---


def run(args, site, capsys):
    code = cli.main(args, session_factory=lambda: site)
    out = capsys.readouterr()
    return code, out.out, out.err


def test_cli_scrapes_quotes_across_pages_to_json_lines(site, capsys, tmp_path, monkeypatch):
    monkeypatch.setattr("leadflow_scraper.ratelimit.time.sleep", lambda _s: None)
    code, out, err = run(["quotes", "--pages", "2", "--cache-dir", str(tmp_path)], site, capsys)
    records = [json.loads(line) for line in out.splitlines()]
    assert code == 0
    assert [r["author"] for r in records] == ["Ada Example", "Ben Sample", "Ada Example"]
    assert "3 records, 3 network requests" in err  # robots + 2 pages


def test_cli_stops_at_the_requested_page_count(site, capsys, tmp_path, monkeypatch):
    monkeypatch.setattr("leadflow_scraper.ratelimit.time.sleep", lambda _s: None)
    code, out, _ = run(["books", "--pages", "1", "--no-cache", "--cache-dir", str(tmp_path)], site, capsys)
    assert code == 0
    assert len(out.splitlines()) == 2
    assert "https://books.toscrape.com/catalogue/page-2.html" not in site.urls


def test_cli_writes_to_a_file(site, capsys, tmp_path, monkeypatch):
    monkeypatch.setattr("leadflow_scraper.ratelimit.time.sleep", lambda _s: None)
    target = tmp_path / "books.jsonl"
    code, out, _ = run(["books", "--pages", "2", "--out", str(target), "--no-cache"], site, capsys)
    assert code == 0 and out == ""
    assert len(target.read_text(encoding="utf-8").splitlines()) == 3


def test_cli_reports_a_robots_stop_with_exit_code_1(capsys):
    site = FakeSession(
        routes={"https://quotes.toscrape.com/robots.txt": (200, "User-agent: *\nDisallow: /\n")}
    )
    code, _, err = run(["quotes", "--no-cache"], site, capsys)
    assert code == 1 and "stopped" in err


@pytest.mark.parametrize("flags", [["--pages", "0"], ["--pages", "51"], ["--min-interval", "0.1"]])
def test_cli_rejects_impolite_or_silly_settings(flags, site, capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["quotes", *flags], session_factory=lambda: site)
    assert exc.value.code == 2
    assert site.calls == []
    capsys.readouterr()


def test_cli_stops_when_the_site_runs_out_of_pages(site, capsys, monkeypatch):
    monkeypatch.setattr("leadflow_scraper.ratelimit.time.sleep", lambda _s: None)
    code, out, err = run(["quotes", "--pages", "10", "--no-cache"], site, capsys)
    assert code == 0 and len(out.splitlines()) == 3
    assert "3 network requests" in err  # robots + 2 pages, not 10
