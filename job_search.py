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
PROVINCE_FULL_NAMES = {
    "AB": "Alberta",
    "BC": "British Columbia",
    "MB": "Manitoba",
    "NB": "New Brunswick",
    "NL": "Newfoundland and Labrador",
    "NS": "Nova Scotia",
    "NT": "Northwest Territories",
    "NU": "Nunavut",
    "ON": "Ontario",
    "PE": "Prince Edward Island",
    "QC": "Quebec",
    "SK": "Saskatchewan",
    "YT": "Yukon",
}

PROVINCE_PATTERNS = {
    "AB": re.compile(r"\b(AB|Alberta|Calgary|Edmonton|Red Deer|Lethbridge)\b", re.I),
    "BC": re.compile(r"\b(BC|British Columbia|Vancouver|Victoria|Burnaby|Surrey|Richmond|Kelowna|Kamloops|Nanaimo|Abbotsford|Coquitlam)\b", re.I),
    "MB": re.compile(r"\b(MB|Manitoba|Winnipeg|Brandon)\b", re.I),
    "NB": re.compile(r"\b(NB|New Brunswick|Nouveau-Brunswick|Fredericton|Moncton|Saint John)\b", re.I),
    "NL": re.compile(r"\b(NL|Newfoundland|Labrador|Terre-Neuve|St\.?\s*John'?s)\b", re.I),
    "NS": re.compile(r"\b(NS|Nova Scotia|Nouvelle-[ÉE]cosse|Halifax|Dartmouth|Sydney)\b", re.I),
    "NT": re.compile(r"\b(NT|Northwest Territories|Territoires du Nord-Ouest|Yellowknife)\b", re.I),
    "NU": re.compile(r"\b(NU|Nunavut|Iqaluit)\b", re.I),
    "ON": re.compile(r"\b(ON|Ontario|Toronto|Ottawa|Mississauga|Brampton|Hamilton|London|Waterloo|Kitchener|Kanata|Markham|Vaughan|Oakville|Burlington|Guelph|Kingston|Sudbury|Thunder Bay)\b", re.I),
    "PE": re.compile(r"\b(PE|PEI|Prince Edward Island|[ÎI]le-du-Prince-[ÉE]douard|Charlottetown)\b", re.I),
    "QC": re.compile(r"\b(QC|Quebec|Qu[ée]bec|Montreal|Montr[ée]al|Laval|Gatineau|Longueuil|Sherbrooke|L[ée]vis|Trois-Rivi[èe]res)\b", re.I),
    "SK": re.compile(r"\b(SK|Saskatchewan|Saskatoon|Regina|Prince Albert|Moose Jaw)\b", re.I),
    "YT": re.compile(r"\b(YT|Yukon|Whitehorse)\b", re.I),
}


def matches_location(job_loc: str, province: str = "", city: str = "") -> bool:
    loc = str(job_loc or "").strip()
    if not province and not city:
        return True

    if city:
        city_regex = re.compile(rf"\b{re.escape(city)}\b", re.I)
        if city_regex.search(loc):
            return True
        if province and re.search(r"\bremote\b", loc, re.I) and PROVINCE_PATTERNS.get(province, re.compile(r"")).search(loc):
            return True
        if not province and re.search(r"\bremote\b", loc, re.I):
            return True
        return False

    if province:
        target_pattern = PROVINCE_PATTERNS.get(province)
        if target_pattern and target_pattern.search(loc):
            return True
        has_other_province = any(code != province and pat.search(loc) for code, pat in PROVINCE_PATTERNS.items())
        if has_other_province:
            return False
        if re.search(r"\b(remote|canada)\b", loc, re.I):
            return True
        return False
    return True


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


def search_job_bank(query: str, province: str, language: str, city: str = "") -> list[dict]:
    params = {"searchstring": query, "fage": "14", "sort": "D"}
    if province:
        params["fprov"] = province
    if city:
        params["locationstring"] = city
    markup = job_bank_text(f"{JOB_BANK_HOSTS[language]}/jobsearch/jobsearch?{urlencode(params)}")
    if not re.search(r"<article\b[^>]*id=[\"']article-\d+|id=[\"']results-count[\"']", markup, re.I):
        raise ValueError("Search page could not be read")
    return parse_job_bank_cards(markup, language)


