"""Small Jobist server with ephemeral Gemini and local LM Studio adapters.

The API key and request body are held only for the duration of one request. This
server deliberately does not log headers, request bodies, prompts, or responses.
"""

from __future__ import annotations

import json
import base64
import io
import random
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from job_search import get_job_bank_detail, scan_jobs


HOST = "127.0.0.1"
PORT = 8080
MAX_REQUEST_BYTES = 16 * 1024 * 1024
ROOT = Path(__file__).resolve().parent
MODEL_PATTERN = re.compile(r"^gemini-[a-z0-9.-]+$")
LOCAL_BASE = "http://127.0.0.1:1234"
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_EXTRACTED_CHARS = 80_000


def read_json_response(request: urllib.request.Request, timeout: int = 10) -> dict:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(MAX_OUTPUT_BYTES + 1)
    if len(raw) > MAX_OUTPUT_BYTES:
        raise ValueError("The AI service response was too large")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("The AI service returned an invalid response")
    return result


def local_models() -> list[str]:
    request = urllib.request.Request(f"{LOCAL_BASE}/api/v1/models")
    result = read_json_response(request)
    models = result.get("models", [])
    return [model["key"] for model in models if isinstance(model, dict)
            and model.get("type") == "llm" and isinstance(model.get("key"), str)]


def matches_schema(value: object, schema: dict) -> bool:
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return False
        properties = schema.get("properties", {})
        if any(key not in value for key in schema.get("required", [])):
            return False
        return all(key not in properties or matches_schema(item, properties[key])
                   for key, item in value.items())
    if kind == "array":
        return isinstance(value, list) and all(matches_schema(item, schema.get("items", {})) for item in value)
    if kind == "string":
        return isinstance(value, str) and ("enum" not in schema or value in schema["enum"])
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    return True


def extract_local_text(file_data: dict) -> str:
    mime_type = file_data.get("mimeType")
    encoded = file_data.get("data")
    if not isinstance(encoded, str) or not isinstance(mime_type, str):
        raise ValueError("Invalid file payload")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("Invalid file payload") from error
    if len(raw) > 10 * 1024 * 1024:
        raise ValueError("Choose a file smaller than 10 MB")
    if mime_type in {"text/plain", "text/markdown"}:
        text = raw.decode("utf-8-sig")
    elif mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > 4 * 1024 * 1024:
                raise ValueError("The Word document contains too much text")
            root = ET.fromstring(archive.read(info))
        namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        paragraphs = []
        for paragraph in root.iter(f"{namespace}p"):
            paragraphs.append("".join(node.text or "" for node in paragraph.iter(f"{namespace}t")))
        text = "\n".join(paragraphs)
    else:
        raise ValueError("Local AI currently reads .txt, .md, and .docx files. Enter PDF or .doc facts manually, or choose Gemini")
    text = text.strip()
    if not text:
        raise ValueError("The document has no readable text")
    if len(text) > MAX_EXTRACTED_CHARS:
        raise ValueError("The document text is too long for Local AI")
    return text


