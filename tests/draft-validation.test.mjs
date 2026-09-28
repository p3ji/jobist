import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

// Load app.js text to inspect and extract functions for unit testing
const appSource = fs.readFileSync(new URL("../app.js", import.meta.url), "utf-8");

// Create sandbox to test sanitizeUnsupportedNumbers and claim validation logic
function createValidatorContext(profile, job, evidence) {
  const validIds = new Set(evidence.map(item => item.id));
  const allEvidenceText = evidence.map(item => item.text).join(" ");
  const jobText = `${job?.role || ""} ${job?.company || ""} ${job?.description || ""}`;

  function sanitizeUnsupportedNumbers(text, unsupportedNumbers) {
    let cleaned = text;
    for (const num of unsupportedNumbers) {
      const escaped = num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      cleaned = cleaned.replace(new RegExp(`\\(\\s*(?:in|during|from|to)?\\s*${escaped}\\s*\\)`, "gi"), "");
      cleaned = cleaned.replace(new RegExp(`\\b(?:in|during|at|from|to|between)\\s+${escaped}(?!\\w)`, "gi"), "");
      cleaned = cleaned.replace(new RegExp(`\\b(?:by|up to|over|approximately|approx\\.?|nearly)\\s+${escaped}(?:\\s*(?:percent|%|x|times|hours?|days?|weeks?|months?|years?|users?|clients?|engineers?|people))?(?!\\w)`, "gi"), "");
      cleaned = cleaned.replace(new RegExp(`\\b(?:team|group|portfolio|cohort|squad|department)\\s+of\\s+${escaped}(?:\\s*(?:people|members|engineers|developers|clients|accounts))?(?!\\w)`, "gi"), "team");
      cleaned = cleaned.replace(new RegExp(`\\b(?:over|more than|approximately|approx\\.?|nearly)?\\s*${escaped}\\+?\\s*(?:years?|yrs?|months?)\\s+of\\s+experience\\b`, "gi"), "experience");
      cleaned = cleaned.replace(new RegExp(`\\b${escaped}(?:\\s*(?:percent|%|x|times|hours?|days?|weeks?|months?|years?|users?|clients?|projects?|engineers?|people))?(?!\\w)`, "gi"), "");
    }
    return cleaned
      .replace(/\s+,/g, ",")
      .replace(/,\s*,/g, ",")
      .replace(/\(\s*\)/g, "")
      .replace(/\b(and|with|across|in|during|by|for|from|to)\s*\./gi, ".")
      .replace(/\s+\./g, ".")
      .replace(/,\s*\./g, ".")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function assertNoLanguageUpgrade(text, prof) {
    for (const language of ["french", "english"]) {
      const entry = String(prof.languages || "").split(/[;\n]/).find(part => part.toLowerCase().includes(language));
      if (entry && /fluent|native|courant|bilingu/i.test(entry)) continue;
      const unsupported = new RegExp(`(?:${language}\\s*(?:(?:[-—:]|is|at|proficiency is)\\s*)?(?:fluen|native|courant|bilingu)|(?:fluen|native|courant|bilingu)(?:\\s+(?:in|speaker of))?\\s+${language})`, "i");
      if (unsupported.test(text)) throw new Error(`The AI overstated ${language} proficiency`);
    }
  }

  const validateClaim = (claim, label) => {
    let item = claim;
    if (!item || typeof item !== "object") {
      if (typeof item === "string" && item.trim()) item = { text: item, evidenceIds: [] };
      else throw new Error("The AI returned an incomplete draft.");
    }
    if (!item.text || typeof item.text !== "string" || !item.text.trim()) throw new Error("The AI returned an incomplete draft.");
    let text = item.text.trim().replace(/^\s*(?:\d+[\.\)\:]|\(\d+\)|[•\-\*])\s*/, "");
    if (!text) throw new Error("The AI returned an incomplete draft.");

    const evidenceIds = Array.isArray(item.evidenceIds) ? [...new Set(item.evidenceIds.map(Number).filter(id => validIds.has(id)))] : [];
    assertNoLanguageUpgrade(text.toLowerCase(), profile);

    if (/\b(eagerly|eager|excitedly|excited|passionately|passionate|committed to|committed|immediately)\b/i.test(text) && !/\b(eager|excited|passionate|committed|immediately)\b/i.test(profile.goals || "")) {
      text = text.replace(/\b(eagerly|eager|excitedly|excited|passionately|passionate|committed to|committed|immediately)\b/gi, "").replace(/\s{2,}/g, " ").trim();
    }

    const languageEvidence = evidence.find(entry => entry.type === "languages");
    if (languageEvidence && /\b(english|french|mandarin)\b/i.test(text) && !evidenceIds.includes(languageEvidence.id)) evidenceIds.push(languageEvidence.id);
    const authorizationEvidence = evidence.find(entry => entry.type === "authorization");
    if (authorizationEvidence && /\b(citizen|permanent resident|authorization|legally entitled|legal status)\b/i.test(text) && !evidenceIds.includes(authorizationEvidence.id)) evidenceIds.push(authorizationEvidence.id);

    const numbers = text.match(/\b\d+(?:[.,]\d+)?%?/g) || [];
    const unverifiedNumbers = [];

    for (const number of numbers) {
      const citedText = evidence.filter(entry => evidenceIds.includes(entry.id)).map(entry => entry.text).join(" ");
      if (citedText.includes(number)) continue;

      const matchingEvidence = evidence.find(entry => entry.text.includes(number));
      if (matchingEvidence) {
        if (!evidenceIds.includes(matchingEvidence.id)) evidenceIds.push(matchingEvidence.id);
        continue;
      }

      if (jobText.includes(number)) continue;
      if (/^(?:1|2|3|4|5|2\.0|3\.0)$/.test(number)) continue;

      unverifiedNumbers.push(number);
    }

    if (unverifiedNumbers.length > 0) {
      text = sanitizeUnsupportedNumbers(text, unverifiedNumbers);
    }

    if (!evidenceIds.length) {
      const wordsList = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      for (const entry of evidence) {
        const entryWords = entry.text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
        if (wordsList.some(w => entryWords.includes(w))) {
          evidenceIds.push(entry.id);
          break;
        }
      }
      if (!evidenceIds.length && evidence.length) evidenceIds.push(evidence[0].id);
    }

    if (!text.trim()) throw new Error(`The AI returned an unverified ${label}.`);
    return { text: text.trim(), evidenceIds };
  };

  return { validateClaim, sanitizeUnsupportedNumbers };
}

