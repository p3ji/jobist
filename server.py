"""Small Jobist server with ephemeral Gemini and local LM Studio adapters.

The API key and request body are held only for the duration of one request. This
server deliberately does not log headers, request bodies, prompts, or responses.
"""

from __future__ import annotations

import base64
import io
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import zlib
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from job_search import get_job_bank_detail, get_job_detail, scan_jobs


HOST = "127.0.0.1"
PORT = 8080
MAX_REQUEST_BYTES = 16 * 1024 * 1024
ROOT = Path(__file__).resolve().parent
MODEL_PATTERN = re.compile(r"^gemini-[a-z0-9.-]+$")
LOCAL_BASE = "http://127.0.0.1:1234"
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_EXTRACTED_CHARS = 80_000


def get_env_key(name: str) -> str:
    val = os.environ.get(name, "")
    if val:
        return val.strip()
    env_file = ROOT / ".env"
    if env_file.is_file():
        try:
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip().strip('"\'')
        except Exception:
            pass
    return ""


def extract_mac_text(raw_bytes: bytes, suffix: str = ".pdf") -> str:
    if sys.platform != "darwin":
        return ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
            tf.write(raw_bytes)
            tf.flush()
            tmp_path = tf.name
        try:
            proc = subprocess.run(["mdimport", "-d3", "-t", tmp_path], capture_output=True, text=True, timeout=5)
            out = proc.stdout + proc.stderr
            match = re.search(r'kMDItemTextContent\s*=\s*"(.*?)"(?:\s*;|\s*\})', out, re.DOTALL)
            if match:
                raw_extracted = match.group(1)
                try:
                    return raw_extracted.encode("utf-8").decode("unicode_escape").strip()
                except Exception:
                    return raw_extracted.strip()
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
    except Exception:
        pass
    return ""


def _decode_pdf_token(token: bytes) -> str:
    token = token.strip()
    if token.startswith(b"<") and token.endswith(b">"):
        hex_data = re.sub(rb"\s+", b"", token[1:-1])
        try:
            raw_bytes = bytes.fromhex(hex_data.decode("ascii"))
            for enc in ("utf-16-be", "utf-8", "latin-1"):
                try:
                    res = raw_bytes.decode(enc)
                    if res and not any(ord(c) < 32 and c not in "\n\r\t" for c in res):
                        return res
                except Exception:
                    continue
            return raw_bytes.decode("latin-1", errors="ignore")
        except Exception:
            return ""
    if token.startswith(b"(") and token.endswith(b")"):
        clean = re.sub(rb"\\(.)", rb"\1", token[1:-1])
        for enc in ("utf-8", "latin-1"):
            try:
                return clean.decode(enc)
            except Exception:
                continue
        return clean.decode("utf-8", errors="ignore")
    return ""


def extract_pdf_text(raw_bytes: bytes) -> str:
    # 1. Try pypdf if available
    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(raw_bytes))
        pages = [page.extract_text() or "" for page in reader.pages]
        text = "\n".join(pages).strip()
        if text:
            return text
    except Exception:
        pass

    # 2. Try macOS native Spotlight extraction if on darwin
    mac_text = extract_mac_text(raw_bytes, suffix=".pdf")
    if mac_text:
        return mac_text

    # 3. Pure Python stream parser
    stream_re = re.compile(b"stream[\r\n]+(.*?)[\r\n]+endstream", re.DOTALL)
    text_chunks = []
    for match in stream_re.finditer(raw_bytes):
        raw = match.group(1)
        decompressed = None
        for wbits in (0, -zlib.MAX_WBITS):
            try:
                decompressed = zlib.decompress(raw, wbits)
                break
            except Exception:
                continue
        if decompressed is None:
            decompressed = raw
        bt_et_blocks = re.findall(rb"BT(.*?)ET", decompressed, re.DOTALL)
        for block in bt_et_blocks:
            tj_matches = re.findall(rb"(\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>)\s*Tj", block)
            for token in tj_matches:
                s = _decode_pdf_token(token)
                if s.strip():
                    text_chunks.append(s)
            tj_arrays = re.findall(rb"\[(.*?)\]\s*TJ", block, re.DOTALL)
            for arr in tj_arrays:
                arr_tokens = re.findall(rb"(\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>)", arr)
                joined = "".join(_decode_pdf_token(tok) for tok in arr_tokens)
                if joined.strip():
                    text_chunks.append(joined)
    return "\n".join(text_chunks).strip()


def read_json_response(request: urllib.request.Request, timeout: int = 10) -> dict:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(MAX_OUTPUT_BYTES + 1)
    if len(raw) > MAX_OUTPUT_BYTES:
        raise ValueError("The AI service response was too large")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("The AI service returned an invalid response")
    return result


