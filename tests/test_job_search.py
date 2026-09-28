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
             patch.object(job_search, "search_job_bank", side_effect=RuntimeError("offline")):
            result = job_search.scan_jobs({"query": "coordinator", "language": "en"})
        self.assertEqual(result["jobs"], freehire)
        self.assertEqual([source["ok"] for source in result["sources"]], [True, False, False])

    def test_invalid_region_is_rejected(self):
        with self.assertRaises(ValueError):
            job_search.scan_jobs({"query": "coordinator", "province": "ZZ"})


if __name__ == "__main__":
    unittest.main()
