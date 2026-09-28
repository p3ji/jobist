import assert from "node:assert/strict";
import test from "node:test";
import worker from "../cloudflare/worker.mjs";

const site = "https://jobist.peji.ca";
const env = { ASSETS: { fetch: async () => new Response("<!doctype html><title>Jobist</title>", { headers: { "Content-Type": "text/html" } }) } };
const post = (body, origin = site) => new Request(`${site}/api/ai`, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
});

test("serves the app with security headers", async () => {
  const response = await worker.fetch(new Request(site), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Jobist/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("hosted local option fails without forwarding data", async () => {
  const response = await worker.fetch(post({ provider: "local", model: "anything", prompt: "private career facts" }), env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /same computer/);
});

test("cross-origin request is rejected", async () => {
  const response = await worker.fetch(post({ provider: "gemini" }, "https://other.example"), env);
  assert.equal(response.status, 403);
});

test("job scan rejects cross-origin requests and invalid regions", async () => {
  const makeRequest = (body, origin = site) => new Request(`${site}/api/jobs/scan`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
  });
  assert.equal((await worker.fetch(makeRequest({ query: "coordinator" }, "https://other.example"), env)).status, 403);
  const response = await worker.fetch(makeRequest({ query: "coordinator", province: "ZZ" }), env);
  assert.equal(response.status, 400);
});

test("Gemini proxy validates the returned schema", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"result":"ok"}' }] } }] });
  };
  try {
    const response = await worker.fetch(post({ provider: "gemini", apiKey: "synthetic-key", model: "gemini-3.8-flash", prompt: "Hello", schema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] } }), env);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).output, { result: "ok" });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/generativelanguage\.googleapis\.com\//);
    assert.equal(calls[0].options.headers["x-goog-api-key"], "synthetic-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini proxy forwards a PDF as inline document data", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"name":"Taylor"}' }] } }] });
  };
  try {
    const response = await worker.fetch(post({
      provider: "gemini", apiKey: "synthetic-key", model: "gemini-3.8-flash",
      prompt: "Extract confirmed facts", schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      file: { mimeType: "application/pdf", data: "JVBERi0xLjQ=" },
    }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamBody.contents[0].parts[1], { inlineData: { mimeType: "application/pdf", data: "JVBERi0xLjQ=" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini proxy retries a temporary model overload", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? Response.json({ error: { message: "high demand" } }, { status: 503 })
      : Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
  };
  try {
    const response = await worker.fetch(post({ provider: "gemini", apiKey: "synthetic-key", model: "gemini-3.8-flash", prompt: "Hello" }), env);
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini overload message applies to any AI action", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: { message: "high demand" } }, { status: 503 });
  };
  try {
    const response = await worker.fetch(post({ provider: "gemini", apiKey: "synthetic-key", model: "gemini-3.8-flash", prompt: "Suggest roles from confirmed experience" }), env);
    assert.equal(response.status, 503);
    assert.equal(calls, 3);
    const { error } = await response.json();
    assert.match(error, /Gemini is busy/);
    assert.match(error, /No result was created/);
    assert.doesNotMatch(error, /document|extracted/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini proxy uses worker secret when client provides no API key", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
  };
  try {
    const envWithSecret = { ...env, GEMINI_API_KEY: "worker-secret-gemini-key" };
    const response = await worker.fetch(post({ provider: "gemini", prompt: "Hello" }), envWithSecret);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers["x-goog-api-key"], "worker-secret-gemini-key");
    assert.match(calls[0].url, /gemini-2\.5-flash/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/api/ai/config returns available default secrets and model", async () => {
  const envWithSecrets = { ...env, GEMINI_API_KEY: "secret-gemini-key", COHERE_API_KEY: "secret-cohere-key" };
  const response = await worker.fetch(new Request(`${site}/api/ai/config`), envWithSecrets);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.defaultGeminiAvailable, true);
  assert.equal(data.defaultCohereAvailable, true);
  assert.equal(data.defaultModel, "gemini-2.5-flash");

  const responseEmpty = await worker.fetch(new Request(`${site}/api/ai/config`), env);
  const dataEmpty = await responseEmpty.json();
  assert.equal(dataEmpty.defaultGeminiAvailable, false);
  assert.equal(dataEmpty.defaultCohereAvailable, false);

  // Test Secrets Store async binding object { get: async () => string }
  const envWithSecretsStore = {
    ...env,
    GEMINI_API_KEY: { get: async () => "secret-store-gemini-key" },
    COHERE_API_KEY: { get: async () => "secret-store-cohere-key" },
  };
  const responseStore = await worker.fetch(new Request(`${site}/api/ai/config`), envWithSecretsStore);
  assert.equal(responseStore.status, 200);
  const dataStore = await responseStore.json();
  assert.equal(dataStore.defaultGeminiAvailable, true);
  assert.equal(dataStore.defaultCohereAvailable, true);
});

test("/api/jobs/rerank returns available false when no key is set", async () => {
  const request = new Request(`${site}/api/jobs/rerank`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: site },
    body: JSON.stringify({ query: "operations coordinator", documents: ["doc 1", "doc 2"] }),
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.available, false);
});

test("/api/jobs/rerank calls Cohere when COHERE_API_KEY is present", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ results: [{ index: 1, relevance_score: 0.95 }, { index: 0, relevance_score: 0.6 }] });
  };
  try {
    const envWithCohere = { ...env, COHERE_API_KEY: "test-cohere-key" };
    const request = new Request(`${site}/api/jobs/rerank`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: site },
      body: JSON.stringify({ query: "operations coordinator", documents: ["doc 1", "doc 2"] }),
    });
    const response = await worker.fetch(request, envWithCohere);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.available, true);
    assert.equal(data.results.length, 2);
    assert.equal(calls[0].options.headers["Authorization"], "Bearer test-cohere-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client bundle scripts parse cleanly without syntax errors", async () => {
  const fs = await import("node:fs");
  const appSrc = fs.readFileSync(new URL("../app.js", import.meta.url), "utf-8");
  const distAppSrc = fs.readFileSync(new URL("../dist/app.js", import.meta.url), "utf-8");
  assert.doesNotThrow(() => {
    new Function(appSrc);
  }, "app.js must parse cleanly");
  assert.doesNotThrow(() => {
    new Function(distAppSrc);
  }, "dist/app.js must parse cleanly");
});

