// Hosted Jobist: same-origin static assets and an ephemeral Gemini adapter.
import { getJobBankDetail, getJobDetail, scanJobs } from "./job-search.mjs";
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

async function resolveSecret(env, ...keys) {
  for (const key of keys) {
    const item = env?.[key];
    if (!item) continue;
    if (typeof item === "string" && item.trim()) return item.trim();
    if (typeof item?.get === "function") {
      try {
        const val = await item.get();
        if (typeof val === "string" && val.trim()) return val.trim();
      } catch {}
    }
  }
  return "";
}

async function handleAi(request, env) {
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
  const clientKey = (typeof body.apiKey === "string" && body.apiKey.trim().length >= 10) ? body.apiKey.trim() : "";
  const apiKey = clientKey || await resolveSecret(env, "GEMINI_API_KEY", "GOOGLE_API_KEY");
  const model = (typeof body.model === "string" && body.model.trim()) ? body.model.trim() : "gemini-2.5-flash";
  const { prompt, schema, file } = body;
  if (!apiKey || apiKey.length < 10) return jsonResponse(400, { error: "A valid Gemini API key is required" });
  if (typeof model !== "string" || model.length > 200 || !MODEL_PATTERN.test(model)) return jsonResponse(400, { error: "Unsupported model name" });
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 100_000) return jsonResponse(400, { error: "A prompt is required" });
  if (schema != null && (typeof schema !== "object" || Array.isArray(schema) || JSON.stringify(schema).length > 30_000)) return jsonResponse(400, { error: "Invalid output schema" });
  if (file != null && (typeof file !== "object" || Array.isArray(file) || typeof file.mimeType !== "string" || typeof file.data !== "string")) return jsonResponse(400, { error: "Invalid file payload" });

  const parts = [{ text: prompt }];
  if (file) parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
  const generationConfig = { temperature: 0.2 };
  if (schema) Object.assign(generationConfig, { responseMimeType: "application/json", responseSchema: schema });

  try {
    const signal = AbortSignal.timeout(120_000);
    const requestBody = JSON.stringify({ contents: [{ role: "user", parts }], generationConfig });
    let response;
    let raw;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey.trim() },
        body: requestBody,
        signal,
      });
      raw = await readLimitedText(response.body, MAX_OUTPUT_BYTES);
      if (response.status !== 503 || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt + Math.random() * 250));
    }
    if (response.status === 503) return jsonResponse(503, { error: "Gemini is busy right now. Try again shortly, or choose another Gemini model in Connect AI. No result was created for this action." });
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

async function handleJobSearch(request, detail = false) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return jsonResponse(403, { error: "Cross-origin requests are not allowed" });
  let body;
  try { body = JSON.parse(await readLimitedText(request.body, 8_192)); }
  catch { return jsonResponse(400, { error: "Invalid job search request" }); }
  try {
    const result = detail ? await getJobDetail(body?.id, body?.language, body?.source) : await scanJobs(body);
    return jsonResponse(200, result);
  } catch (error) {
    return jsonResponse(error instanceof RangeError ? 400 : 502, { error: error.message || "Job search failed" });
  }
}

async function handleJobRerank(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return jsonResponse(403, { error: "Cross-origin requests are not allowed" });
  const apiKey = await resolveSecret(env, "COHERE_API_KEY");
  if (!apiKey) return jsonResponse(200, { available: false, results: [] });

  let body;
  try { body = JSON.parse(await readLimitedText(request.body, 65_536)); }
  catch { return jsonResponse(400, { error: "Invalid rerank request" }); }

  const query = typeof body?.query === "string" ? body.query.trim() : "";
  const documents = Array.isArray(body?.documents) ? body.documents.filter(d => typeof d === "string" && d.trim()) : [];
  if (!query || !documents.length) return jsonResponse(400, { error: "A query and documents are required" });

  try {
    const signal = AbortSignal.timeout(10_000);
    const cohereResponse = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "rerank-v3.5",
        query: query.slice(0, 2000),
        documents: documents.slice(0, 50).map(d => d.slice(0, 2000)),
        top_n: Math.min(documents.length, 25),
      }),
      signal,
    });
    if (!cohereResponse.ok) {
      return jsonResponse(200, { available: false, error: "Cohere rerank failed" });
    }
    const data = await cohereResponse.json();
    return jsonResponse(200, { available: true, results: data?.results || [] });
  } catch {
    return jsonResponse(200, { available: false, error: "Cohere unreachable" });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/local-models" && request.method === "GET") return jsonResponse(200, { available: false, models: [] });
    if (url.pathname === "/api/ai/config" && request.method === "GET") {
      const defaultGemini = await resolveSecret(env, "GEMINI_API_KEY", "GOOGLE_API_KEY");
      const defaultCohere = await resolveSecret(env, "COHERE_API_KEY");
      return jsonResponse(200, {
        defaultGeminiAvailable: Boolean(defaultGemini && defaultGemini.length >= 10),
        defaultCohereAvailable: Boolean(defaultCohere && defaultCohere.length >= 10),
        defaultModel: "gemini-2.5-flash",
        envKeys: Object.keys(env || {}).filter(k => k !== "ASSETS"),
      });
    }
    if (["/api/jobs/scan", "/api/jobs/detail"].includes(url.pathname)) {
      if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });
      return handleJobSearch(request, url.pathname.endsWith("/detail"));
    }
    if (url.pathname === "/api/jobs/rerank") {
      if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });
      return handleJobRerank(request, env);
    }
    if (["/api/ai", "/api/gemini"].includes(url.pathname)) {
      if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });
      return handleAi(request, env);
    }
    if (url.pathname.startsWith("/api/")) return jsonResponse(404, { error: "Not found" });
    if (!["GET", "HEAD"].includes(request.method)) return jsonResponse(405, { error: "Method not allowed" });
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
    return new Response(asset.body, { status: asset.status, headers });
  },
};
