"""Small, dependency-free Jobist server and ephemeral Gemini proxy.

The API key and request body are held only for the duration of one request. This
server deliberately does not log headers, request bodies, prompts, or responses.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


HOST = "127.0.0.1"
PORT = 8080
MAX_REQUEST_BYTES = 16 * 1024 * 1024
ROOT = Path(__file__).resolve().parent
MODEL_PATTERN = re.compile(r"^gemini-[a-z0-9.-]+$")


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
        elif path not in {"/index.html", "/style.css", "/app.js"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path != "/api/gemini":
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

        api_key = body.get("apiKey")
        model = body.get("model", "gemini-3.8-flash")
        prompt = body.get("prompt")
        schema = body.get("schema")
        file_data = body.get("file")

        if not isinstance(api_key, str) or len(api_key.strip()) < 10:
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "A valid Gemini API key is required"})
            return
        if not isinstance(model, str) or not MODEL_PATTERN.fullmatch(model):
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Unsupported model name"})
            return
        if not isinstance(prompt, str) or not prompt.strip():
            self._json_response(HTTPStatus.BAD_REQUEST, {"error": "A prompt is required"})
            return

        parts: list[dict] = [{"text": prompt}]
        if file_data is not None:
            if not isinstance(file_data, dict):
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": "Invalid file payload"})
                return
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
            with urllib.request.urlopen(provider_request, timeout=120) as response:
                provider_response = json.loads(response.read())
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
            self._json_response(HTTPStatus.OK, {"output": output, "model": model})
        except urllib.error.HTTPError as error:
            try:
                detail = json.loads(error.read()).get("error", {}).get("message", "Provider request failed")
            except (json.JSONDecodeError, UnicodeDecodeError):
                detail = "Provider request failed"
            self._json_response(error.code, {"error": detail[:500]})
        except urllib.error.URLError:
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": "Could not reach the AI provider"})
        except (ValueError, json.JSONDecodeError):
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": "The AI provider returned an invalid response"})

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
