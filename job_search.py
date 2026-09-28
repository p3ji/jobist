"""Public Job Bank and Freehire search for Jobist's local server.

The browser sends search terms, never the full candidate profile. Job Bank's
five-second crawl delay is respected across local requests.
"""

from __future__ import annotations

import html
import json
import re
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlencode


PROVINCES = {"AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"}
JOB_BANK_HOSTS = {"en": "https://www.jobbank.gc.ca", "fr": "https://www.guichetemplois.gc.ca"}
MAX_SOURCE_BYTES = 3 * 1024 * 1024
_job_bank_lock = threading.Lock()
_next_job_bank_request_at = 0.0


def clean_text(markup: object) -> str:
    value = str(markup or "")
    value = re.sub(r"<(script|style)\b[^>]*>[\s\S]*?</\1>", " ", value, flags=re.I)
    value = re.sub(r"<span\b[^>]*class=[\"'][^\"']*wb-inv[^\"']*[\"'][^>]*>[\s\S]*?</span>", " ", value, flags=re.I)
    value = re.sub(r"<br\s*/?\s*>|</(?:p|li|h[1-6])>", "\n", value, flags=re.I)
    value = re.sub(r"<[^>]*>", " ", value)
    value = html.unescape(value)
    value = re.sub(r"[^\S\n]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    return re.sub(r"\n{3,}", "\n\n", value).strip()


def source_text(url: str, accept: str) -> str:
    request = urllib.request.Request(url, headers={
        "Accept": accept,
        "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8",
        "User-Agent": "Jobist/0.3 (+https://jobist.peji.ca)",
    })
    with urllib.request.urlopen(request, timeout=18) as response:
        content = response.read(MAX_SOURCE_BYTES + 1)
    if len(content) > MAX_SOURCE_BYTES:
        raise ValueError("The job source returned too much data")
    return content.decode("utf-8", errors="replace")


def job_bank_text(url: str) -> str:
    global _next_job_bank_request_at
    with _job_bank_lock:
        remaining = _next_job_bank_request_at - time.monotonic()
        if remaining > 0:
            time.sleep(remaining)
        _next_job_bank_request_at = time.monotonic() + 5
    return source_text(url, "text/html")


def _li(chunk: str, kind: str) -> str:
    match = re.search(rf"<li\b[^>]*class=[\"'][^\"']*\b{kind}\b[^\"']*[\"'][^>]*>([\s\S]*?)</li>", chunk, re.I)
    return clean_text(match.group(1)) if match else ""


def parse_job_bank_cards(markup: str, language: str = "en") -> list[dict]:
    host = JOB_BANK_HOSTS.get(language)
    if not host:
        return []
    jobs = []
    pattern = r"<article\b[^>]*id=[\"']article-(\d+)[\"'][^>]*>([\s\S]*?)</article>"
    for match in re.finditer(pattern, markup, re.I):
        posting_id, chunk = match.groups()
        title_match = re.search(r"<span\b[^>]*class=[\"'][^\"']*\bnoctitle\b[^\"']*[\"'][^>]*>([\s\S]*?)</span>", chunk, re.I)
        title = clean_text(title_match.group(1)) if title_match else ""
        if not title:
            continue
        jobs.append({
            "id": f"jobbank-{language}-{posting_id}",
            "source": "Guichet-Emplois" if language == "fr" else "Job Bank",
            "title": title, "company": _li(chunk, "business"), "location": _li(chunk, "location"),
            "posted": _li(chunk, "date"), "url": f"{host}/jobsearch/jobposting/{posting_id}",
            "description": "", "detailId": posting_id, "detailLang": language,
        })
    return jobs[:25]


def _property(markup: str, name: str) -> str:
    match = re.search(rf"<[^>]+property=[\"']{name}[\"'][^>]*>([\s\S]*?)</[^>]+>", markup, re.I)
    return clean_text(match.group(1)) if match else ""


def parse_job_bank_detail(markup: str, posting_id: str, language: str = "en") -> dict:
    if language not in JOB_BANK_HOSTS or not re.fullmatch(r"\d{4,12}", str(posting_id)):
        raise ValueError("Choose a valid Job Bank posting")
    requirements = re.search(
        r"<div\b[^>]*class=[\"'][^\"']*\bjob-posting-detail-requirements\b[^\"']*[\"'][^>]*>"
        r"([\s\S]*?)(?=<div\b[^>]*class=[\"'][^\"']*\bjob-posting-detail-apply\b|<footer\b|$)",
        markup, re.I,
    )
    locality = _property(markup, "addressLocality")
    region = _property(markup, "addressRegion")
    return {
        "title": _property(markup, "title"),
        "company": _property(markup, "hiringOrganization"),
        "jobLocation": ", ".join(part for part in (locality, region) if part),
        "description": clean_text(requirements.group(1))[:40_000] if requirements else "",
        "url": f"{JOB_BANK_HOSTS[language]}/jobsearch/jobposting/{posting_id}",
    }


def search_job_bank(query: str, province: str, language: str) -> list[dict]:
    params = {"searchstring": query, "fage": "14", "sort": "D"}
    if province:
        params["fprov"] = province
    markup = job_bank_text(f"{JOB_BANK_HOSTS[language]}/jobsearch/jobsearch?{urlencode(params)}")
    if not re.search(r"<article\b[^>]*id=[\"']article-\d+|id=[\"']results-count[\"']", markup, re.I):
        raise ValueError("Search page could not be read")
    return parse_job_bank_cards(markup, language)


def search_freehire(query: str) -> list[dict]:
    params = {"q": query, "countries": "ca", "posted_within_days": "14", "limit": "25", "semantic_ratio": "0", "description_format": "text"}
    payload = json.loads(source_text(f"https://freehire.me/api/v1/agent/jobs/search?{urlencode(params)}", "application/json"))
    if not isinstance(payload.get("data"), list):
        raise ValueError("Invalid Freehire response")
    jobs = []
    for item in payload["data"]:
        if not isinstance(item, dict):
            continue
        if re.search(r",\s*(?:US|USA|United States)\s*$", str(item.get("location") or ""), re.I):
            continue
        title = clean_text(item.get("title"))[:200]
        url = item.get("url")
        if not title or not isinstance(url, str) or not url.startswith("https://"):
            continue
        jobs.append({
            "id": "freehire-" + str(item.get("public_slug") or item.get("external_id") or "")[:120],
            "source": "Freehire", "title": title,
            "company": clean_text(item.get("company"))[:160], "location": clean_text(item.get("location"))[:160],
            "posted": str(item.get("posted_at") or "")[:10], "url": url,
            "description": clean_text(item.get("description"))[:35_000], "detailId": "", "detailLang": "",
        })
    return jobs


def scan_jobs(body: dict) -> dict:
    query = " ".join(str(body.get("query") or "").split())
    province = str(body.get("province") or "").upper()
    language = str(body.get("language") or "en")
    if not 2 <= len(query) <= 120:
        raise ValueError("Enter 2 to 120 characters of job search terms")
    if province and province not in PROVINCES:
        raise ValueError("Choose a valid province or all Canada")
    if language not in {"en", "fr", "both"}:
        raise ValueError("Choose a valid search language")
    calls = [("Freehire", search_freehire, (query,))]
    if language in {"fr", "both"}:
        calls.append(("Guichet-Emplois", search_job_bank, (query, province, "fr")))
    if language in {"en", "both"}:
        calls.append(("Job Bank", search_job_bank, (query, province, "en")))
    jobs, statuses, seen = [], [], set()
    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        futures = [(name, pool.submit(fn, *args)) for name, fn, args in calls]
        for name, future in futures:
            try:
                source_jobs = future.result()
                statuses.append({"source": name, "ok": True, "count": len(source_jobs)})
                for job in source_jobs:
                    key = re.sub(r"[?#].*$", "", job["url"]).rstrip("/").lower()
                    if key not in seen:
                        jobs.append(job)
                        seen.add(key)
            except Exception:
                statuses.append({"source": name, "ok": False, "count": 0})
    if not any(status["ok"] for status in statuses):
        raise RuntimeError("Job sources are unavailable right now. Try the scan again shortly.")
    return {"jobs": jobs[:50], "sources": statuses, "searchedAt": datetime.now(timezone.utc).isoformat()}


def get_job_bank_detail(posting_id: str, language: str) -> dict:
    if language not in JOB_BANK_HOSTS or not re.fullmatch(r"\d{4,12}", str(posting_id)):
        raise ValueError("Choose a valid Job Bank posting")
    markup = job_bank_text(f"{JOB_BANK_HOSTS[language]}/jobsearch/jobposting/{posting_id}")
    return parse_job_bank_detail(markup, posting_id, language)
