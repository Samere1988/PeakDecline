#!/usr/bin/env python3
"""
update_logos.py  (FULL UPDATED SCRIPT)

Goal: Increase logo hit rate with:
- aggressive name normalization
- variant generation
- Wikimedia Commons search + file download
- Wikipedia infobox/logo fallback
- retries + rate-limit friendly behavior
- master logo reuse (one logo -> many channels)
- confidence scoring
- CSV outputs: logos_found.csv / logos_missing.csv + summary.txt

Default output folder: static/img/logos  (relative to project root)

USAGE:
  python update_logos.py

Optional env vars:
  LOGO_OUT_DIR="static/img/logos"
  LOGO_LIMIT="0"   (0 = no limit)
  LOGO_SLEEP="0.2" (seconds between requests)
"""

from __future__ import annotations

import os
import re
import csv
import time
import json
import math
import shutil
import random
import hashlib
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

# If this is your PeakDecline project, this block will pull channel names from your DB.
# If the import fails, the script will fall back to reading brands from BRANDS + optional brands.txt.
USE_DB = True
try:
    from app import create_app, db  # type: ignore
    from app.models import Channel  # type: ignore
except Exception:
    USE_DB = False


# ----------------------------
# CONFIG
# ----------------------------

# Output dir (relative to project root by default)
OUT_DIR = Path(os.getenv("LOGO_OUT_DIR", "static/img/logos")).resolve()

# Throttle & retry controls
SLEEP_BETWEEN_REQUESTS = float(os.getenv("LOGO_SLEEP", "0.2"))
REQUEST_TIMEOUT = 20
MAX_RETRIES = 3
BACKOFF_BASE = 0.6  # exponential backoff base seconds

# Limit processing (0 = no limit)
LIMIT = int(os.getenv("LOGO_LIMIT", "0"))

# Prefer vector where possible (SVG), but we’ll accept PNG too.
PREFERRED_EXT_ORDER = ["svg", "png", "webp", "jpg", "jpeg"]

# Words to remove from channel/brand names before searching
STOP_WORDS = {
    "tv", "hd", "uhd", "4k", "channel", "network", "live",
    "plus", "max", "intl", "international", "official",
    "east", "west", "north", "south",
    "us", "usa", "uk", "ca", "canada", "fr", "france",
    "de", "germany", "es", "spain", "it", "italy",
    "pt", "portugal", "latino", "latin", "arabic",
    "sports", "sport"  # NOTE: keep/remove depending on your dataset; variants handle both
}

# Common “signal” words worth appending for search variants
LOGO_HINT_WORDS = ["logo", "channel logo", "tv logo", "wordmark", "icon"]

# Master mapping: one saved logo can serve many channels.
# Keys are your “master” brand slugs. Values are lists of aliases/patterns.
# Add to this as you learn your dataset.
MASTER_LOGOS: Dict[str, List[str]] = {
    "disney": ["disney channel", "disney junior", "disney xd", "disney+","disney plus"],
    "sky": ["sky sports", "sky sports f1", "sky sports news", "sky cinema", "sky atlantic"],
    "hbo": ["hbo max", "hbo family", "hbo signature", "hbo2", "hbo 2"],
    "espn": ["espn2", "espn 2", "espn+", "espn plus"],
    "bbc": ["bbc one", "bbc two", "bbc three", "bbc four", "bbc news"],
    "itv": ["itv1", "itv 1", "itv2", "itv 2", "itv3", "itv 3", "itv4", "itv 4"],
    "cbc": ["cbc news", "cbc gem"],
    "ctv": ["ctv2", "ctv 2", "ctv news"],
}

# Known direct Commons “FilePath” URLs (if you already have a partial list, keep it here).
# These are “highest confidence”.
BRANDS_DIRECT: Dict[str, str] = {
    # "ufc": "https://commons.wikimedia.org/wiki/Special:FilePath/UFC_Logo.svg",
}

# If you want a local list too, create "brands.txt" with one brand per line.
LOCAL_BRANDS_FILE = Path("brands.txt")


# ----------------------------
# DATA MODELS
# ----------------------------

