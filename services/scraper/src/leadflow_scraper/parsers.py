import re
from dataclasses import asdict, dataclass
from urllib.parse import urljoin

from bs4 import BeautifulSoup

_RATINGS = {"One": 1, "Two": 2, "Three": 3, "Four": 4, "Five": 5}


@dataclass(frozen=True)
class Quote:
    text: str
    author: str
    tags: list[str]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class Book:
    title: str
    price_gbp: float
    rating: int | None
    in_stock: bool
    url: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _next_url(soup: BeautifulSoup, base_url: str) -> str | None:
    link = soup.select_one("li.next a[href]")
    return urljoin(base_url, str(link["href"])) if link else None


def parse_quotes(html: str, base_url: str) -> tuple[list[Quote], str | None]:
    soup = BeautifulSoup(html, "html.parser")
    quotes = []
    for node in soup.select("div.quote"):
        text, author = node.select_one("span.text"), node.select_one("small.author")
        if text is None or author is None:
            continue  # skip a malformed block instead of failing the whole page
        tags = [t.get_text(strip=True) for t in node.select("a.tag")]
        quotes.append(Quote(text.get_text(strip=True), author.get_text(strip=True), tags))
    return quotes, _next_url(soup, base_url)


def parse_books(html: str, base_url: str) -> tuple[list[Book], str | None]:
    soup = BeautifulSoup(html, "html.parser")
    books = []
    for node in soup.select("article.product_pod"):
        link, price = node.select_one("h3 a[title]"), node.select_one("p.price_color")
        if link is None or price is None:
            continue
        stars = node.select_one("p.star-rating")
        classes = stars.get("class") if stars else None
        rating = (
            next((_RATINGS[c] for c in classes if c in _RATINGS), None) if isinstance(classes, list) else None
        )
        availability = node.select_one("p.availability")
        books.append(
            Book(
                title=str(link["title"]),
                price_gbp=float(re.sub(r"[^0-9.]", "", price.get_text())),
                rating=rating,
                in_stock="in stock" in (availability.get_text().lower() if availability else ""),
                url=urljoin(base_url, str(link["href"])),
            )
        )
    return books, _next_url(soup, base_url)