class JobistHandler(SimpleHTTPRequestHandler):
    server_version = "Jobist/0.2"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self'; "
            "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
            "form-action 'self'; base-uri 'none'",
        )
        super().end_headers()

    def log_message(self, format: str, *args) -> None:
        # Log only method/path/status from SimpleHTTPRequestHandler. Request
        # bodies, headers, query strings, API keys, prompts, and responses are
        # never logged.
        safe_path = self.path.split("?", 1)[0]
        print(f"{self.command} {safe_path} {args[1] if len(args) > 1 else ''}")

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/":
            self.path = "/index.html"
        elif path == "/api/local-models":
            try:
                self._json_response(HTTPStatus.OK, {"available": True, "models": local_models()})
            except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
                self._json_response(HTTPStatus.OK, {"available": False, "models": []})
            return
        elif path not in {"/index.html", "/style.css", "/app.js"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path not in {"/api/ai", "/api/gemini", "/api/jobs/scan", "/api/jobs/detail"}:
            self._json_response(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://{HOST}:{PORT}", f"http://localhost:{PORT}"}:
            self._json_response(HTTPStatus.FORBIDDEN, {"error": "Cross-origin requests are not allowed"})
            return

        content_length = self.headers.get("Content-Length")
        if not content_length or not content_length.isdigit():
            self._json_response(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length is required"})
            return

        size = int(content_length)
        if size > MAX_REQUEST_BYTES:
            self._json_response(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Request is too large"})
            return

        try:
            body = json.loads(self.rfile.read(size))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON request"})
            return

        if not isinstance(body, dict):
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Invalid request"})
            return
        if self.path in {"/api/jobs/scan", "/api/jobs/detail"}:
            if size > 8_192:
                self._json_response(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Job search request is too large"})
                return
            try:
                result = (scan_jobs(body) if self.path.endswith("/scan") else
                          get_job_bank_detail(body.get("id"), body.get("language")))
                self._json_response(HTTPStatus.OK, result)
            except ValueError as error:
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            except Exception:
                self._json_response(HTTPStatus.BAD_GATEWAY, {"error": "Job source is unavailable right now. Try again shortly."})
            return
        provider = body.get("provider", "gemini" if self.path == "/api/gemini" else None)
        api_key = body.get("apiKey")
        model = body.get("model")
        prompt = body.get("prompt")
        schema = body.get("schema")
        file_data = body.get("file")

        if provider not in {"gemini", "local"}:
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Choose an AI provider"})
            return
        if not isinstance(model, str) or len(model) > 200:
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Unsupported model name"})
            return
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 100_000:
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "A prompt is required"})
            return
        if schema is not None and (not isinstance(schema, dict) or len(json.dumps(schema)) > 30_000):
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Invalid output schema"})
            return
        if file_data is not None and not isinstance(file_data, dict):
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Invalid file payload"})
            return

        if provider == "local":
            self._local_request(model, prompt, schema, file_data)
            return
        if not isinstance(api_key, str) or len(api_key.strip()) < 10:
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "A valid Gemini API key is required"})
            return
        if not MODEL_PATTERN.fullmatch(model):
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Unsupported model name"})
            return

        parts: list[dict] = [{"text": prompt}]
        if file_data is not None:
            mime_type = file_data.get("mimeType")
            encoded_data = file_data.get("data")
            if not isinstance(mime_type, str) or not isinstance(encoded_data, str):
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Invalid file payload"})
                return
            parts.append({"inlineData": {"mimeType": mime_type, "data": encoded_data}})

        generation_config: dict = {"temperature": 0.2}
        if isinstance(schema, dict):
            generation_config.update(
                {
                    "responseMimeType": "application/json",
                    "responseSchema": schema,
                }
            )

        provider_payload = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": generation_config,
        }
        provider_request = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=json.dumps(provider_payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": api_key.strip(),
            },
            method="POST",
        )

        try:
            for attempt in range(3):
                try:
                    provider_response = read_json_response(provider_request, timeout=120)
                    break
                except urllib.error.HTTPError as error:
                    if error.code != 503 or attempt == 2:
                        raise
                    error.close()
                    time.sleep(2 ** attempt + random.random() * 0.25)
            text_parts = [
                part.get("text", "")
                for candidate in provider_response.get("candidates", [])
                for part in candidate.get("content", {}).get("parts", [])
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            ]
            output_text = "".join(text_parts).strip()
            if not output_text:
                raise ValueError("The provider returned no text output")
            output = json.loads(output_text) if isinstance(schema, dict) else output_text
            if isinstance(schema, dict) and not matches_schema(output, schema):
                raise ValueError("The AI provider returned the wrong response shape")
            self._json_response(HTTPStatus.OK, {"output": output, "provider": "gemini", "model": model})
        except urllib.error.HTTPError as error:
            if error.code == 503:
                self._json_response(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Gemini is busy right now. Try again shortly, or choose another Gemini model in Connect AI. No result was created for this action."})
                return
            try:
                detail = json.loads(error.read()).get("error", {}).get("message", "Provider request failed")
            except (json.JSONDecodeError, UnicodeDecodeError):
                detail = "Provider request failed"
            self._json_response(error.code, {"error": detail[:500]})
        except (urllib.error.URLError, TimeoutError):
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": "Could not reach the AI provider"})
        except (ValueError, json.JSONDecodeError):
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": "The AI provider returned an invalid response"})

    def _local_request(self, model: str, prompt: str, schema: dict | None, file_data: dict | None) -> None:
        try:
            if model not in local_models():
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Choose an available local generation model"})
                return
            if file_data is not None:
                try:
                    prompt += "\n\nUNTRUSTED DOCUMENT TEXT:\n" + extract_local_text(file_data)
                except (ValueError, UnicodeDecodeError, KeyError, zipfile.BadZipFile, ET.ParseError) as error:
                    self._json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)[:250]})
                    return
            payload: dict = {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
                "max_tokens": 8192,
                "stream": False,
            }
            if schema is not None:
                payload["response_format"] = {"type": "json_schema", "json_schema": {"name": "jobist_response", "schema": schema}}
            request = urllib.request.Request(
                f"{LOCAL_BASE}/v1/chat/completions",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            result = read_json_response(request, timeout=240)
            content = result["choices"][0]["message"]["content"]
            if not isinstance(content, str) or not content.strip():
                raise ValueError("Empty local AI response")
            output = json.loads(content) if schema is not None else content
            if schema is not None and not matches_schema(output, schema):
                raise ValueError("The local AI returned the wrong response shape")
            self._json_response(HTTPStatus.OK, {"output": output, "provider": "local", "model": model})
        except (ValueError, UnicodeDecodeError, KeyError, IndexError):
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": "Local AI returned an invalid response"})
        except urllib.error.HTTPError:
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": "Local AI could not process this request"})
        except (urllib.error.URLError, TimeoutError):
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": "LM Studio is unavailable. Start its local server and try again"})

    def _json_response(self, status: int, payload: dict) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


if __name__ == "__main__":
    print(f"Jobist is running at http://{HOST}:{PORT}")
    print("AI keys and request content are not logged or stored by this server.")
    ThreadingHTTPServer((HOST, PORT), JobistHandler).serve_forever()