@dataclass
class LogoResult:
    input_name: str
    normalized: str
    slug: str
    found: bool
    method: str
    confidence: float
    source_url: str = ""
    saved_path: str = ""
    variants_tried: str = ""
    error: str = ""


# ----------------------------
# UTILITIES
# ----------------------------

def status(msg: str) -> None:
    print(msg, flush=True)


def sleep_a_bit() -> None:
    if SLEEP_BETWEEN_REQUESTS > 0:
        time.sleep(SLEEP_BETWEEN_REQUESTS)


def safe_filename_slug(name: str) -> str:
    # lower, replace non-alnum with underscore, collapse underscores
    s = name.strip().lower()
    s = re.sub(r"[^\w]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "unknown"


def normalize_name(name: str) -> str:
    # Basic cleanup
    s = name.strip().lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[\(\)\[\]\{\}]", " ", s)
    s = re.sub(r"[-_/|:;,.]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()

    # Remove “noise” tokens but keep the original for variants
    tokens = [t for t in s.split() if t not in STOP_WORDS]
    s2 = " ".join(tokens).strip()

    # Some common normalizations
    s2 = s2.replace("plus", "+").replace("and", "&")
    s2 = re.sub(r"\s+", " ", s2).strip()

    return s2 or s


def generate_variants(name: str) -> List[str]:
    """
    Generates multiple search variants.
    We keep both the raw-ish normalized name, plus stripped versions, plus hint-appended queries.
    """
    n = normalize_name(name)
    variants: List[str] = []
    seen = set()

    def add(v: str):
        v = re.sub(r"\s+", " ", v.strip().lower())
        if not v:
            return
        if v not in seen:
            seen.add(v)
            variants.append(v)

    add(n)

    # Remove trailing “tv” style tokens again (in case)
    words = [w for w in n.split() if w not in STOP_WORDS]
    add(" ".join(words))

    # First 2-3 words (brand core)
    if len(words) >= 2:
        add(" ".join(words[:2]))
    if len(words) >= 3:
        add(" ".join(words[:3]))

    # First word only
    if words:
        add(words[0])

    # Add hint words
    base_variants = variants.copy()
    for bv in base_variants:
        for hint in LOGO_HINT_WORDS:
            add(f"{bv} {hint}")

    # Also try “{name} logo svg”
    for bv in base_variants[:5]:
        add(f"{bv} logo svg")

    return variants[:20]


def sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:10]


def pick_extension_from_url(url: str) -> str:
    # best-effort
    m = re.search(r"\.([a-zA-Z0-9]{2,5})(?:\?|$)", url)
    if m:
        ext = m.group(1).lower()
        if ext in {"svg", "png", "webp", "jpg", "jpeg"}:
            return ext
    return "png"


def existing_logo_for_slug(slug: str) -> Optional[Path]:
    # Look for any ext in preferred order
    for ext in PREFERRED_EXT_ORDER:
        p = OUT_DIR / f"{slug}.{ext}"
        if p.exists() and p.stat().st_size > 0:
            return p
    # Or any file that begins with slug + dot
    for p in OUT_DIR.glob(f"{slug}.*"):
        if p.is_file() and p.stat().st_size > 0:
            return p
    return None


# ----------------------------
# HTTP CLIENT
# ----------------------------

class Http:
    def __init__(self):
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": "Mozilla/5.0 (LogoBot/2.0; +https://example.com)"
        })

    def get_json(self, url: str, params: Dict[str, Any]) -> Any:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                sleep_a_bit()
                r = self.s.get(url, params=params, timeout=REQUEST_TIMEOUT)
                r.raise_for_status()
                return r.json()
            except Exception as e:
                if attempt == MAX_RETRIES:
                    raise
                time.sleep(BACKOFF_BASE * (2 ** (attempt - 1)) + random.random() * 0.2)

    def download(self, url: str, out_path: Path) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                sleep_a_bit()
                r = self.s.get(url, stream=True, timeout=REQUEST_TIMEOUT, allow_redirects=True)
                r.raise_for_status()

                # Write to temp then move (avoid partial files)
                tmp = out_path.with_suffix(out_path.suffix + ".tmp")
                with tmp.open("wb") as f:
                    for chunk in r.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                tmp.replace(out_path)

                # sanity
                if out_path.stat().st_size < 200:
                    raise RuntimeError("Downloaded file too small; likely not a real logo.")
                return
            except Exception:
                # cleanup temp
                try:
                    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
                    if tmp.exists():
                        tmp.unlink()
                except Exception:
                    pass

                if attempt == MAX_RETRIES:
                    raise
                time.sleep(BACKOFF_BASE * (2 ** (attempt - 1)) + random.random() * 0.2)


