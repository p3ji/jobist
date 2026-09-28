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
