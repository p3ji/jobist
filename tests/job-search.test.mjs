import assert from "node:assert/strict";
import test from "node:test";
import { parseJobBankCards, parseJobBankDetail, scanJobs } from "../cloudflare/job-search.mjs";

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

test("scan combines live sources and reports a partial outage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).startsWith("https://freehire.me/")
    ? Response.json({ data: [{ public_slug: "project-coordinator", title: "Project coordinator", company: "Example employer", location: "Ottawa", posted_at: "2026-09-27", url: "https://example.org/jobs/1", description: "Coordinate projects." }, { title: "US posting", location: "Ontario, CA, US", url: "https://example.org/jobs/2" }] })
    : new Response("Unavailable", { status: 503 });
  try {
    const result = await scanJobs({ query: "project coordinator", language: "en" });
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].description, "Coordinate projects.");
    assert.deepEqual(result.sources.map(source => source.ok), [true, false]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scan rejects invalid region before contacting sources", async () => {
  await assert.rejects(scanJobs({ query: "coordinator", province: "ZZ" }), RangeError);
});