# ----------------------------
# WIKIMEDIA / WIKIPEDIA LOGIC
# ----------------------------

WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php"
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"

def commons_search_file(http: Http, query: str) -> Optional[str]:
    """
    Search Wikimedia Commons for files with the query.
    Returns a file title like 'File:Something.svg' if found.
    """
    params = {
        "action": "query",
        "format": "json",
        "list": "search",
        "srnamespace": 6,  # File:
        "srlimit": 5,
        "srsearch": query,
    }
    data = http.get_json(WIKIMEDIA_API, params)
    hits = (data.get("query", {}).get("search", []) or [])
    if not hits:
        return None
    # Prefer files that contain "logo" in title
    hits_sorted = sorted(
        hits,
        key=lambda h: (
            0 if "logo" in h.get("title", "").lower() else 1,
            -int(h.get("size", 0)) if str(h.get("size", "")).isdigit() else 0
        )
    )
    return hits_sorted[0].get("title")


def commons_get_file_url(http: Http, file_title: str) -> Optional[str]:
    """
    Given a Commons file title like 'File:XYZ.svg', return a direct URL to the original file.
    """
    params = {
        "action": "query",
        "format": "json",
        "titles": file_title,
        "prop": "imageinfo",
        "iiprop": "url|mime",
    }
    data = http.get_json(WIKIMEDIA_API, params)
    pages = data.get("query", {}).get("pages", {}) or {}
    for _, page in pages.items():
        ii = (page.get("imageinfo") or [])
        if ii:
            return ii[0].get("url")
    return None


def wikipedia_opensearch(http: Http, query: str) -> Optional[str]:
    """
    Uses Wikipedia opensearch to find a likely page title.
    """
    params = {
        "action": "opensearch",
        "format": "json",
        "search": query,
        "limit": 1,
        "namespace": 0,
    }
    data = http.get_json(WIKIPEDIA_API, params)
    # data: [searchterm, [titles...], [descriptions...], [urls...]]
    if isinstance(data, list) and len(data) >= 2 and data[1]:
        return data[1][0]
    return None


def wikipedia_infobox_image_file(http: Http, page_title: str) -> Optional[str]:
    """
    Pull the infobox image (if any) using pageimages. Returns a Commons/Wikipedia file name.
    """
    params = {
        "action": "query",
        "format": "json",
        "titles": page_title,
        "prop": "pageimages",
        "pithumbsize": 800,   # gives thumbnail url; we still can use it directly
        "pilicense": "any",
    }
    data = http.get_json(WIKIPEDIA_API, params)
    pages = data.get("query", {}).get("pages", {}) or {}
    for _, page in pages.items():
        thumb = page.get("thumbnail", {})
        if thumb and thumb.get("source"):
            return thumb["source"]
    return None


# ----------------------------
# MASTER REUSE
# ----------------------------

def master_slug_for_name(name: str) -> Optional[str]:
    """
    Determine whether this name should reuse an existing master logo.
    Returns master slug if matched.
    """
    n = normalize_name(name)
    for master, aliases in MASTER_LOGOS.items():
        # if the master itself appears in normalized name
        if master in safe_filename_slug(n).replace("_", ""):
            return master
        for a in aliases:
            if normalize_name(a) in n:
                return master
    return None


def copy_master_logo(master_slug: str, target_slug: str) -> Optional[Path]:
    src = existing_logo_for_slug(master_slug)
    if not src:
        return None
    # copy with same extension
    dst = OUT_DIR / f"{target_slug}{src.suffix}"
    if dst.exists():
        return dst
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return dst