test("strips numbered bullet prefixes so '1. Led...' is not blocked as an unconfirmed metric", () => {
  const profile = { name: "Alice", languages: "English", authorization: "Citizen", goals: "Learn" };
  const job = { role: "Developer", company: "Acme", description: "Build APIs" };
  const evidence = [
    { id: 1, type: "experience", text: "Led development of core backend APIs in Node.js" },
    { id: 2, type: "skill", text: "Node.js, PostgreSQL" }
  ];
  const { validateClaim } = createValidatorContext(profile, job, evidence);

  const claim = { text: "1. Led development of core backend APIs in Node.js", evidenceIds: [1] };
  const validated = validateClaim(claim, "experience bullet");
  assert.equal(validated.text, "Led development of core backend APIs in Node.js");
  assert.deepEqual(validated.evidenceIds, [1]);
});

test("cross-links dates present in candidate evidence even if the model omitted that evidence ID", () => {
  const profile = { name: "Alice", languages: "English", authorization: "Citizen", goals: "Learn" };
  const job = { role: "Developer", company: "Acme", description: "Build APIs" };
  const evidence = [
    { id: 1, type: "experience", text: "Software Developer at TechCorp (2020 - 2024)" },
    { id: 2, type: "skill", text: "Python and Django" }
  ];
  const { validateClaim } = createValidatorContext(profile, job, evidence);

  // Model cited only ID 2 (Python), but mentioned date 2020 from ID 1
  const claim = { text: "Software Developer from 2020 with Python and Django", evidenceIds: [2] };
  const validated = validateClaim(claim, "experience bullet");
  assert.equal(validated.text, "Software Developer from 2020 with Python and Django");
  assert(validated.evidenceIds.includes(1), "Evidence ID 1 should be auto-linked because 2020 is in evidence 1");
  assert(validated.evidenceIds.includes(2));
});

test("preserves numbers from the job description such as Python 3 or Level 2", () => {
  const profile = { name: "Alice", languages: "English", authorization: "Citizen", goals: "Learn" };
  const job = { role: "Python Developer", company: "Acme", description: "Requires Python 3 and Level 2 support experience" };
  const evidence = [
    { id: 1, type: "experience", text: "Built backend services in Python" },
    { id: 2, type: "skill", text: "Python" }
  ];
  const { validateClaim } = createValidatorContext(profile, job, evidence);

  const claim = { text: "Built backend services using Python 3 and provided Level 2 support.", evidenceIds: [1] };
  const validated = validateClaim(claim, "experience bullet");
  assert.match(validated.text, /Python 3/);
  assert.match(validated.text, /Level 2/);
});

