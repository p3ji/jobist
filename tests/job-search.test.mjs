import assert from "node:assert/strict";
import test from "node:test";
import { getJobDetail, parseElutaCards, parseElutaDetail, parseJobBankCards, parseJobBankDetail, parseLinkedinCards, parseLinkedinDetail, scanJobs } from "../cloudflare/job-search.mjs";

const listing = `<div id="results-count">1</div><article id="article-50365933"><span class="noctitle">Project coordinator</span><ul><li class="business">Example employer</li><li class="location">Ottawa, ON</li><li class="date">September 27, 2026</li></ul></article>`;

test("Job Bank listing and detail preserve source facts", () => {
  const [job] = parseJobBankCards(listing);
  assert.equal(job.title, "Project coordinator");
  assert.equal(job.company, "Example employer");
  assert.equal(job.detailId, "50365933");
  const detail = parseJobBankDetail('<span property="title">Project coordinator</span><span property="hiringOrganization">Example employer</span><span property="addressLocality">Ottawa</span><span property="addressRegion">Ontario</span><div class="job-posting-detail-requirements"><p>Coordinate community projects.</p></div><div class="job-posting-detail-apply">Apply</div>', "50365933");
  assert.equal(detail.description, "Coordinate community projects.");
  assert.equal(detail.jobLocation, "Ottawa, Ontario");
});

test("Eluta listing and detail preserve source facts", () => {
  const markup = '<div data-url="spl/senior-developer-4bba68aea4fe671a81ce9f217f36e23b" class="organic-job"><a class="lk-job-title">Senior Developer</a><a class="employer lk-employer">Acme Corp</a><span class="location"><span>Toronto, ON</span></span><a class="lk lastseen">2 days ago</a></div>';
  const [job] = parseElutaCards(markup);
  assert.equal(job.title, "Senior Developer");
  assert.equal(job.company, "Acme Corp");
  assert.equal(job.location, "Toronto, ON");
  assert.equal(job.detailId, "4bba68aea4fe671a81ce9f217f36e23b");

  const detailMarkup = '<h1 itemprop="title">Senior Developer</h1><div itemprop="hiringOrganization"><span itemprop="name">Acme Corp</span></div><meta itemprop="addressLocality" content="Toronto" /><meta itemprop="addressRegion" content="ON" /><div itemprop="description"><p>Build scalable backend systems.</p></div>';
  const detail = parseElutaDetail(detailMarkup, "4bba68aea4fe671a81ce9f217f36e23b");
  assert.equal(detail.title, "Senior Developer");
  assert.equal(detail.company, "Acme Corp");
  assert.equal(detail.jobLocation, "Toronto, ON");
  assert.equal(detail.description, "Build scalable backend systems.");
});

test("LinkedIn listing and detail preserve source facts", () => {
  const markup = '<ul><li data-entity-urn="urn:li:jobPosting:4467453169"><a class="base-card__full-link" href="https://ca.linkedin.com/jobs/view/pharmacist-at-pharmasave-4467453169?utm=x">x</a><h3 class="base-search-card__title">Pharmacist &amp; Associate</h3><h4 class="base-search-card__subtitle"><a href="/company/pharmasave">Pharmasave Canada</a></h4><span class="job-search-card__location">Calgary, Alberta, Canada</span><time class="job-search-card__listdate" datetime="2026-10-01">Oct 1</time></li></ul>';
  const [job] = parseLinkedinCards(markup);
  assert.equal(job.title, "Pharmacist & Associate");
  assert.equal(job.company, "Pharmasave Canada");
  assert.equal(job.location, "Calgary, Alberta, Canada");
  assert.equal(job.detailId, "4467453169");
  assert.equal(job.source, "LinkedIn");
  assert.ok(job.url.startsWith("https://ca.linkedin.com/jobs/view/"));

  const detailMarkup = '<h2 class="top-card-layout__title">Pharmacist &amp; Associate</h2><a class="topcard__org-name-link" href="/company/pharmasave">Pharmasave Canada</a><span class="topcard__flavor topcard__flavor--bullet">Calgary, Alberta, Canada</span><div class="show-more-less-html__markup"><p>Dispense prescriptions.</p></div>';
  const detail = parseLinkedinDetail(detailMarkup, "4467453169");
  assert.equal(detail.title, "Pharmacist & Associate");
  assert.equal(detail.company, "Pharmasave Canada");
  assert.equal(detail.jobLocation, "Calgary, Alberta, Canada");
  assert.ok(detail.description.includes("Dispense prescriptions."));
});

test("scan combines live sources and reports a partial outage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).startsWith("https://freehire.me/")
    ? Response.json({ data: [{ public_slug: "project-coordinator", title: "Project coordinator", company: "Example employer", location: "Ottawa", posted_at: "2026-09-27", url: "https://example.org/jobs/1", description: "Coordinate projects." }, { title: "US posting", location: "Ontario, CA, US", url: "https://example.org/jobs/2" }] })
    : new Response("Unavailable", { status: 503 });
  try {
    const result = await scanJobs({ query: "project coordinator", language: "en" });
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].description, "Coordinate projects.");
    // Sources are Freehire, Eluta, LinkedIn, Job Bank (en).
    assert.deepEqual(result.sources.map(source => source.ok), [true, false, false, false]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scan rejects invalid region before contacting sources", async () => {
  await assert.rejects(scanJobs({ query: "coordinator", province: "ZZ" }), RangeError);
});
