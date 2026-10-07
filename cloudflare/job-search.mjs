// Public job sources. Search terms are supplied by the browser; no profile or AI key is sent here.
const PROVINCES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);
const PROVINCE_FULL_NAMES = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

const PROVINCE_PATTERNS = {
  AB: /\b(AB|Alberta|Calgary|Edmonton|Red Deer|Lethbridge)\b/i,
  BC: /\b(BC|British Columbia|Vancouver|Victoria|Burnaby|Surrey|Richmond|Kelowna|Kamloops|Nanaimo|Abbotsford|Coquitlam)\b/i,
  MB: /\b(MB|Manitoba|Winnipeg|Brandon)\b/i,
  NB: /\b(NB|New Brunswick|Nouveau-Brunswick|Fredericton|Moncton|Saint John)\b/i,
  NL: /\b(NL|Newfoundland|Labrador|Terre-Neuve|St\.?\s*John'?s)\b/i,
  NS: /\b(NS|Nova Scotia|Nouvelle-[ÉE]cosse|Halifax|Dartmouth|Sydney)\b/i,
  NT: /\b(NT|Northwest Territories|Territoires du Nord-Ouest|Yellowknife)\b/i,
  NU: /\b(NU|Nunavut|Iqaluit)\b/i,
  ON: /\b(ON|Ontario|Toronto|Ottawa|Mississauga|Brampton|Hamilton|London|Waterloo|Kitchener|Kanata|Markham|Vaughan|Oakville|Burlington|Guelph|Kingston|Sudbury|Thunder Bay)\b/i,
  PE: /\b(PE|PEI|Prince Edward Island|[ÎI]le-du-Prince-[ÉE]douard|Charlottetown)\b/i,
  QC: /\b(QC|Quebec|Qu[ée]bec|Montreal|Montr[ée]al|Laval|Gatineau|Longueuil|Sherbrooke|L[ée]vis|Trois-Rivi[èe]res)\b/i,
  SK: /\b(SK|Saskatchewan|Saskatoon|Regina|Prince Albert|Moose Jaw)\b/i,
  YT: /\b(YT|Yukon|Whitehorse)\b/i,
};

function matchesLocation(jobLoc, province = "", city = "") {
  const loc = String(jobLoc || "").trim();
  if (!province && !city) return true;

  if (city) {
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cityRegex = new RegExp(`\\b${escaped}\\b`, "i");
    if (cityRegex.test(loc)) return true;
    if (province && /\bremote\b/i.test(loc) && PROVINCE_PATTERNS[province]?.test(loc)) return true;
    if (!province && /\bremote\b/i.test(loc)) return true;
    return false;
  }

  if (province) {
    const targetPattern = PROVINCE_PATTERNS[province];
    if (targetPattern?.test(loc)) return true;
    const hasOtherProvince = Object.entries(PROVINCE_PATTERNS).some(([code, pat]) => code !== province && pat.test(loc));
    if (hasOtherProvince) return false;
    if (/\b(remote|canada)\b/i.test(loc)) return true;
    return false;
  }
  return true;
}

const JOB_BANK_HOSTS = { en: "https://www.jobbank.gc.ca", fr: "https://www.guichetemplois.gc.ca" };
const MAX_SOURCE_BYTES = 3 * 1024 * 1024;
let jobBankQueue = Promise.resolve();
let nextJobBankRequestAt = 0;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanText = html => String(html || "")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<span\b[^>]*class=["'][^"']*wb-inv[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, " ")
  .replace(/<br\s*\/?\s*>|<\/p>|<\/li>|<\/h[1-6]>/gi, "\n")
  .replace(/<[^>]*>/g, " ")
  .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash);/gi, (_, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };
    const value = entity.toLowerCase();
    if (value in named) return named[value];
    const codePoint = value.startsWith("#x") ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value.slice(1), 10);
    return Number.isInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : " ";
  })
  .replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

async function responseText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let length = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SOURCE_BYTES) throw new Error("The job source returned too much data");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function fetchSource(url, accept, userAgent) {
  const response = await fetch(url, {
    headers: { Accept: accept, "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8", "User-Agent": userAgent || "Jobist/0.3 (+https://jobist.peji.ca)" },
    signal: AbortSignal.timeout(18_000),
  });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  return responseText(response);
}