def get_local_models_info() -> list[dict]:
    # 1. Try LM Studio specific endpoint /api/v1/models
    try:
        req = urllib.request.Request(f"{LOCAL_BASE}/api/v1/models")
        result = read_json_response(req, timeout=5)
        raw_models = result.get("models", [])
        models_info = []
        for m in raw_models:
            if isinstance(m, dict) and m.get("type") == "llm" and isinstance(m.get("key"), str):
                loaded_instances = m.get("loaded_instances", [])
                loaded = len(loaded_instances) > 0 if isinstance(loaded_instances, list) else False
                models_info.append({
                    "id": m["key"],
                    "name": m.get("name") or m["key"],
                    "loaded": loaded,
                })
        if models_info:
            models_info.sort(key=lambda x: (not x["loaded"], x["name"].lower()))
            return models_info
    except Exception:
        pass

    # 2. Fallback to standard OpenAI-compatible /v1/models (works with LM Studio, Ollama, etc.)
    try:
        req = urllib.request.Request(f"{LOCAL_BASE}/v1/models")
        result = read_json_response(req, timeout=5)
        data = result.get("data", [])
        models_info = []
        for m in data:
            if isinstance(m, dict) and isinstance(m.get("id"), str):
                mid = m["id"]
                if "embed" in mid.lower():
                    continue
                models_info.append({
                    "id": mid,
                    "name": mid,
                    "loaded": False,
                })
        if models_info:
            models_info.sort(key=lambda x: x["name"].lower())
            return models_info
    except Exception:
        pass

    return []


def local_models() -> list[str]:
    return [m["id"] for m in get_local_models_info()]


