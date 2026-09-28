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

    def test_scan_keeps_results_from_available_source(self):
        freehire = [{"url": "https://example.org/jobs/1", "title": "Coordinator"}]
        with patch.object(job_search, "search_freehire", return_value=freehire), \
             patch.object(job_search, "search_job_bank", side_effect=RuntimeError("offline")):
            result = job_search.scan_jobs({"query": "coordinator", "language": "en"})
        self.assertEqual(result["jobs"], freehire)
        self.assertEqual([source["ok"] for source in result["sources"]], [True, False])

    def test_invalid_region_is_rejected(self):
        with self.assertRaises(ValueError):
            job_search.scan_jobs({"query": "coordinator", "province": "ZZ"})


if __name__ == "__main__":
    unittest.main()
