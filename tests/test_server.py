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

    def test_rejects_unsupported_pdf(self):
        pdf = {"mimeType": "application/pdf", "data": base64.b64encode(b"%PDF").decode()}
        with self.assertRaisesRegex(ValueError, "Local AI currently reads"):
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


if __name__ == "__main__":
    unittest.main()