# ----------------------------
# CORE LOGO FINDER
# ----------------------------

def find_logo_for_name(http: Http, name: str) -> LogoResult:
    normalized = normalize_name(name)
    slug = safe_filename_slug(normalized)

    # 0) Already exists?
    existing = existing_logo_for_slug(slug)
    if existing:
        return LogoResult(
            input_name=name,
            normalized=normalized,
            slug=slug,
            found=True,
            method="cache_exists",
            confidence=1.0,
            source_url="",
            saved_path=str(existing),
            variants_tried="",
        )

    # 1) Direct mapping (highest confidence)
    if slug in BRANDS_DIRECT:
        url = BRANDS_DIRECT[slug]
        ext = pick_extension_from_url(url)
        out = OUT_DIR / f"{slug}.{ext}"
        status(f"FOUND (direct) {name} -> {url}")
        try:
            http.download(url, out)
            return LogoResult(name, normalized, slug, True, "direct_url", 1.0, url, str(out))
        except Exception as e:
            return LogoResult(name, normalized, slug, False, "direct_url_failed", 0.0, url, "", "", str(e))

    # 2) Master reuse (if master logo exists)
    master = master_slug_for_name(name)
    if master and master != slug:
        copied = copy_master_logo(master, slug)
        if copied:
            status(f"REUSE (master) {name} -> {master} (copied)")
            return LogoResult(
                input_name=name,
                normalized=normalized,
                slug=slug,
                found=True,
                method=f"master_reuse:{master}",
                confidence=0.6,
                source_url="",
                saved_path=str(copied),
                variants_tried=master,
            )

    # 3) Commons search via variants
    variants = generate_variants(name)
    variants_tried: List[str] = []

    for v in variants:
        variants_tried.append(v)
        status(f"SEARCH (commons) {name} :: '{v}'")
        try:
            file_title = commons_search_file(http, v)
            if not file_title:
                continue

            file_url = commons_get_file_url(http, file_title)
            if not file_url:
                continue

            ext = pick_extension_from_url(file_url)
            out = OUT_DIR / f"{slug}.{ext}"

            status(f"DOWNLOAD (commons) {name} -> {file_title} -> {file_url}")
            http.download(file_url, out)

            conf = 0.8 if v == normalize_name(name) else 0.7
            return LogoResult(
                input_name=name,
                normalized=normalized,
                slug=slug,
                found=True,
                method="commons_search",
                confidence=conf,
                source_url=file_url,
                saved_path=str(out),
                variants_tried=" | ".join(variants_tried),
            )
        except Exception as e:
            # keep trying next variant; don't fail the whole lookup
            status(f"  (commons attempt failed) {e}")

    # 4) Wikipedia fallback: search -> infobox thumbnail/logo -> download
    # We download the thumbnail source directly if present
    for v in variants[:8]:
        try:
            status(f"SEARCH (wikipedia) {name} :: '{v}'")
            page_title = wikipedia_opensearch(http, v)
            if not page_title:
                continue
            logo_url = wikipedia_infobox_image_file(http, page_title)
            if not logo_url:
                continue

            ext = pick_extension_from_url(logo_url)
            out = OUT_DIR / f"{slug}.{ext}"

            status(f"DOWNLOAD (wikipedia) {name} -> {page_title} -> {logo_url}")
            http.download(logo_url, out)

            return LogoResult(
                input_name=name,
                normalized=normalized,
                slug=slug,
                found=True,
                method="wikipedia_infobox",
                confidence=0.65,
                source_url=logo_url,
                saved_path=str(out),
                variants_tried=" | ".join(variants_tried + [f"wiki:{v}->{page_title}"]),
            )
        except Exception as e:
            status(f"  (wikipedia attempt failed) {e}")

    # 5) Missing
    return LogoResult(
        input_name=name,
        normalized=normalized,
        slug=slug,
        found=False,
        method="missing",
        confidence=0.0,
        source_url="",
        saved_path="",
        variants_tried=" | ".join(variants_tried),
        error="not found via direct/master/commons/wikipedia"
    )


