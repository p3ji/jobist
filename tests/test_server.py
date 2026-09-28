import base64
import io
import json
import unittest
import zipfile
from unittest.mock import patch

import server


class LocalAiTests(unittest.TestCase):
    def test_schema_validation_rejects_missing_fields_and_wrong_types(self):
        schema = {"type": "object", "properties": {"score": {"type": "integer"}}, "required": ["score"]}
        self.assertTrue(server.matches_schema({"score": 80}, schema))
        self.assertFalse(server.matches_schema({}, schema))
        self.assertFalse(server.matches_schema({"score": "80"}, schema))
        self.assertFalse(server.matches_schema({"score": True}, schema))

    def test_extracts_plain_text_and_docx(self):
        text = {"mimeType": "text/plain", "data": base64.b64encode("Analyste à Ottawa".encode()).decode()}
        self.assertEqual(server.extract_local_text(text), "Analyste à Ottawa")

        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Project coordinator</w:t></w:r></w:p></w:body></w:document>')
        docx = {"mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "data": base64.b64encode(stream.getvalue()).decode()}
        self.assertEqual(server.extract_local_text(docx), "Project coordinator")

    def test_extracts_pdf_text_streams(self):
        pdf_bytes = b"%PDF-1.4\nstream\nBT (Senior Project Coordinator) Tj ET\nendstream\n%%EOF"
        pdf = {"mimeType": "application/pdf", "data": base64.b64encode(pdf_bytes).decode()}
        self.assertEqual(server.extract_local_text(pdf), "Senior Project Coordinator")

    def test_rejects_pdf_without_text_layer(self):
        pdf = {"mimeType": "application/pdf", "data": base64.b64encode(b"%PDF-1.4 empty").decode()}
        with self.assertRaisesRegex(ValueError, "no readable text layer"):
            server.extract_local_text(pdf)

    def test_local_request_uses_fixed_loopback_and_no_cloud_key(self):
        handler = object.__new__(server.JobistHandler)
        responses = []
        handler._json_response = lambda status, payload: responses.append((status, payload))
        calls = []

        def fake_response(request, timeout=10):
            calls.append(request)
            return {"choices": [{"message": {"content": '{"result":"ok"}'}}]}

        with patch.object(server, "local_models", return_value=["test-model"]), \
             patch.object(server, "read_json_response", side_effect=fake_response):
            handler._local_request("test-model", "Return JSON", {"type": "object"}, None)

        self.assertEqual(responses[0][1]["output"], {"result": "ok"})
        self.assertEqual(responses[0][1]["provider"], "local")
        self.assertEqual(calls[0].full_url, "http://127.0.0.1:1234/v1/chat/completions")
        body = json.loads(calls[0].data)
        self.assertNotIn("apiKey", body)
        self.assertEqual(body["model"], "test-model")
        self.assertEqual(body["response_format"]["type"], "json_schema")

    def test_rejects_unlisted_model(self):
        handler = object.__new__(server.JobistHandler)
        responses = []
        handler._json_response = lambda status, payload: responses.append((status, payload))
        with patch.object(server, "local_models", return_value=["allowed"]), \
             patch.object(server, "read_json_response") as upstream:
            handler._local_request("other", "Hello", None, None)
        self.assertEqual(responses[0][0], 400)
        upstream.assert_not_called()

    def test_ai_config_endpoint(self):
        handler = object.__new__(server.JobistHandler)
        responses = []
        handler._json_response = lambda status, payload: responses.append((status, payload))
        with patch.object(server, "get_env_key", side_effect=lambda k: "secret" if k == "GEMINI_API_KEY" else ""):
            handler.path = "/api/ai/config"
            handler.do_GET()
        self.assertEqual(responses[0][0], 200)
        self.assertTrue(responses[0][1]["defaultGeminiAvailable"])
        self.assertFalse(responses[0][1]["defaultCohereAvailable"])
        self.assertEqual(responses[0][1]["defaultModel"], "gemini-3.5-flash-lite")

    def test_rerank_returns_false_when_unconfigured(self):
        handler = object.__new__(server.JobistHandler)
        responses = []
        handler._json_response = lambda status, payload: responses.append((status, payload))
        handler.headers = {"Origin": f"http://{server.HOST}:{server.PORT}", "Content-Length": "60"}
        handler.rfile = io.BytesIO(b'{"query":"coord","documents":["doc1"]}')
        handler.path = "/api/jobs/rerank"
        with patch.object(server, "get_env_key", return_value=""):
            handler.do_POST()
        self.assertEqual(responses[0][0], 200)
        self.assertFalse(responses[0][1]["available"])

    def test_normalizes_stringified_json_arrays_from_local_models(self):
        profile_schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"}, "headline": {"type": "string"}, "email": {"type": "string"},
                "location": {"type": "string"}, "languages": {"type": "string"}, "authorization": {"type": "string"},
                "workPreference": {"type": "string"}, "targetRoles": {"type": "string"}, "goals": {"type": "string"},
                "experience": {"type": "string"}, "skills": {"type": "string"}, "education": {"type": "string"},
            },
            "required": ["name", "headline", "email", "location", "languages", "authorization", "workPreference", "targetRoles", "goals", "experience", "skills", "education"],
        }
        gemma_output = {
            "name": "Jane Doe",
            "experience": '[{"company": "TechCorp", "role": "Lead", "start_date": "2020", "end_date": "Present", "description": "Cloud systems"}]',
            "education": '[{"institution": "UofT", "degree": "B.Sc.", "dates": "2016-2020"}]',
            "skills": ["Python", "Go"],
            "authorization": None,
        }
        normalized = server.normalize_output_for_schema(gemma_output, profile_schema)
        self.assertTrue(server.matches_schema(normalized, profile_schema))
        self.assertIn("Lead, TechCorp (2020 - Present) — Cloud systems", normalized["experience"])
        self.assertIn("B.Sc., UofT (2016-2020)", normalized["education"])
        self.assertEqual(normalized["skills"], "Python, Go")
        self.assertEqual(normalized["authorization"], "")

    def test_extracts_json_with_markdown_fences(self):
        fenced = "```json\n{\"score\": 85, \"name\": \"Review\"}\n```"
        self.assertEqual(server.extract_json_object(fenced), {"score": 85, "name": "Review"})
        with_text = "Here is your response:\n{\"score\": 90}\nBest regards."
        self.assertEqual(server.extract_json_object(with_text), {"score": 90})

    def test_get_local_models_info_sorts_loaded_models_first(self):
        mock_api_res = {
            "models": [
                {"key": "deepseek-100b", "type": "llm", "loaded_instances": []},
                {"key": "gemma-4", "name": "Gemma 4", "type": "llm", "loaded_instances": [{"id": "inst-1"}]},
                {"key": "nomic-embed", "type": "embedding", "loaded_instances": []},
            ]
        }
        with patch.object(server, "read_json_response", return_value=mock_api_res):
            info = server.get_local_models_info()
            self.assertEqual(len(info), 2)
            self.assertEqual(info[0]["id"], "gemma-4")
            self.assertTrue(info[0]["loaded"])
            self.assertEqual(info[1]["id"], "deepseek-100b")
            self.assertFalse(info[1]["loaded"])
            self.assertEqual(server.local_models(), ["gemma-4", "deepseek-100b"])


