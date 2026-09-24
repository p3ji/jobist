import assert from "node:assert/strict";

const targets = await fetch("http://127.0.0.1:9223/json/list").then(response => response.json());
const target = targets.find(item => item.type === "page" && item.url.startsWith("http://127.0.0.1:8080"));
assert(target, "Jobist browser target not found. Start Chrome with remote debugging on port 9223.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function command(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

await command("Page.enable");
await command("Runtime.enable");
await command("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
await evaluate("localStorage.clear(); location.href = 'http://127.0.0.1:8080/?qa=1'");
await wait(700);

const landing = await evaluate(`({
  title: document.title,
  innerWidth,
  scrollWidth: document.documentElement.scrollWidth,
  startLabel: document.querySelector('#startButton')?.textContent.trim(),
  buttonNames: [...document.querySelectorAll('button')].map(button => button.getAttribute('aria-label') || button.textContent.trim()).filter(Boolean)
})`);
assert.equal(landing.title, "Jobist — Job search, made clearer");
assert.equal(landing.innerWidth, 375);
assert.equal(landing.scrollWidth, 375, "Landing page has horizontal overflow at 375px");
assert.match(landing.startLabel, /Build my profile/);
assert(landing.buttonNames.every(Boolean), "Every button must have an accessible name");

await evaluate("document.querySelector('#loadExampleButton').click()");
await wait(200);
const fit = await evaluate(`({
  visible: !document.querySelector('#fitView').classList.contains('is-hidden'),
  score: Number(document.querySelector('#overallScore').textContent),
  gates: document.querySelectorAll('.gate').length,
  strengths: document.querySelectorAll('#strengthList li').length,
  gaps: document.querySelectorAll('#gapList li').length,
  scrollWidth: document.documentElement.scrollWidth
})`);
assert(fit.visible, "Example should open the fit report");
assert(fit.score > 0 && fit.score <= 100, "Fit score should be in range");
assert.equal(fit.gates, 3);
assert(fit.strengths > 0 && fit.gaps > 0);
assert.equal(fit.scrollWidth, 375, "Fit view has horizontal overflow at 375px");

await evaluate("document.querySelector('#generateButton').click()");
await wait(200);
const drafts = await evaluate(`({
  visible: !document.querySelector('#draftsView').classList.contains('is-hidden'),
  resumeText: document.querySelector('#resumeDocument').innerText,
  letterText: document.querySelector('#letterDocument').innerText,
  evidenceCount: document.querySelectorAll('#resumeDocument sup').length,
  stored: Boolean(JSON.parse(localStorage.getItem('jobist.prototype.v1')).drafts)
})`);
assert(drafts.visible, "Draft workspace should open");
assert.match(drafts.resumeText, /Maya Chen/);
assert.match(drafts.letterText, /Cedar Public Services/);
assert(drafts.evidenceCount > 0, "Résumé claims should carry evidence markers");
assert(drafts.stored, "Drafts should persist locally");

await evaluate("document.querySelector('#saveApplicationButton').click(); document.querySelector('[data-view=tracker]').click()");
await wait(200);
const tracker = await evaluate(`({
  cards: document.querySelectorAll('.tracker-card').length,
  saved: JSON.parse(localStorage.getItem('jobist.prototype.v1')).applications.length
})`);
assert.equal(tracker.cards, 1);
assert.equal(tracker.saved, 1);

console.log(JSON.stringify({ landing, fit, drafts: { ...drafts, resumeText: "ok", letterText: "ok" }, tracker }, null, 2));
socket.close();