# ----------------------------
# INPUT BRAND LIST
# ----------------------------

def load_brand_names_from_db() -> List[str]:
    """
    Pulls candidate names from your Channel table.
    Tries channel.brand / channel.name / channel.title / channel.display_name as available.
    """
    if not USE_DB:
        return []

    app = create_app()
    names: List[str] = []

    with app.app_context():
        rows = Channel.query.all()
        for ch in rows:
            # Try common attribute names without crashing
            for attr in ("brand", "name", "title", "display_name", "channel_name"):
                if hasattr(ch, attr):
                    val = getattr(ch, attr)
                    if isinstance(val, str) and val.strip():
                        names.append(val.strip())
                        break

    # Deduplicate while preserving order
    seen = set()
    out = []
    for n in names:
        k = n.lower().strip()
        if k not in seen:
            seen.add(k)
            out.append(n)
    return out


def load_brand_names() -> List[str]:
    names: List[str] = []

    # From DB if possible
    if USE_DB:
        status("Loading names from DB (Channel table)...")
        names.extend(load_brand_names_from_db())
        status(f"DB names loaded: {len(names)}")

    # From BRANDS_DIRECT keys
    if BRANDS_DIRECT:
        for k in BRANDS_DIRECT.keys():
            names.append(k)

    # From brands.txt if present
    if LOCAL_BRANDS_FILE.exists():
        status("Loading names from brands.txt ...")
        for line in LOCAL_BRANDS_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                names.append(line)

    # Final dedupe
    seen = set()
    final = []
    for n in names:
        k = n.lower().strip()
        if k not in seen:
            seen.add(k)
            final.append(n)

    return final


# ----------------------------
# OUTPUT WRITERS
# ----------------------------

def write_csv(path: Path, rows: List[LogoResult]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "input_name", "normalized", "slug",
        "found", "method", "confidence",
        "source_url", "saved_path",
        "variants_tried", "error"
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            d = asdict(r)
            w.writerow(d)


def write_summary(path: Path, total: int, found: int, missing: int, out_dir: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    txt = (
        f"Total brands processed: {total}\n"
        f"Logos found: {found}\n"
        f"Logos missing: {missing}\n"
        f"Saved to: {out_dir.as_posix()}\n"
    )
    path.write_text(txt, encoding="utf-8")


# ----------------------------
# MAIN
# ----------------------------

def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    names = load_brand_names()
    if not names:
        status("No names found. Add brands.txt or ensure DB imports work.")
        return

    if LIMIT > 0:
        names = names[:LIMIT]

    status(f"Output folder: {OUT_DIR}")
    status(f"Processing {len(names)} names...\n")

    http = Http()

    results: List[LogoResult] = []
    found_count = 0

    for i, name in enumerate(names, start=1):
        status(f"[{i}/{len(names)}] === {name} ===")
        try:
            r = find_logo_for_name(http, name)
        except Exception as e:
            r = LogoResult(
                input_name=name,
                normalized=normalize_name(name),
                slug=safe_filename_slug(normalize_name(name)),
                found=False,
                method="error",
                confidence=0.0,
                error=str(e),
            )

        results.append(r)

        if r.found:
            found_count += 1
            status(f"✅ FOUND  ({r.method}, conf={r.confidence}) -> {r.saved_path}\n")
        else:
            status(f"❌ MISSING ({r.method})\n")

    missing_count = len(results) - found_count

    found_rows = [r for r in results if r.found]
    missing_rows = [r for r in results if not r.found]

    write_csv(Path("logos_found.csv").resolve(), found_rows)
    write_csv(Path("logos_missing.csv").resolve(), missing_rows)
    write_summary(Path("summary.txt").resolve(), len(results), found_count, missing_count, OUT_DIR)

    status("\nDONE.")
    status(f"Total: {len(results)} | Found: {found_count} | Missing: {missing_count}")
    status(f"Saved logos to: {OUT_DIR}")
    status("Wrote: logos_found.csv, logos_missing.csv, summary.txt")


if __name__ == "__main__":
    main()
