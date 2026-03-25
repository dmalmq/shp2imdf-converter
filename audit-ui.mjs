import { chromium } from "@playwright/test";
import path from "path";
import fs from "fs";

const BASE = "http://localhost:5173";
const FIXTURES = path.resolve("backend/tests/fixtures/tokyo_station");
const SHOTS = path.resolve("screenshots");

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let shotIndex = 1;
async function shot(page, name) {
  await sleep(600);
  const prefix = String(shotIndex++).padStart(2, "0");
  const filename = `${prefix}-${name}.png`;
  await page.screenshot({ path: path.join(SHOTS, filename), fullPage: true });
  console.log(`  -> ${filename}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();

  // =========================================================
  // 1. UPLOAD PAGE
  // =========================================================
  console.log("=== UPLOAD PAGE ===");
  await page.goto(BASE);
  await page.waitForLoadState("networkidle");
  await shot(page, "upload-empty");

  // Add files
  const shpFiles = fs.readdirSync(FIXTURES).filter((f) => /\.(shp|dbf|shx|prj|cpg)$/i.test(f));
  await page.locator('input[type="file"]').setInputFiles(shpFiles.map((f) => path.join(FIXTURES, f)));
  await sleep(1000);
  await shot(page, "upload-files-selected");

  // Import
  await page.locator('button:has-text("Import Files")').click();
  await sleep(8000); // wait for import
  await shot(page, "upload-import-done");

  // Continue to wizard
  try {
    const continueBtn = page.locator('button:has-text("Continue")').first();
    await continueBtn.waitFor({ state: "visible", timeout: 5000 });
    await continueBtn.click();
    await sleep(2000);
  } catch {
    await page.goto(`${BASE}/wizard`);
    await sleep(2000);
  }

  // =========================================================
  // 2. WIZARD
  // =========================================================
  console.log("=== WIZARD ===");

  // Step 1: Project Info
  console.log("  Step 1: Project Info");
  await shot(page, "wizard-step1-empty");

  // Fill required fields using label text
  await page.getByLabel(/Venue Name/i).fill("Tokyo Station");
  await page.getByLabel(/Locality/i).first().fill("Chiyoda-ku");

  // Save
  await page.locator('button:has-text("Save Project Info")').click();
  await sleep(2000);
  await shot(page, "wizard-step1-saved");

  // Step 2: File Classification
  console.log("  Step 2: File Classification");
  await page.locator('button:has-text("Next")').first().click();
  await sleep(2000);
  await shot(page, "wizard-step2-file-class");
  await page.evaluate(() => window.scrollTo(0, 500));
  await sleep(300);
  await shot(page, "wizard-step2-scrolled");
  await page.evaluate(() => window.scrollTo(0, 0));

  // Step 3: Level Mapping
  console.log("  Step 3: Level Mapping");
  await page.locator('button:has-text("Next")').first().click();
  await sleep(2000);
  await shot(page, "wizard-step3-level-map");
  await page.evaluate(() => window.scrollTo(0, 500));
  await sleep(300);
  await shot(page, "wizard-step3-scrolled");
  await page.evaluate(() => window.scrollTo(0, 0));

  // Step 4: Building Assignment
  console.log("  Step 4: Building");
  await page.locator('button:has-text("Next")').first().click();
  await sleep(2000);
  await shot(page, "wizard-step4-building");

  // Step 5: Footprint
  console.log("  Step 5: Footprint");
  await page.locator('button:has-text("Next")').first().click();
  await sleep(2000);
  await shot(page, "wizard-step5-footprint");

  // Step 6: Opening Map
  console.log("  Step 6: Opening Map");
  await page.locator('button:has-text("Next")').first().click();
  await sleep(2000);
  await shot(page, "wizard-step6-opening");
  await page.evaluate(() => window.scrollTo(0, 500));
  await sleep(300);
  await shot(page, "wizard-step6-scrolled");
  await page.evaluate(() => window.scrollTo(0, 0));

  // Step 7: Fixture Map
  console.log("  Step 7: Fixture Map");
  await page.locator('button:has-text("Next")').first().click();
  await sleep(2000);
  await shot(page, "wizard-step7-fixture");

  // Step 8: Detail Map
  console.log("  Step 8: Detail Map");
  await page.locator('button:has-text("Next")').first().click();
  await sleep(2000);
  await shot(page, "wizard-step8-detail");

  // Step 9: Unit Map
  console.log("  Step 9: Unit Map");
  await page.locator('button:has-text("Next")').first().click();
  await sleep(2000);
  await shot(page, "wizard-step9-unit");
  await page.evaluate(() => window.scrollTo(0, 500));
  await sleep(300);
  await shot(page, "wizard-step9-scrolled");
  await page.evaluate(() => window.scrollTo(0, 0));

  // Step 10: Summary
  console.log("  Step 10: Summary");
  await page.locator('button:has-text("Next")').first().click();
  await sleep(2000);
  await shot(page, "wizard-step10-summary");
  await page.evaluate(() => window.scrollTo(0, 500));
  await sleep(300);
  await shot(page, "wizard-step10-scrolled");
  await page.evaluate(() => window.scrollTo(0, 0));

  // Generate & go to Review
  console.log("  Generate & Navigate to Review");
  const genBtn = page.locator('button:has-text("Generate")').first();
  if (await genBtn.isVisible().catch(() => false)) {
    const isDisabled = await genBtn.isDisabled().catch(() => true);
    if (!isDisabled) {
      await genBtn.click();
      await sleep(6000);
    }
  }
  await shot(page, "wizard-after-generate");

  // =========================================================
  // 3. REVIEW PAGE
  // =========================================================
  console.log("=== REVIEW PAGE ===");
  if (!page.url().includes("/review")) {
    await page.goto(`${BASE}/review`);
  }
  await sleep(4000);
  await shot(page, "review-initial");

  // Validate
  const validateBtn = page.locator('button:has-text("Validate")').first();
  if (await validateBtn.isVisible().catch(() => false)) {
    await validateBtn.click();
    await sleep(6000);
  }
  await shot(page, "review-validated");

  // Click a table row
  const tableRow = page.locator("table tbody tr").first();
  if (await tableRow.isVisible().catch(() => false)) {
    await tableRow.click();
    await sleep(1500);
    await shot(page, "review-feature-selected");
  }

  // Properties panel at bottom
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(500);
  await shot(page, "review-scrolled-bottom");

  // Back to top for export
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);

  // Export dialog
  const exportBtn = page.locator('button:has-text("Export")').first();
  if (await exportBtn.isVisible().catch(() => false) && !(await exportBtn.isDisabled().catch(() => true))) {
    await exportBtn.click();
    await sleep(1500);
    await shot(page, "review-export-dialog");
  }

  console.log("\nDone! All screenshots in /screenshots/");
  await browser.close();
})();
