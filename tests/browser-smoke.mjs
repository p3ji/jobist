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

const keyHandling = await evaluate(`(() => {
  const testKey = 'test-key-must-never-be-persisted';
  document.querySelector('#providerButton').click();
  document.querySelector('#apiKeyInput').value = testKey;
  document.querySelector('#providerConsent').checked = true;
  document.querySelector('#providerForm').requestSubmit();
  return {
    connected: document.querySelector('#providerButton').classList.contains('is-connected'),
    persisted: Object.values(localStorage).some(value => value.includes(testKey)),
    inputCleared: document.querySelector('#apiKeyInput').value === ''
  };
})()`);
assert(keyHandling.connected, "Provider should connect for the active tab");
assert.equal(keyHandling.persisted, false, "API key must not be written to local storage");
assert(keyHandling.inputCleared, "API key field should be cleared after connection");

await evaluate(`(() => {
  window.__extractCalls = 0;
  window.fetch = async () => {
    window.__extractCalls += 1;
    return new Response(JSON.stringify({output:{
      name:'Maya Chen',headline:'Operations Coordinator',email:'maya.chen@example.com',location:'Toronto, ON',
      skills:'Project coordination\\nExcel',experience:'Operations Coordinator — Coordinated 30+ projects.',
      targetRoles:'Project Coordinator',languages:'English — fluent',authorization:'Citizen or permanent resident',
      workPreference:'Hybrid',goals:'Grow into project leadership.'
    },model:'gemini-3.8-flash'}), {status:200,headers:{'Content-Type':'application/json'}});
  };
  document.querySelector('#startButton').click();
  const transfer = new DataTransfer();
  transfer.items.add(new File(['resume evidence'], 'resume.txt', {type:'text/plain'}));
  document.querySelector('#resumeFile').files = transfer.files;
  document.querySelector('#extractProfileButton').click();
})()`);
await wait(250);
const extraction = await evaluate(`({
  calls: window.__extractCalls,
  name: document.querySelector('#profileForm [name=name]').value,
  skills: document.querySelector('#profileForm [name=skills]').value
})`);
assert.equal(extraction.calls, 1, "Document extraction should use one AI request");
assert.equal(extraction.name, "Maya Chen");
assert.match(extraction.skills, /Project coordination/);

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

await evaluate(`(() => {
  window.__aiCalls = 0;
  window.fetch = async (_url, options) => {
    window.__aiCalls += 1;
    const request = JSON.parse(options.body);
    const isEvaluation = Boolean(request.schema?.properties?.overall);
    const output = isEvaluation ? {
      overall: 82,
      recommendation: 'Strong fit — apply with a tailored application.',
      dimensions: [
        {name:'Technical skills',score:84,note:'Confirmed coordination and reporting evidence aligns.'},
        {name:'Experience',score:86,note:'Multiple confirmed examples map to the work.'},
        {name:'Work style',score:78,note:'Hybrid and cross-functional preferences align.'},
        {name:'Career direction',score:80,note:'The role advances the stated goal.'}
      ],
      gates: [
        {name:'Work eligibility',status:'PASS',note:'The confirmed profile meets the stated requirement.'},
        {name:'Language',status:'PASS',note:'English is confirmed.'},
        {name:'Location & logistics',status:'PASS',note:'Toronto hybrid aligns.'}
      ],
      strengths:['Project coordination is supported by confirmed work evidence.'],
      gaps:['Power BI is preferred but not supported by confirmed evidence.'],
      keywords:['project coordination','Excel','stakeholder meetings']
    } : {
      resumeSummary:{text:'Operations and project coordinator with evidence-backed delivery and reporting experience.',evidenceIds:[1,4]},
      resumeExperience:[{text:'Coordinated 30+ client projects and improved on-time delivery from 82% to 94%.',evidenceIds:[1]}],
      resumeSkills:[{text:'Project coordination',evidenceIds:[4]}],
      coverLetterParagraphs:[
        {text:'I am applying for the Project Coordinator role with directly relevant coordination evidence.',evidenceIds:[1,4]},
        {text:'My confirmed background includes project scheduling, reporting, and stakeholder support.',evidenceIds:[1,2]}
      ]
    };
    return new Response(JSON.stringify({output,model:'gemini-3.8-flash'}), {status:200,headers:{'Content-Type':'application/json'}});
  };
  document.querySelector('[data-view=job]').click();
  document.querySelector('#jobForm').requestSubmit();
})()`);
await wait(300);
const aiEvaluation = await evaluate(`({
  visible: !document.querySelector('#fitView').classList.contains('is-hidden'),
  score: Number(document.querySelector('#overallScore').textContent),
  calls: window.__aiCalls
})`);
assert(aiEvaluation.visible, "AI evaluation should open the fit report");
assert.equal(aiEvaluation.score, 82);
assert.equal(aiEvaluation.calls, 1, "Evaluation should use one AI request");

await evaluate("document.querySelector('#generateButton').click()");
await wait(350);
const drafts = await evaluate(`({
  visible: !document.querySelector('#draftsView').classList.contains('is-hidden'),
  resumeText: document.querySelector('#resumeDocument').innerText,
  letterText: document.querySelector('#letterDocument').innerText,
  evidenceCount: document.querySelectorAll('#resumeDocument sup').length,
  stored: Boolean(JSON.parse(localStorage.getItem('jobist.prototype.v1')).drafts),
  aiCalls: window.__aiCalls
})`);
assert(drafts.visible, "Draft workspace should open");
assert.match(drafts.resumeText, /Maya Chen/);
assert.match(drafts.letterText, /Cedar Public Services/);
assert(drafts.evidenceCount > 0, "Résumé claims should carry evidence markers");
assert(drafts.stored, "Drafts should persist locally");
assert.equal(drafts.aiCalls, 3, "Application generation should use separate drafter and reviewer requests");

await evaluate("document.querySelector('#saveApplicationButton').click(); document.querySelector('[data-view=tracker]').click()");
await wait(200);
const tracker = await evaluate(`({
  cards: document.querySelectorAll('.tracker-card').length,
  saved: JSON.parse(localStorage.getItem('jobist.prototype.v1')).applications.length
})`);
assert.equal(tracker.cards, 1);
assert.equal(tracker.saved, 1);

console.log(JSON.stringify({ landing, keyHandling, extraction, fit, aiEvaluation, drafts: { ...drafts, resumeText: "ok", letterText: "ok" }, tracker }, null, 2));
socket.close();