def search_freehire(query: str, province: str = "", city: str = "") -> list[dict]:
    search_q = query
    if city:
        search_q = f"{query} {city}"
    elif province and province in PROVINCE_FULL_NAMES:
        search_q = f"{query} {PROVINCE_FULL_NAMES[province]}"
    params = {"q": search_q, "countries": "ca", "posted_within_days": "14", "limit": "25", "semantic_ratio": "0", "description_format": "text"}
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


def parse_eluta_cards(markup: str) -> list[dict]:
    cards = []
    pattern = r"<div\b[^>]*data-url=[\"']spl/([^\"\'?#]+)(?:\?[^\"\']*)?[\"'][^>]*>([\s\S]*?)(?=<div\b[^>]*data-url=[\"']spl/|<div\b[^>]*id=[\"']pagination[\"']|<footer\b|$)"
    for match in re.finditer(pattern, markup, re.I):
        slug, chunk = match.groups()
        if "organic-job" not in match.group(0):
            continue
        id_match = re.search(r"-([0-9a-f]{20,40})$", slug)
        job_id = id_match.group(1) if id_match else slug
        title_m = re.search(r"<a\b[^>]*class=[\"'][^\"']*\blk-job-title\b[^\"']*[\"'][^>]*>([\s\S]*?)</a>", chunk, re.I)
        title = clean_text(title_m.group(1)) if title_m else ""
        if not title:
            continue
        comp_m = re.search(r"<a\b[^>]*class=[\"'][^\"']*\blk-employer\b[^\"']*[\"'][^>]*>([\s\S]*?)</a>", chunk, re.I)
        comp = clean_text(comp_m.group(1)) if comp_m else ""
        loc_m = re.search(r"<span\b[^>]*class=[\"'][^\"']*\blocation\b[^\"']*[\"'][^>]*>\s*<span>([\s\S]*?)</span>", chunk, re.I)
        loc = clean_text(loc_m.group(1)) if loc_m else ""
        date_m = re.search(r"<a\b[^>]*class=[\"'][^\"']*\blastseen\b[^\"']*[\"'][^>]*>([\s\S]*?)</a>", chunk, re.I)
        date = clean_text(date_m.group(1)) if date_m else ""
        cards.append({
            "id": f"eluta-{job_id}",
            "source": "Eluta",
            "title": title,
            "company": comp,
            "location": loc,
            "posted": date,
            "url": f"https://www.eluta.ca/spl/job-{job_id}",
            "description": "",
            "detailId": job_id,
            "detailLang": "",
        })
    return cards[:25]


def parse_eluta_detail(markup: str, posting_id: str) -> dict:
    clean_id = str(posting_id).replace("eluta-", "")
    if not re.fullmatch(r"[0-9a-f]{20,40}", clean_id):
        raise ValueError("Choose a valid Eluta posting")
    title_m = re.search(r"<h1\b[^>]*itemprop=[\"']title[\"'][^>]*>([\s\S]*?)</h1>", markup, re.I)
    title = clean_text(title_m.group(1)) if title_m else ""
    if not title:
        m = re.search(r"<meta\b[^>]*itemprop=[\"']title[\"'][^>]*content=[\"']([^\"']*)[\"']", markup, re.I)
        title = clean_text(m.group(1)) if m else ""

    comp_m = re.search(r"<[^>]+itemprop=[\"']hiringOrganization[\"'][^>]*>([\s\S]*?)</[^>]+>", markup, re.I)
    comp = ""
    if comp_m:
        name_m = re.search(r"<span\b[^>]*itemprop=[\"']name[\"'][^>]*>([\s\S]*?)</span>", comp_m.group(1), re.I)
        comp = clean_text(name_m.group(1)) if name_m else clean_text(comp_m.group(1))

    loc_m = re.search(r"<meta\b[^>]*itemprop=[\"']addressLocality[\"'][^>]*content=[\"']([^\"']*)[\"']", markup, re.I)
    locality = clean_text(loc_m.group(1)) if loc_m else ""
    reg_m = re.search(r"<meta\b[^>]*itemprop=[\"']addressRegion[\"'][^>]*content=[\"']([^\"']*)[\"']", markup, re.I)
    region = clean_text(reg_m.group(1)) if reg_m else ""
    location = ", ".join(p for p in (locality, region) if p)

    desc_m = re.search(r"<div\b[^>]*itemprop=[\"']description[\"'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=[\"'][^\"']*(?:bottom|footer|related)[\"']|<footer\b|$)", markup, re.I)
    desc = clean_text(desc_m.group(1)) if desc_m else ""

    return {
        "title": title,
        "company": comp,
        "jobLocation": location,
        "description": desc[:40_000],
        "url": f"https://www.eluta.ca/spl/job-{clean_id}",
    }


