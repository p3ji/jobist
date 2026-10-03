import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const npmDir = path.join(process.env.HOME || "~", ".npm", "_npx");
const playwrightDir = fs.readdirSync(npmDir).map(name => path.join(npmDir, name, "node_modules")).find(dir => fs.existsSync(path.join(dir, "playwright")));
assert(playwrightDir, "Playwright must be available in the npx cache");
const { chromium } = createRequire(playwrightDir)("playwright");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:8091/");
  await page.locator("#loadExampleButton").click();
  assert.match(await page.locator("#fitPostingAction").innerText(), /No original posting link/);

  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("jobist.prototype.v1"));
    state.job.url = "https://example.org/jobs/project-coordinator";
    localStorage.setItem("jobist.prototype.v1", JSON.stringify(state));
  });
  await page.reload();
  assert.equal(await page.locator("#fitPostingAction a").getAttribute("href"), "https://example.org/jobs/project-coordinator");

  await page.locator("#generateButton").click();
  await page.locator("#draftsView").waitFor({ state: "visible" });
  assert.match(await page.locator("#resumeDocument").innerText(), /Résumé suggestions/);
  assert.match(await page.locator("#resumeDocument").innerText(), /revise your existing résumé/);
  assert.equal(await page.locator("#draftPostingAction a").getAttribute("href"), "https://example.org/jobs/project-coordinator");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Application guidance should fit at 375px");
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });

  await page.locator("#saveApplicationButton").click();
  await page.locator('[data-view="tracker"]').click();
  assert.equal(await page.locator(".tracker-card a").getAttribute("href"), "https://example.org/jobs/project-coordinator");
  console.log("Application guidance and original posting links passed at 375px");
} finally {
  await browser.close();
}