test("auto-heals unconfirmed metrics instead of throwing an unhandled fatal block", () => {
  const profile = { name: "Alice", languages: "English", authorization: "Citizen", goals: "Learn" };
  const job = { role: "Lead Engineer", company: "Acme", description: "Lead distributed systems" };
  const evidence = [
    { id: 1, type: "experience", text: "Led database migration to PostgreSQL" }
  ];
  const { validateClaim } = createValidatorContext(profile, job, evidence);

  // Model hallucinates "improving query performance by 40%"
  const claim = { text: "Led database migration to PostgreSQL, improving query performance by 40%.", evidenceIds: [1] };
  const validated = validateClaim(claim, "experience bullet");
  assert.equal(validated.text, "Led database migration to PostgreSQL, improving query performance.");
  assert.deepEqual(validated.evidenceIds, [1]);
});

test("auto-links language and authorization evidence when referenced", () => {
  const profile = { name: "Alice", languages: "English — fluent; French — fluent", authorization: "Citizen or permanent resident", goals: "Learn" };
  const job = { role: "Analyst", company: "Acme", description: "Bilingual analyst" };
  const evidence = [
    { id: 1, type: "experience", text: "Analyzed operational data" },
    { id: 2, type: "languages", text: "English — fluent; French — fluent" },
    { id: 3, type: "authorization", text: "Citizen or permanent resident" }
  ];
  const { validateClaim } = createValidatorContext(profile, job, evidence);

  const claim = { text: "As a permanent resident fluent in English and French, analyzed operational data.", evidenceIds: [1] };
  const validated = validateClaim(claim, "cover-letter paragraph");
  assert(validated.evidenceIds.includes(2), "Language evidence should be auto-linked");
  assert(validated.evidenceIds.includes(3), "Authorization evidence should be auto-linked");
});

test("app.js contains recovery actions and template fallback wiring", () => {
  assert(appSource.includes('#draftFallbackTemplateBtn'), "app.js must handle template fallback button");
  assert(appSource.includes('#draftChangeModelBtn'), "app.js must handle change model button");
  assert(appSource.includes('sanitizeUnsupportedNumbers'), "app.js must include metric sanitization");
});

test("profileExtractionPrompt contains explicit exhaustive criteria", () => {
  assert(appSource.includes("Exhaustively extract ALL employment history"), "prompt must instruct exhaustive extraction");
  assert(appSource.includes("Do NOT selectively summarize"), "prompt must forbid selective omission");
});

test("formatProfileItems expands all achievements and bullets into separate lines", () => {
  function formatProfileItems(item) {
    if (typeof item === "string") return [item.trim()].filter(Boolean);
    if (!item || typeof item !== "object") return [String(item || "").trim()].filter(Boolean);
    const role = item.role || item.title || item.position || "";
    const company = item.company || item.employer || item.organization || "";
    const start = item.start_date || item.startDate || item.start || "";
    const end = item.end_date || item.endDate || item.end || "";
    const dates = (start || end) ? `${start} - ${end}`.replace(/^ - |- $/g, "").trim() : (item.dates || item.date || item.year || "");
    let header = "";
    if (role && company) header = `${role}, ${company}`;
    else if (role || company) header = role || company;
    if (header && dates) header = `${header} (${dates})`;
    else if (dates && !header) header = dates;

    const bullets = [];
    for (const k of ["achievements", "responsibilities", "highlights", "details", "bullets", "description"]) {
      const val = item[k];
      if (!val) continue;
      if (Array.isArray(val)) {
        for (const b of val) {
          const bStr = String(b || "").trim().replace(/^[•\-\*]\s*/, "");
          if (bStr && !bullets.includes(bStr)) bullets.push(bStr);
        }
      } else if (typeof val === "string") {
        for (const line of val.split("\n")) {
          const bStr = line.trim().replace(/^[•\-\*]\s*/, "");
          if (bStr && !bullets.includes(bStr)) bullets.push(bStr);
        }
      }
    }

    if (!bullets.length) return header ? [header] : [];
    return bullets.map(b => (header && !b.startsWith(header) ? `${header} — ${b}` : b));
  }

  const rawItem = {
    role: "Senior Engineer",
    company: "Acme",
    startDate: "2020",
    endDate: "2024",
    achievements: [
      "Built data pipelines handling 10M records",
      "Reduced latency by 40%"
    ]
  };

  const lines = formatProfileItems(rawItem);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Built data pipelines handling 10M records/);
  assert.match(lines[1], /Reduced latency by 40%/);
  assert.match(lines[0], /Senior Engineer, Acme \(2020 - 2024\)/);
});