// Job Bank asks crawlers for a five-second delay. Queue requests within each Worker instance.
function fetchJobBank(url) {
  const current = jobBankQueue.then(async () => {
    const remaining = nextJobBankRequestAt - Date.now();
    if (remaining > 0) await delay(remaining);
    nextJobBankRequestAt = Date.now() + 5000;
    return fetchSource(url, "text/html");
  });
  jobBankQueue = current.then(() => {}, () => {});
  return current;
}

function listItem(chunk, kind) {
  const match = chunk.match(new RegExp(`<li\\b[^>]*class=["'][^"']*\\b${kind}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/li>`, "i"));
  return match ? cleanText(match[1]) : "";
}

export function parseJobBankCards(html, lang = "en") {
  const host = JOB_BANK_HOSTS[lang];
  if (!host) return [];
  const jobs = [];
  const pattern = /<article\b[^>]*id=["']article-(\d+)["'][^>]*>([\s\S]*?)<\/article>/gi;
  for (const match of html.matchAll(pattern)) {
    const id = match[1];
    const chunk = match[2];
    const title = cleanText(chunk.match(/<span\b[^>]*class=["'][^"']*\bnoctitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    if (!title) continue;
    jobs.push({
      id: `jobbank-${lang}-${id}`, source: lang === "fr" ? "Guichet-Emplois" : "Job Bank",
      title, company: listItem(chunk, "business"), location: listItem(chunk, "location"),
      posted: listItem(chunk, "date"), url: `${host}/jobsearch/jobposting/${id}`,
      description: "", detailId: id, detailLang: lang,
    });
  }
  return jobs.slice(0, 25);
}

function propertyText(html, property) {
  const match = html.match(new RegExp(`<[^>]+property=["']${property}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));
  return match ? cleanText(match[1]) : "";
}

export function parseJobBankDetail(html, id, lang = "en") {
  const host = JOB_BANK_HOSTS[lang];
  if (!host || !/^\d{4,12}$/.test(String(id))) throw new Error("Invalid Job Bank posting");
  const title = propertyText(html, "title");
  const company = propertyText(html, "hiringOrganization");
  const locality = propertyText(html, "addressLocality");
  const region = propertyText(html, "addressRegion");
  const requirements = html.match(/<div\b[^>]*class=["'][^"']*\bjob-posting-detail-requirements\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bjob-posting-detail-apply\b|<footer\b|$)/i);
  const description = requirements ? cleanText(requirements[1]).slice(0, 40_000) : "";
  return { title, company, jobLocation: [locality, region].filter(Boolean).join(", "), description, url: `${host}/jobsearch/jobposting/${id}` };
}

async function searchJobBank(query, province, lang, city = "") {
  const params = new URLSearchParams({ searchstring: query, fage: "14", sort: "D" });
  if (province) params.set("fprov", province);
  if (city) params.set("locationstring", city);
  const html = await fetchJobBank(`${JOB_BANK_HOSTS[lang]}/jobsearch/jobsearch?${params}`);
  if (!/<article\b[^>]*id=["']article-\d+/.test(html) && !/id=["']results-count["']/.test(html)) throw new Error("Search page could not be read");
  return parseJobBankCards(html, lang);
}

async function searchFreehire(query, province = "", city = "") {
  let searchQ = query;
  if (city) {
    searchQ = `${query} ${city}`;
  } else if (province && PROVINCE_FULL_NAMES[province]) {
    searchQ = `${query} ${PROVINCE_FULL_NAMES[province]}`;
  }
  const params = new URLSearchParams({ q: searchQ, countries: "ca", posted_within_days: "14", limit: "25", semantic_ratio: "0", description_format: "text" });
  const body = await fetchSource(`https://freehire.me/api/v1/agent/jobs/search?${params}`, "application/json");
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error("Invalid API response"); }
  if (!Array.isArray(parsed.data)) throw new Error("Invalid API response");
  return parsed.data.filter(job => job && typeof job === "object" && !/,\s*(?:US|USA|United States)\s*$/i.test(String(job.location || ""))).map(job => ({
    id: `freehire-${String(job.public_slug || job.external_id || "").slice(0, 120)}`,
    source: "Freehire", title: cleanText(job.title).slice(0, 200), company: cleanText(job.company).slice(0, 160),
    location: cleanText(job.location).slice(0, 160), posted: typeof job.posted_at === "string" ? job.posted_at.slice(0, 10) : "",
    url: typeof job.url === "string" && /^https:\/\//.test(job.url) ? job.url : "",
    description: cleanText(job.description).slice(0, 35_000), detailId: "", detailLang: "",
  })).filter(job => job.title && job.url);
}

export function parseElutaCards(html) {
  const jobs = [];
  const pattern = /<div\b[^>]*data-url=["']spl\/([^"'?#]+)(?:\?[^"']*)?["'][^>]*>([\s\S]*?)(?=<div\b[^>]*data-url=["']spl\/|<div\b[^>]*id=["']pagination["']|<footer\b|$)/gi;
  for (const match of html.matchAll(pattern)) {
    const slug = match[1];
    const chunk = match[2];
    if (!match[0].includes("organic-job")) continue;
    const idMatch = slug.match(/-([0-9a-f]{20,40})$/);
    const id = idMatch ? idMatch[1] : slug;
    const titleMatch = chunk.match(/<a\b[^>]*class=["'][^"']*\blk-job-title\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? cleanText(titleMatch[1]) : "";
    if (!title) continue;
    const compMatch = chunk.match(/<a\b[^>]*class=["'][^"']*\blk-employer\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const company = compMatch ? cleanText(compMatch[1]) : "";
    const locMatch = chunk.match(/<span\b[^>]*class=["'][^"']*\blocation\b[^"']*["'][^>]*>\s*<span>([\s\S]*?)<\/span>/i);
    const location = locMatch ? cleanText(locMatch[1]) : "";
    const dateMatch = chunk.match(/<a\b[^>]*class=["'][^"']*\blastseen\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const posted = dateMatch ? cleanText(dateMatch[1]) : "";
    jobs.push({
      id: `eluta-${id}`, source: "Eluta", title, company, location, posted,
      url: `https://www.eluta.ca/spl/job-${id}`, description: "", detailId: id, detailLang: "",
    });
  }
  return jobs.slice(0, 25);
}

export function parseElutaDetail(html, id) {
  const cleanId = String(id || "").replace(/^eluta-/, "");
  if (!/^[0-9a-f]{20,40}$/i.test(cleanId)) throw new RangeError("Invalid Eluta posting");
  const titleMatch = html.match(/<h1\b[^>]*itemprop=["']title["'][^>]*>([\s\S]*?)<\/h1>/i);
  let title = titleMatch ? cleanText(titleMatch[1]) : "";
  if (!title) {
    const m = html.match(/<meta\b[^>]*itemprop=["']title["'][^>]*content=["']([^"']*)["']/i);
    title = m ? cleanText(m[1]) : "";
  }
  const compBlock = html.match(/<[^>]+itemprop=["']hiringOrganization["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  let company = "";
  if (compBlock) {
    const nameMatch = compBlock[1].match(/<span\b[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/span>/i);
    company = cleanText(nameMatch ? nameMatch[1] : compBlock[1]);
  }
  const locMatch = html.match(/<meta\b[^>]*itemprop=["']addressLocality["'][^>]*content=["']([^"']*)["']/i);
  const locality = locMatch ? cleanText(locMatch[1]) : "";
  const regMatch = html.match(/<meta\b[^>]*itemprop=["']addressRegion["'][^>]*content=["']([^"']*)["']/i);
  const region = regMatch ? cleanText(regMatch[1]) : "";
  const jobLocation = [locality, region].filter(Boolean).join(", ");
  const descMatch = html.match(/<div\b[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*(?:bottom|footer|related)["']|<footer\b|$)/i);
  const description = descMatch ? cleanText(descMatch[1]).slice(0, 40_000) : "";
  return { title, company, jobLocation, description, url: `https://www.eluta.ca/spl/job-${cleanId}` };
}

// Eluta's WAF serves degraded (card-less) pages to some datacenter IPs and
// fingerprints TLS clients; a browser User-Agent is the most reliable ask we can make from Workers.
const ELUTA_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function searchEluta(query, location) {
  const params = new URLSearchParams({ q: query });
  if (location) params.set("l", location);
  let html;
  try {
    html = await fetchSource(`https://www.eluta.ca/search?${params}`, "text/html", ELUTA_USER_AGENT);
  } catch (error) {
    // Retry once with the default UA in case the WAF rejects browser-like clients.
    html = await fetchSource(`https://www.eluta.ca/search?${params}`, "text/html");
  }
  if (!html.includes('data-url="spl/') && !html.includes("job-count")) {
    throw new Error("Eluta returned no readable results page");
  }
  return parseElutaCards(html);
}

export async function getElutaDetail(id) {
  const cleanId = String(id || "").replace(/^eluta-/, "");
  if (!/^[0-9a-f]{20,40}$/i.test(cleanId)) throw new RangeError("Invalid Eluta posting");
  const html = await fetchSource(`https://www.eluta.ca/spl/job-${cleanId}`, "text/html", ELUTA_USER_AGENT);
  return parseElutaDetail(html, cleanId);
}

// LinkedIn's public guest endpoints need no authentication. Search returns 10
// cards per page; detail serves a single posting's HTML. The X-Requested-With
// header mirrors the site's own client and keeps responses stable from Workers.
const LINKEDIN_SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const LINKEDIN_DETAIL_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting";

async function fetchLinkedin(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; linkedin-search-cli/1.0)",
      "X-Requested-With": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(18_000),
  });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  return responseText(response);
}

export function parseLinkedinCards(html) {
  const jobs = [];
  const seenIds = new Set();
  for (const chunk of html.split('data-entity-urn="urn:li:jobPosting:').slice(1)) {
    const idMatch = chunk.match(/^(\d+)/);
    if (!idMatch || seenIds.has(idMatch[1])) continue;
    const jobId = idMatch[1];
    const linkMatch = chunk.match(/class="base-card__full-link[^"]*"[^>]*href="([^"]+)"/i);
    const url = linkMatch ? decodeHtmlEntities(linkMatch[1]).split("?")[0] : "";
    let title = cleanText(chunk.match(/class="base-search-card__title[^"]*">([\s\S]*?)<\/h3>/i)?.[1]);
    if (!title) title = cleanText(chunk.match(/class="sr-only"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    if (!title) continue;
    const company = cleanText(chunk.match(/class="base-search-card__subtitle[^"]*">([\s\S]*?)<\/h4>/i)?.[1]);
    const location = cleanText(chunk.match(/class="job-search-card__location[^"]*">([\s\S]*?)<\/span>/i)?.[1]);
    const dateMatch = chunk.match(/class="job-search-card__listdate[^"]*"[^>]*datetime="([^"]+)"/i);
    seenIds.add(jobId);
    jobs.push({
      id: `linkedin-${jobId}`, source: "LinkedIn", title: title.slice(0, 200), company: company.slice(0, 160),
      location: location.slice(0, 160), posted: dateMatch ? dateMatch[1].slice(0, 10) : "",
      url: url || `https://www.linkedin.com/jobs/view/${jobId}`, description: "", detailId: jobId, detailLang: "",
    });
  }
  return jobs;
}

async function searchLinkedin(query, province = "", city = "") {
  const location = city || (PROVINCE_FULL_NAMES[province] || "Canada");
  const params = new URLSearchParams({ keywords: query, location });
  // Two pages of 10 cards each, fetched concurrently to keep scan latency low.
  const settled = await Promise.allSettled([0, 10].map(start => fetchLinkedin(`${LINKEDIN_SEARCH_URL}?${params}&start=${start}`)));
  const jobs = [];
  const seenIds = new Set();
  let failures = 0;
  for (const result of settled) {
    if (result.status !== "fulfilled") { failures += 1; continue; }
    for (const job of parseLinkedinCards(result.value)) {
      if (!seenIds.has(job.detailId)) {
        seenIds.add(job.detailId);
        jobs.push(job);
      }
    }
  }
  // A single failed page is a partial result; every page failing means the
  // source is down, so throw and let scanJobs mark it unavailable.
  if (failures === settled.length) throw new Error("LinkedIn search pages were unreachable");
  return jobs.slice(0, 25);
}

function extractDivContent(html, className) {
  const openRe = new RegExp(`<div[^>]*class="[^"]*${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"[^>]*>`, "i");
  const open = openRe.exec(html);
  if (!open) return null;
  let i = open.index + open[0].length;
  let depth = 1;
  while (depth > 0 && i < html.length) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth += 1; i = nextOpen + 4; } else { depth -= 1; i = nextClose + 6; }
  }
  return html.slice(open.index + open[0].length, i - 6);
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => { const cp = Number.parseInt(hex, 16); return Number.isInteger(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : " "; })
    .replace(/&#(\d+);/g, (_, dec) => { const cp = Number.parseInt(dec, 10); return Number.isInteger(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : " "; })
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&");
}

export function parseLinkedinDetail(html, id) {
  const title = cleanText(html.match(/class="(?:top-card-layout__title|topcard__title)[^"]*"[^>]*>([\s\S]*?)<\/h[12]>/i)?.[1]);
  const company = cleanText(html.match(/class="topcard__org-name-link[^"]*"[^>]*href="[^"]+"[^>]*>([\s\S]*?)<\/a>/i)?.[1]);
  const location = cleanText(html.match(/class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
  const descHtml = extractDivContent(html, "show-more-less-html__markup") ?? extractDivContent(html, "description__text");
  return { title, company, jobLocation: location, description: descHtml ? cleanText(descHtml).slice(0, 40_000) : "", url: `https://www.linkedin.com/jobs/view/${id}` };
}

export async function getLinkedinDetail(id) {
  const cleanId = String(id || "").replace(/^linkedin-/, "");
  if (!/^\d{6,12}$/.test(cleanId)) throw new RangeError("Invalid LinkedIn posting");
  return parseLinkedinDetail(await fetchLinkedin(`${LINKEDIN_DETAIL_URL}/${cleanId}`), cleanId);
}

export async function scanJobs(input) {
  const query = String(input?.query || "").trim().replace(/\s+/g, " ");
  const province = String(input?.province || "").toUpperCase();
  const city = String(input?.city || "").trim();
  const language = String(input?.language || "en");
  if (query.length < 2 || query.length > 120) throw new RangeError("Enter 2 to 120 characters of job search terms");
  if (province && !PROVINCES.has(province)) throw new RangeError("Choose a valid province or all Canada");
  if (!["en", "fr", "both"].includes(language)) throw new RangeError("Choose a valid search language");
  const elutaLocation = [city, province].filter(Boolean).join(", ");
  const sources = [
    { name: "Freehire", task: searchFreehire(query, province, city) },
    { name: "Eluta", task: searchEluta(query, elutaLocation) },
    { name: "LinkedIn", task: searchLinkedin(query, province, city) },
    ...(language === "fr" || language === "both" ? [{ name: "Guichet-Emplois", task: searchJobBank(query, province, "fr", city) }] : []),
    ...(language === "en" || language === "both" ? [{ name: "Job Bank", task: searchJobBank(query, province, "en", city) }] : []),
  ];
  // Job Bank requests are queued above to preserve the source's crawl delay.
  const settled = await Promise.allSettled(sources.map(source => source.task));
  const status = settled.map((result, index) => ({ source: sources[index].name, ok: result.status === "fulfilled", count: result.status === "fulfilled" ? result.value.length : 0 }));
  if (!status.some(item => item.ok)) throw new Error("Job sources are unavailable right now. Try the scan again shortly.");
  const seen = new Set();
  const rawJobs = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const job of result.value) {
      const key = job.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rawJobs.push(job);
    }
  }

  // Filter jobs by province and city if specified
  let finalJobs = rawJobs.filter(job => matchesLocation(job.location, province, city));
  if (city && finalJobs.length < 5 && province) {
    // If strict city filtering yielded fewer than 5, include other matching province jobs
    const broader = rawJobs.filter(job => matchesLocation(job.location, province, "") && !finalJobs.includes(job));
    finalJobs = [...finalJobs, ...broader];
  } else if ((province || city) && !finalJobs.length) {
    // If strict filter removed all, fall back to matching province
    finalJobs = rawJobs.filter(job => matchesLocation(job.location, province, ""));
  }

  return { jobs: finalJobs.slice(0, 50), sources: status, searchedAt: new Date().toISOString() };
}

export async function getJobBankDetail(id, lang) {
  if (!/^\d{4,12}$/.test(String(id)) || !JOB_BANK_HOSTS[lang]) throw new RangeError("Choose a valid Job Bank posting");
  const html = await fetchJobBank(`${JOB_BANK_HOSTS[lang]}/jobsearch/jobposting/${id}`);
  return parseJobBankDetail(html, id, lang);
}

export async function getJobDetail(id, lang, source) {
  const src = String(source || "").toLowerCase();
  const postingId = String(id || "");
  if (src === "linkedin" || postingId.startsWith("linkedin-")) {
    return getLinkedinDetail(postingId);
  }
  if (src === "eluta" || postingId.startsWith("eluta-") || /^[0-9a-f]{20,40}$/i.test(postingId)) {
    return getElutaDetail(postingId);
  }
  return getJobBankDetail(postingId, lang);
}