def search_eluta(query: str, location: str = "") -> list[dict]:
    params = {"q": query}
    if location:
        params["l"] = location
    markup = source_text(f"https://www.eluta.ca/search?{urlencode(params)}", "text/html")
    return parse_eluta_cards(markup)


def get_eluta_detail(posting_id: str) -> dict:
    clean_id = str(posting_id).replace("eluta-", "")
    if not re.fullmatch(r"[0-9a-f]{20,40}", clean_id):
        raise ValueError("Choose a valid Eluta posting")
    markup = source_text(f"https://www.eluta.ca/spl/job-{clean_id}", "text/html")
    return parse_eluta_detail(markup, clean_id)


def scan_jobs(body: dict) -> dict:
    query = " ".join(str(body.get("query") or "").split())
    province = str(body.get("province") or "").upper()
    city = str(body.get("city") or "").strip()
    language = str(body.get("language") or "en")
    if not 2 <= len(query) <= 120:
        raise ValueError("Enter 2 to 120 characters of job search terms")
    if province and province not in PROVINCES:
        raise ValueError("Choose a valid province or all Canada")
    if language not in {"en", "fr", "both"}:
        raise ValueError("Choose a valid search language")
    eluta_loc = ", ".join(p for p in (city, province) if p)
    calls = [
        ("Freehire", search_freehire, (query, province, city)),
        ("Eluta", search_eluta, (query, eluta_loc)),
    ]
    if language in {"fr", "both"}:
        calls.append(("Guichet-Emplois", search_job_bank, (query, province, "fr", city)))
    if language in {"en", "both"}:
        calls.append(("Job Bank", search_job_bank, (query, province, "en", city)))
    raw_jobs, statuses, seen = [], [], set()
    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        futures = [(name, pool.submit(fn, *args)) for name, fn, args in calls]
        for name, future in futures:
            try:
                source_jobs = future.result()
                statuses.append({"source": name, "ok": True, "count": len(source_jobs)})
                for job in source_jobs:
                    key = re.sub(r"[?#].*$", "", job["url"]).rstrip("/").lower()
                    if key not in seen:
                        raw_jobs.append(job)
                        seen.add(key)
            except Exception:
                statuses.append({"source": name, "ok": False, "count": 0})
    if not any(status["ok"] for status in statuses):
        raise RuntimeError("Job sources are unavailable right now. Try the scan again shortly.")

    # Filter jobs by province and city
    final_jobs = [job for job in raw_jobs if matches_location(job.get("location"), province, city)]
    if city and len(final_jobs) < 5 and province:
        broader = [job for job in raw_jobs if matches_location(job.get("location"), province, "") and job not in final_jobs]
        final_jobs.extend(broader)
    elif (province or city) and not final_jobs:
        final_jobs = [job for job in raw_jobs if matches_location(job.get("location"), province, "")]

    return {"jobs": final_jobs[:50], "sources": statuses, "searchedAt": datetime.now(timezone.utc).isoformat()}


def get_job_bank_detail(posting_id: str, language: str) -> dict:
    if language not in JOB_BANK_HOSTS or not re.fullmatch(r"\d{4,12}", str(posting_id)):
        raise ValueError("Choose a valid Job Bank posting")
    markup = job_bank_text(f"{JOB_BANK_HOSTS[language]}/jobsearch/jobposting/{posting_id}")
    return parse_job_bank_detail(markup, posting_id, language)


def get_job_detail(posting_id: str, language: str = "en", source: str = "") -> dict:
    source_lower = str(source or "").lower()
    posting_str = str(posting_id or "")
    if source_lower == "eluta" or posting_str.startswith("eluta-") or re.fullmatch(r"[0-9a-f]{20,40}", posting_str):
        return get_eluta_detail(posting_str)
    return get_job_bank_detail(posting_str, language)