def extract_json_object(raw_text: str) -> object:
    text = raw_text.strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1:
            text = text[first_newline + 1:]
        if text.endswith("```"):
            text = text[:-3].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    start_obj = text.find("{")
    start_arr = text.find("[")
    if start_obj != -1 and (start_arr == -1 or start_obj < start_arr):
        start = start_obj
        end = text.rfind("}")
    elif start_arr != -1:
        start = start_arr
        end = text.rfind("]")
    else:
        start = -1
        end = -1

    if start != -1 and end != -1 and end > start:
        candidate = text[start:end + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    try:
        return json.loads(text, strict=False)
    except Exception:
        pass
    raise ValueError("The AI did not return valid JSON")


def format_experience_items(item: object) -> list[str]:
    if isinstance(item, str):
        return [item.strip()] if item.strip() else []
    if not isinstance(item, dict):
        s = str(item).strip()
        return [s] if s else []

    role = item.get("role") or item.get("title") or item.get("position") or ""
    company = item.get("company") or item.get("employer") or item.get("organization") or ""
    start = item.get("start_date") or item.get("startDate") or item.get("start") or ""
    end = item.get("end_date") or item.get("endDate") or item.get("end") or ""
    dates = f"{start} - {end}".strip(" -") if (start or end) else (item.get("dates") or item.get("date") or "")

    if role and company:
        header = f"{role}, {company}"
    elif role or company:
        header = str(role or company)
    else:
        header = ""
    if header and dates:
        header = f"{header} ({dates})"
    elif dates and not header:
        header = str(dates)

    bullets = []
    for k in ("achievements", "responsibilities", "highlights", "details", "bullets", "description"):
        val = item.get(k)
        if not val:
            continue
        if isinstance(val, list):
            for b in val:
                b_str = str(b).strip().lstrip("•-* ").strip()
                if b_str and b_str not in bullets:
                    bullets.append(b_str)
        elif isinstance(val, str):
            for line in val.split("\n"):
                b_str = line.strip().lstrip("•-* ").strip()
                if b_str and b_str not in bullets:
                    bullets.append(b_str)

    if not bullets:
        return [header] if header else []

    results = []
    for bullet in bullets:
        if header and not bullet.startswith(header):
            results.append(f"{header} — {bullet}")
        else:
            results.append(bullet)
    return results


def format_experience_item(item: object) -> str:
    items = format_experience_items(item)
    return "\n".join(items)


def format_education_item(item: object) -> str:
    if isinstance(item, str):
        return item.strip()
    if not isinstance(item, dict):
        return str(item).strip()
    degree = item.get("degree") or item.get("credential") or item.get("major") or item.get("title") or ""
    school = item.get("institution") or item.get("school") or item.get("university") or item.get("organization") or ""
    dates = item.get("dates") or item.get("date") or item.get("year") or ""
    header = f"{degree}, {school}".strip(", ") if (degree or school) else ""
    if header and dates:
        return f"{header} ({dates})"
    return str(header or dates or "")


def normalize_profile_data(data: dict) -> dict:
    normalized = dict(data)
    profile_keys = [
        "name", "headline", "email", "location", "languages",
        "authorization", "workPreference", "targetRoles", "goals",
        "experience", "skills", "education",
    ]
    for key in profile_keys:
        val = normalized.get(key)
        if val is None:
            normalized[key] = ""
            continue
        if isinstance(val, str) and (val.strip().startswith("[") or val.strip().startswith("{")):
            try:
                val = json.loads(val.strip())
            except Exception:
                pass
        if key == "experience":
            if isinstance(val, list):
                lines = []
                for x in val:
                    lines.extend(format_experience_items(x))
                normalized[key] = "\n".join(line for line in lines if line)
            else:
                normalized[key] = str(val).strip()
        elif key == "education":
            if isinstance(val, list):
                lines = [format_education_item(x) for x in val if format_education_item(x)]
                normalized[key] = "\n".join(lines)
            else:
                normalized[key] = str(val).strip()
        elif key == "skills":
            if isinstance(val, list):
                normalized[key] = ", ".join(str(x).strip() for x in val if str(x).strip())
            else:
                normalized[key] = str(val).strip()
        else:
            if isinstance(val, list):
                normalized[key] = ", ".join(str(x).strip() for x in val if str(x).strip())
            else:
                normalized[key] = str(val).strip()
    return normalized


def normalize_output_for_schema(value: object, schema: dict) -> object:
    if not isinstance(schema, dict):
        return value
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return value
        properties = schema.get("properties", {})
        if "experience" in properties and "education" in properties and "skills" in properties:
            value = normalize_profile_data(value)
        normalized_obj = dict(value)
        for prop_name, prop_schema in properties.items():
            if prop_name in normalized_obj:
                normalized_obj[prop_name] = normalize_output_for_schema(normalized_obj[prop_name], prop_schema)
            elif prop_name in schema.get("required", []):
                prop_type = prop_schema.get("type")
                if prop_type == "string":
                    normalized_obj[prop_name] = ""
                elif prop_type == "array":
                    normalized_obj[prop_name] = []
                elif prop_type in ("integer", "number"):
                    normalized_obj[prop_name] = 0
                elif prop_type == "boolean":
                    normalized_obj[prop_name] = False
                elif prop_type == "object":
                    normalized_obj[prop_name] = {}
        return normalized_obj
    if kind == "array":
        if not isinstance(value, list):
            if isinstance(value, (str, dict)):
                value = [value]
            else:
                return []
        item_schema = schema.get("items", {})
        return [normalize_output_for_schema(item, item_schema) for item in value]
    if kind == "string":
        if value is None:
            return ""
        if isinstance(value, list):
            return "\n".join(str(x) for x in value)
        return str(value)
    if kind == "integer":
        try:
            return int(round(float(value)))
        except (ValueError, TypeError):
            return 0
    if kind == "number":
        try:
            return float(value)
        except (ValueError, TypeError):
            return 0.0
    if kind == "boolean":
        if isinstance(value, str):
            return value.lower() in ("true", "1", "yes")
        return bool(value)
    return value


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
    filename = str(file_data.get("name") or "").lower()
    if not isinstance(encoded, str) or not isinstance(mime_type, str):
        raise ValueError("Invalid file payload")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("Invalid file payload") from error
    if len(raw) > 10 * 1024 * 1024:
        raise ValueError("Choose a file smaller than 10 MB")

    ext = filename.rsplit(".", 1)[-1] if "." in filename else ""

    if mime_type in {"text/plain", "text/markdown", "text/csv"} or ext in {"txt", "md", "csv", "tex"}:
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("latin-1", errors="ignore")
    elif mime_type == "application/pdf" or ext == "pdf":
        text = extract_pdf_text(raw)
        if not text:
            raise ValueError("This PDF has no readable text layer. Enter facts manually or use Gemini")
    elif mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" or ext == "docx":
        text = ""
        try:
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
        except Exception:
            text = extract_mac_text(raw, suffix=".docx")
        if not text:
            raise ValueError("Could not read text from this Word document")
    elif mime_type == "application/msword" or ext == "doc":
        text = extract_mac_text(raw, suffix=".doc")
        if not text:
            raise ValueError("Legacy .doc files require conversion or macOS Spotlight. Save as .docx or .txt, or use Gemini")
    elif mime_type == "application/rtf" or ext == "rtf":
        text = extract_mac_text(raw, suffix=".rtf")
        if not text:
            raise ValueError("Could not read text from this RTF document")
    else:
        text = extract_mac_text(raw, suffix=f".{ext}" if ext else ".txt")
        if not text:
            raise ValueError("Local AI currently reads PDF, Word (.docx, .doc), .txt, .md, .tex, and .csv files. Enter facts manually, or choose Gemini")

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
        elif path == "/api/ai/config":
            self._json_response(HTTPStatus.OK, {
                "defaultGeminiAvailable": bool(get_env_key("GEMINI_API_KEY")),
                "defaultCohereAvailable": bool(get_env_key("COHERE_API_KEY")),
                "defaultModel": "gemini-2.5-flash",
            })
            return
        elif path == "/api/local-models":
            try:
                info = get_local_models_info()
                if info:
                    self._json_response(HTTPStatus.OK, {
                        "available": True,
                        "models": [m["id"] for m in info],
                        "details": info,
                    })
                else:
                    self._json_response(HTTPStatus.OK, {"available": True, "models": [], "details": []})
            except Exception:
                self._json_response(HTTPStatus.OK, {"available": False, "models": [], "details": []})
            return
        elif path not in {"/index.html", "/style.css", "/app.js"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path not in {"/api/ai", "/api/gemini", "/api/jobs/scan", "/api/jobs/detail", "/api/jobs/rerank"}:
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
        if self.path == "/api/jobs/rerank":
            cohere_key = get_env_key("COHERE_API_KEY")
            if not cohere_key:
                self._json_response(HTTPStatus.OK, {"available": False, "results": []})
                return
            query = body.get("query")
            documents = body.get("documents")
            if not isinstance(query, str) or not query.strip() or not isinstance(documents, list) or not documents:
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": "A query and documents are required"})
                return
            try:
                cohere_payload = {
                    "model": "rerank-v3.5",
                    "query": query[:2000],
                    "documents": [str(d)[:2000] for d in documents[:50]],
                    "top_n": min(len(documents), 25),
                }
                req = urllib.request.Request(
                    "https://api.cohere.com/v2/rerank",
                    data=json.dumps(cohere_payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {cohere_key}",
                    },
                    method="POST",
                )
                res = read_json_response(req, timeout=10)
                self._json_response(HTTPStatus.OK, {"available": True, "results": res.get("results", [])})
            except Exception:
                self._json_response(HTTPStatus.OK, {"available": False, "error": "Cohere rerank unavailable"})
            return
        if self.path in {"/api/jobs/scan", "/api/jobs/detail"}:
            if size > 8_192:
                self._json_response(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Job search request is too large"})
                return
            try:
                result = (scan_jobs(body) if self.path.endswith("/scan") else
                          get_job_detail(body.get("id"), body.get("language") or "en", body.get("source") or ""))
                self._json_response(HTTPStatus.OK, result)
            except ValueError as error:
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            except Exception:
                self._json_response(HTTPStatus.BAD_GATEWAY, {"error": "Job source is unavailable right now. Try again shortly."})
            return
        provider = body.get("provider", "gemini" if self.path == "/api/gemini" else None)
        api_key = (body.get("apiKey") or get_env_key("GEMINI_API_KEY") or "").strip()
        model = (body.get("model") or "gemini-2.5-flash").strip()
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
            if isinstance(schema, dict):
                raw_json = extract_json_object(output_text)
                output = normalize_output_for_schema(raw_json, schema)
                if not matches_schema(output, schema):
                    raise ValueError("The AI provider returned the wrong response shape")
            else:
                output = output_text
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
            available = local_models()
            if available and model not in available:
                self._json_response(HTTPStatus.BAD_REQUEST, {"error": f"Model '{model}' is not currently available in LM Studio"})
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
            if schema is not None:
                raw_json = extract_json_object(content)
                output = normalize_output_for_schema(raw_json, schema)
                if not matches_schema(output, schema):
                    raise ValueError("The local AI returned the wrong response shape")
            else:
                output = content
            self._json_response(HTTPStatus.OK, {"output": output, "provider": "local", "model": model})
        except urllib.error.HTTPError as error:
            detail = "Local AI could not process this request"
            try:
                err_data = json.loads(error.read().decode("utf-8", errors="ignore"))
                detail = err_data.get("error", {}).get("message") or err_data.get("message") or detail
            except Exception:
                pass
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": detail[:500]})
        except (urllib.error.URLError, TimeoutError):
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": "LM Studio is unavailable. Start its local server on 127.0.0.1:1234 and try again"})
        except (ValueError, UnicodeDecodeError, KeyError, IndexError) as error:
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": f"Local AI error: {str(error)[:250]}"})
        except Exception as error:
            self._json_response(HTTPStatus.BAD_GATEWAY, {"error": f"Local AI error: {str(error)[:250]}"})

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