class ProfileInterfaceTests(unittest.TestCase):
    def test_index_contains_three_way_profile_builder(self):
        with open("index.html", "r", encoding="utf-8") as f:
            html = f.read()
        self.assertIn('id="profileUploadModeBtn"', html)
        self.assertIn('id="profileInterviewModeBtn"', html)
        self.assertIn('id="profileReviewModeBtn"', html)
        self.assertIn('id="profileUploadPanel"', html)
        self.assertIn('id="profileInterviewPanel"', html)
        self.assertIn('id="profileReviewPanel"', html)
        self.assertIn('id="profileForm"', html)
        self.assertIn('name="authorization"', html)
        self.assertIn('name="workPreference"', html)
        self.assertIn('name="targetRoles"', html)
        self.assertIn('name="languages"', html)
        self.assertIn('name="goals"', html)

    def test_dist_html_is_synchronized(self):
        with open("index.html", "r", encoding="utf-8") as f1, open("dist/index.html", "r", encoding="utf-8") as f2:
            self.assertEqual(f1.read(), f2.read())

    def test_experience_extraction_preserves_all_achievements(self):
        item = {
            "role": "Staff Engineer",
            "company": "Acme",
            "startDate": "2020",
            "endDate": "2024",
            "achievements": [
                "Built data pipelines handling 10M records",
                "Reduced latency by 40%",
                "Mentored 5 engineers"
            ]
        }
        lines = server.format_experience_items(item)
        self.assertEqual(len(lines), 3)
        self.assertIn("Built data pipelines handling 10M records", lines[0])
        self.assertIn("Reduced latency by 40%", lines[1])
        self.assertIn("Mentored 5 engineers", lines[2])
        self.assertTrue(all("Staff Engineer, Acme (2020 - 2024)" in line for line in lines))

    def test_normalize_profile_data_handles_multiple_roles_and_bullets(self):
        data = {
            "name": "Jane Doe",
            "experience": [
                {
                    "title": "Lead Developer",
                    "company": "TechCorp",
                    "dates": "2021-present",
                    "responsibilities": ["Led backend microservices", "Designed Postgres schemas"]
                },
                {
                    "title": "Junior Developer",
                    "company": "StartCo",
                    "dates": "2019-2021",
                    "achievements": ["Built REST APIs in Flask"]
                }
            ],
            "skills": ["Python", "Docker", "PostgreSQL"],
            "education": [{"degree": "B.Sc. Computer Science", "school": "UToronto", "year": "2019"}]
        }
        normalized = server.normalize_profile_data(data)
        exp_lines = normalized["experience"].split("\n")
        self.assertEqual(len(exp_lines), 3)
        self.assertIn("Led backend microservices", exp_lines[0])
        self.assertIn("Designed Postgres schemas", exp_lines[1])
        self.assertIn("Built REST APIs in Flask", exp_lines[2])
        self.assertIn("B.Sc. Computer Science, UToronto (2019)", normalized["education"])


if __name__ == "__main__":
    unittest.main()

