import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// Find playwright in npm npx cache
const npmDir = path.join(process.env.HOME || "~", ".npm", "_npx");
let playwrightPkg = null;

try {
  const npxDirs = fs.readdirSync(npmDir);
  for (const dir of npxDirs) {
    const candidate = path.join(npmDir, dir, "node_modules");
    if (fs.existsSync(path.join(candidate, "playwright"))) {
      playwrightPkg = candidate;
      break;
    }
  }
} catch {
  // Ignore filesystem error
}

assert(playwrightPkg, "Playwright must be installed via npx");
const require = createRequire(playwrightPkg);
const { chromium } = require("playwright");

const BASE_URL = process.env.TEST_URL || "https://jobist.peji.ca";

test("Playwright E2E Suite: Jobist live application", async (t) => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  t.after(async () => {
    await context.close();
    await browser.close();
  });

  await t.test("1. Landing page renders at 375px mobile viewport without horizontal overflow", async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE_URL);

    const title = await page.title();
    assert.match(title, /Jobist/);

    const startButton = page.locator("#startButton");
    assert.equal(await startButton.isVisible(), true);
    assert.match(await startButton.innerText(), /Build my profile/);

    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(hasOverflow, false, "Page should not have horizontal scrollbar at 375px");
    await page.close();
  });

  await t.test("2. Clicking 'Build my profile' transitions to Step 1 Profile Builder", async () => {
    const page = await context.newPage();
    await page.goto(BASE_URL);
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    assert.equal(await page.locator("#welcomeView").isVisible(), true);
    assert.equal(await page.locator("#appView").isHidden(), true);

    // Click 'Build my profile'
    await page.click("#startButton");

    // Welcome view should now be hidden and appView visible
    assert.equal(await page.locator("#welcomeView").isHidden(), true);
    assert.equal(await page.locator("#appView").isVisible(), true);
    assert.equal(await page.locator("#profileView").isVisible(), true);

    const headingText = await page.locator("#profileTitle").innerText();
    assert.match(headingText, /Build your profile/i);

    // Initial default mode should be 'Upload documents'
    assert.equal(await page.locator("#profileUploadPanel").isVisible(), true);
    assert.equal(await page.locator("#profileInterviewPanel").isHidden(), true);
    assert.equal(await page.locator("#profileReviewPanel").isHidden(), true);
    await page.close();
  });

  await t.test("3. Profile modalities switch cleanly between Upload, Interview, and Review", async () => {
    const page = await context.newPage();
    await page.goto(BASE_URL);
    await page.click("#startButton");

    // Switch to Interview mode
    await page.click("#profileInterviewModeBtn");
    assert.equal(await page.locator("#profileInterviewPanel").isVisible(), true);
    assert.equal(await page.locator("#profileUploadPanel").isHidden(), true);
    assert.equal(await page.locator("#profileReviewPanel").isHidden(), true);
    assert.match(await page.locator("#interviewProgress").innerText(), /Question 1 of 4/);

    // Advance to Question 2
    await page.fill("#interviewRoles", "Operations Lead at Peak Services (2021-2024)");
    await page.click("#interviewNext");
    assert.match(await page.locator("#interviewProgress").innerText(), /Question 2 of 4/);

    // Switch to Review mode
    await page.click("#profileReviewModeBtn");
    assert.equal(await page.locator("#profileReviewPanel").isVisible(), true);
    assert.equal(await page.locator("#profileInterviewPanel").isHidden(), true);
    assert.equal(await page.locator("#profileUploadPanel").isHidden(), true);
    assert.equal(await page.locator("#profileForm").isVisible(), true);
    await page.close();
  });

  await t.test("4. Filling and confirming profile advances user to Step 2 (Find an opportunity)", async () => {
    const page = await context.newPage();
    await page.goto(BASE_URL);
    await page.click("#startButton");
    await page.click("#profileReviewModeBtn");

    // Fill profile fields
    await page.fill("#profileForm [name=name]", "Jordan Taylor");
    await page.fill("#profileForm [name=location]", "Toronto, ON");
    await page.fill("#profileForm [name=experience]", "Senior Project Coordinator at Metro Logistics (2020–present)\nManaged 25+ logistics projects.");
    await page.fill("#profileForm [name=skills]", "Project Management\nAgile\nRisk Management");

    // Submit profile
    await page.click('#profileForm button[type="submit"]');

    // Step 2 (job view) becomes visible and profile status is Confirmed
    assert.equal(await page.locator("#jobView").isVisible(), true);
    assert.match(await page.locator("#profileNavStatus").innerText(), /Confirmed/i);
    await page.close();
  });

  await t.test("5. 'Try with an example' button loads demo and navigates to Step 3 (Fit report)", async () => {
    const page = await context.newPage();
    await page.goto(BASE_URL);
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await page.click("#loadExampleButton");

    // Fit report view should be active
    assert.equal(await page.locator("#fitView").isVisible(), true);
    assert.match(await page.locator("#profileNavStatus").innerText(), /Confirmed/i);
    assert.match(await page.locator("#jobNavStatus").innerText(), /Added/i);

    // Overall fit score should be rendered
    const overallScore = page.locator("#overallScore");
    assert.equal(await overallScore.isVisible(), true);
    const scoreVal = Number(await overallScore.innerText());
    assert.equal(scoreVal > 0, true, "Overall fit score should be greater than 0");

    // Strong evidence list should be populated
    const strengthItems = page.locator("#strengthList li");
    assert.equal((await strengthItems.count()) > 0, true, "Strengths list should have items");
    await page.close();
  });

  await t.test("6. AI Provider dialog opens, accepts model choices, and closes cleanly", async () => {
    const page = await context.newPage();
    await page.goto(BASE_URL);

    await page.click("#providerButton");
    const dialog = page.locator("#providerDialog");
    assert.equal(await dialog.isVisible(), true);

    // Select Gemini
    await page.selectOption("#providerChoice", "gemini");
    assert.equal(await page.locator("#geminiFields").isVisible(), true);
    assert.equal(await page.locator("#apiKeyInput").isVisible(), true);

    // Close dialog
    await page.click("#providerDialog .dialog-close");
    assert.equal(await dialog.isHidden(), true);
    await page.close();
  });
});
