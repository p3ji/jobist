import unittest
from unittest.mock import patch

import job_search


class JobSearchTests(unittest.TestCase):
    def test_parse_job_bank_listing_and_detail(self):
        cards = '<div id="results-count">1</div><article id="article-50365933"><span class="noctitle">Project coordinator</span><li class="business">Example employer</li><li class="location">Ottawa, ON</li></article>'
        job = job_search.parse_job_bank_cards(cards)[0]
        self.assertEqual(job["title"], "Project coordinator")
        self.assertEqual(job["detailId"], "50365933")
        detail = job_search.parse_job_bank_detail('<span property="title">Project coordinator</span><div class="job-posting-detail-requirements"><p>Coordinate projects.</p></div><div class="job-posting-detail-apply">Apply</div>', "50365933")
        self.assertEqual(detail["description"], "Coordinate projects.")

    def test_parse_eluta_listing_and_detail(self):
        markup = '<div data-url="spl/senior-developer-4bba68aea4fe671a81ce9f217f36e23b" class="organic-job"><a class="lk-job-title">Senior Developer</a><a class="employer lk-employer">Acme Corp</a><span class="location"><span>Toronto, ON</span></span><a class="lk lastseen">2 days ago</a></div>'
        cards = job_search.parse_eluta_cards(markup)
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]["title"], "Senior Developer")
        self.assertEqual(cards[0]["company"], "Acme Corp")
        self.assertEqual(cards[0]["location"], "Toronto, ON")
        self.assertEqual(cards[0]["detailId"], "4bba68aea4fe671a81ce9f217f36e23b")

        detail_markup = '<h1 itemprop="title">Senior Developer</h1><div itemprop="hiringOrganization"><span itemprop="name">Acme Corp</span></div><meta itemprop="addressLocality" content="Toronto" /><meta itemprop="addressRegion" content="ON" /><div itemprop="description"><p>Build scalable backend systems.</p></div>'
        detail = job_search.parse_eluta_detail(detail_markup, "4bba68aea4fe671a81ce9f217f36e23b")
        self.assertEqual(detail["title"], "Senior Developer")
        self.assertEqual(detail["company"], "Acme Corp")
        self.assertEqual(detail["jobLocation"], "Toronto, ON")
        self.assertEqual(detail["description"], "Build scalable backend systems.")

    def test_get_job_detail_routes_by_source_and_id(self):
        with patch.object(job_search, "get_eluta_detail", return_value={"title": "Eluta Job"}) as mock_eluta, \
             patch.object(job_search, "get_job_bank_detail", return_value={"title": "Job Bank Job"}) as mock_jb:
            self.assertEqual(job_search.get_job_detail("4bba68aea4fe671a81ce9f217f36e23b", source="Eluta"), {"title": "Eluta Job"})
            mock_eluta.assert_called_once()
            self.assertEqual(job_search.get_job_detail("12345678", language="en", source="Job Bank"), {"title": "Job Bank Job"})
            mock_jb.assert_called_once()

    def test_scan_keeps_results_from_available_source(self):
        freehire = [{"url": "https://example.org/jobs/1", "title": "Coordinator"}]
        with patch.object(job_search, "search_freehire", return_value=freehire), \
             patch.object(job_search, "search_eluta", side_effect=RuntimeError("offline")), \
             patch.object(job_search, "search_linkedin", side_effect=RuntimeError("offline")), \
             patch.object(job_search, "search_job_bank", side_effect=RuntimeError("offline")):
            result = job_search.scan_jobs({"query": "coordinator", "language": "en"})
        self.assertEqual(result["jobs"], freehire)
        # Sources are Freehire, Eluta, LinkedIn, Job Bank (en).
        self.assertEqual([source["ok"] for source in result["sources"]], [True, False, False, False])

    def test_parse_linkedin_listing_and_detail(self):
        markup = ('<ul>'
                  '<li data-entity-urn="urn:li:jobPosting:4467453169">'
                  '<a class="base-card__full-link" href="https://ca.linkedin.com/jobs/view/pharmacist-at-pharmasave-4467453169?utm=x">x</a>'
                  '<h3 class="base-search-card__title">Pharmacist &amp; Associate</h3>'
                  '<h4 class="base-search-card__subtitle"><a href="/company/pharmasave">Pharmasave Canada</a></h4>'
                  '<span class="job-search-card__location">Calgary, Alberta, Canada</span>'
                  '<time class="job-search-card__listdate" datetime="2026-10-01">Oct 1</time>'
                  '</li></ul>')
        cards = job_search.parse_linkedin_cards(markup)
        self.assertEqual(len(cards), 1)
        card = cards[0]
        self.assertEqual(card["title"], "Pharmacist & Associate")
        self.assertEqual(card["company"], "Pharmasave Canada")
        self.assertEqual(card["location"], "Calgary, Alberta, Canada")
        self.assertEqual(card["detailId"], "4467453169")
        self.assertEqual(card["source"], "LinkedIn")
        self.assertTrue(card["url"].startswith("https://ca.linkedin.com/jobs/view/"))

        detail_markup = ('<h2 class="top-card-layout__title">Pharmacist &amp; Associate</h2>'
                         '<a class="topcard__org-name-link" href="/company/pharmasave">Pharmasave Canada</a>'
                         '<span class="topcard__flavor topcard__flavor--bullet">Calgary, Alberta, Canada</span>'
                         '<div class="show-more-less-html__markup"><p>Dispense prescriptions.</p><ul><li>Care for patients.</li></ul></div>')
        detail = job_search.parse_linkedin_detail(detail_markup, "4467453169")
        self.assertEqual(detail["title"], "Pharmacist & Associate")
        self.assertEqual(detail["company"], "Pharmasave Canada")
        self.assertEqual(detail["jobLocation"], "Calgary, Alberta, Canada")
        self.assertIn("Dispense prescriptions.", detail["description"])

    def test_get_job_detail_routes_linkedin(self):
        with patch.object(job_search, "get_linkedin_detail", return_value={"title": "LinkedIn Job"}) as mock_li:
            self.assertEqual(job_search.get_job_detail("4467453169", source="LinkedIn"), {"title": "LinkedIn Job"})
            mock_li.assert_called_once()

    def test_get_linkedin_detail_rejects_bad_id(self):
        with self.assertRaises(ValueError):
            job_search.get_linkedin_detail("not-a-number")

    def test_invalid_region_is_rejected(self):
        with self.assertRaises(ValueError):
            job_search.scan_jobs({"query": "coordinator", "province": "ZZ"})

    def test_source_text_falls_back_to_curl_on_ssl_failure(self):
        import ssl as _ssl
        class FakeProc:
            returncode = 0
            stdout = b"<html>ok</html>"
            stderr = b""
        with patch.object(job_search.urllib.request, "urlopen", side_effect=_ssl.SSLError("handshake failure")), \
             patch.object(job_search.subprocess, "run", return_value=FakeProc()) as mock_run:
            text = job_search.source_text("https://www.eluta.ca/search?q=x", "text/html")
        self.assertEqual(text, "<html>ok</html>")
        # curl must be invoked with a browser User-Agent and the target URL.
        args = mock_run.call_args[0][0]
        self.assertIn("curl", args)
        self.assertTrue(any(a.startswith("Mozilla/5.0") or "Mozilla/5.0" in a for a in args))
        self.assertIn("https://www.eluta.ca/search?q=x", args)

    def test_source_text_curl_failure_raises_value_error(self):
        import ssl as _ssl
        class FakeProc:
            returncode = 67
            stdout = b""
            stderr = b"HTTP/2 stream error"
        with patch.object(job_search.urllib.request, "urlopen", side_effect=_ssl.SSLError("handshake failure")), \
             patch.object(job_search.subprocess, "run", return_value=FakeProc()):
            with self.assertRaises(ValueError):
                job_search.source_text("https://www.eluta.ca/search?q=x", "text/html")

    def test_eluta_degraded_page_is_reported_as_failure(self):
        # A WAF-served page that has neither organic cards nor a job-count line
        # must surface as a source failure, not an empty result set.
        degraded = "<html><body><div id='app'></div></body></html>"
        with patch.object(job_search, "source_text", return_value=degraded):
            with self.assertRaises(ValueError):
                job_search.search_eluta("hospital pharmacist")

    def test_eluta_real_page_parses_cards(self):
        markup = ('<span class="job-count">12 jobs</span>'
                  '<div data-url="spl/senior-developer-4bba68aea4fe671a81ce9f217f36e23b" class="organic-job">'
                  '<a class="lk-job-title">Senior Developer</a></div>')
        with patch.object(job_search, "source_text", return_value=markup):
            cards = job_search.search_eluta("senior developer")
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]["title"], "Senior Developer")


if __name__ == "__main__":
    unittest.main()
