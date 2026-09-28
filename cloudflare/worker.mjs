// Hosted Jobist: same-origin static assets and an ephemeral Gemini adapter.
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MODEL_PATTERN = /^gemini-[a-z0-9.-]+$/;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function readLimitedText(body, limit) {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("too large");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function matchesSchema(value, schema, depth = 0) {
  if (depth > 20 || !schema || typeof schema !== "object") return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const properties = schema.properties || {};
    if ((schema.required || []).some(key => !(key in value))) return false;
    return Object.entries(value).every(([key, item]) => !(key in properties) || matchesSchema(item, properties[key], depth + 1));
  }
  if (schema.type === "array") return Array.isArray(value) && value.every(item => matchesSchema(item, schema.items || {}, depth + 1));
  if (schema.type === "string") return typeof value === "string" && (!schema.enum || schema.enum.includes(value));
  if (schema.type === "integer") return Number.isInteger(value);
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "boolean") return typeof value === "boolean";
  return true;
}

async function handleAi(request) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return jsonResponse(403, { error: "Cross-origin requests are not allowed" });
  const contentLength = Number(request.headers.get("Content-Length"));
  if (contentLength > MAX_REQUEST_BYTES) return jsonResponse(413, { error: "Request is too large" });

  let body;
  try {
    body = JSON.parse(await readLimitedText(request.body, MAX_REQUEST_BYTES));
  } catch {
    return jsonResponse(400, { error: "Invalid or oversized JSON request" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse(400, { error: "Invalid request" });
  const provider = body.provider || (new URL(request.url).pathname === "/api/gemini" ? "gemini" : null);
  if (provider === "local") return jsonResponse(400, { error: "Local AI is available when Jobist runs on the same computer as LM Studio" });
  if (provider !== "gemini") return jsonResponse(400, { error: "Choose an AI provider" });
  const { apiKey, model, prompt, schema, file } = body;
  if (typeof apiKey !== "string" || apiKey.trim().length < 10) return jsonResponse(400, { error: "A valid Gemini API key is required" });
  if (typeof model !== "string" || model.length > 200 || !MODEL_PATTERN.test(model)) return jsonResponse(400, { error: "Unsupported model name" });
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 100_000) return jsonResponse(400, { error: "A prompt is required" });
  if (schema != null && (typeof schema !== "object" || Array.isArray(schema) || JSON.stringify(schema).length > 30_000)) return jsonResponse(400, { error: "Invalid output schema" });
  if (file != null && (typeof file !== "object" || Array.isArray(file) || typeof file.mimeType !== "string" || typeof file.data !== "string")) return jsonResponse(400, { error: "Invalid file payload" });

  const parts = [{ text: prompt }];
  if (file) parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
  const generationConfig = { temperature: 0.2 };
  if (schema) Object.assign(generationConfig, { responseMimeType: "application/json", responseSchema: schema });

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey.trim() },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await readLimitedText(response.body, MAX_OUTPUT_BYTES);
    let result;
    try { result = JSON.parse(raw); } catch { return jsonResponse(502, { error: "The AI provider returned an invalid response" }); }
    if (!response.ok) {
      const detail = result?.error?.message;
      return jsonResponse(response.status, { error: typeof detail === "string" ? detail.slice(0, 500) : "Provider request failed" });
    }
    const outputText = (result.candidates || []).flatMap(candidate => candidate.content?.parts || []).map(part => part.text || "").join("").trim();
    if (!outputText) return jsonResponse(502, { error: "The AI provider returned no text output" });
    let output;
    try { output = schema ? JSON.parse(outputText) : outputText; } catch { return jsonResponse(502, { error: "The AI provider returned invalid JSON" }); }
    if (schema && !matchesSchema(output, schema)) return jsonResponse(502, { error: "The AI provider returned the wrong response shape" });
    return jsonResponse(200, { output, provider: "gemini", model });
  } catch {
    return jsonResponse(502, { error: "Could not reach the AI provider" });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/local-models" && request.method === "GET") return jsonResponse(200, { available: false, models: [] });
    if (["/api/ai", "/api/gemini"].includes(url.pathname)) {
      if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });
      return handleAi(request);
    }
    if (url.pathname.startsWith("/api/")) return jsonResponse(404, { error: "Not found" });
    if (!["GET", "HEAD"].includes(request.method)) return jsonResponse(405, { error: "Method not allowed" });
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
    return new Response(asset.body, { status: asset.status, headers });
  },
};
