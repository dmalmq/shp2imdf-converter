import { chromium } from "@playwright/test";
import path from "path";
import fs from "fs";

const BASE = "http://localhost:5173";
const FIXTURES = path.resolve("backend/tests/fixtures/tokyo_station");
const SHOTS = path.resolve("screenshots");

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let shotIndex = 30;
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

  // 1. Upload files
  console.log("Uploading files...");
  await page.goto(BASE);
  await page.waitForLoadState("networkidle");
  const shpFiles = fs.readdirSync(FIXTURES).filter((f) => /\.(shp|dbf|shx|prj|cpg)$/i.test(f));
  await page.locator('input[type="file"]').setInputFiles(shpFiles.map((f) => path.join(FIXTURES, f)));
  await sleep(1000);
  await page.locator('button:has-text("Import Files")').click();
  await sleep(8000);
  await page.locator('button:has-text("Continue")').first().click();
  await sleep(2000);

  // 2. Fill wizard step 1
  console.log("Filling wizard...");
  await page.getByLabel(/Venue Name/i).fill("Tokyo Station");
  await page.getByLabel(/Locality/i).first().fill("Chiyoda-ku");
  await page.locator('button:has-text("Save Project Info")').click();
  await sleep(2000);

  // 3. Skip to summary
  await page.locator('a:has-text("Skip to Summary"), button:has-text("Skip")').first().click().catch(() => {});
  await sleep(1000);

  // If no skip link, navigate via steps
  const url = page.url();
  if (!url.includes("summary")) {
    // Click through steps quickly
    for (let i = 0; i < 9; i++) {
      const nextBtn = page.locator('button:has-text("Next")').first();
      if (await nextBtn.isVisible().catch(() => false) && !(await nextBtn.isDisabled().catch(() => true))) {
        await nextBtn.click();
        await sleep(1500);
      }
    }
  }
  await sleep(1000);

  // 4. Generate & Open Review
  console.log("Generating...");
  const genBtn = page.locator('button:has-text("Generate")').first();
  if (await genBtn.isVisible().catch(() => false) && !(await genBtn.isDisabled().catch(() => true))) {
    await genBtn.click();
    await sleep(8000);
  }

  // Check if we're on review page now
  console.log("Current URL:", page.url());

  // If still on wizard, click the "Open Review" button
  const openReviewBtn = page.locator('button:has-text("Review"), a:has-text("Review")').first();
  if (await openReviewBtn.isVisible().catch(() => false)) {
    await openReviewBtn.click();
    await sleep(3000);
  }

  console.log("Current URL after review nav:", page.url());
  await shot(page, "review-loaded");

  // Validate
  const validateBtn = page.locator('button:has-text("Validate")').first();
  if (await validateBtn.isVisible().catch(() => false) && !(await validateBtn.isDisabled().catch(() => true))) {
    await validateBtn.click();
    await sleep(6000);
  }
  await shot(page, "review-after-validate");

  // Click a feature
  const tableRow = page.locator("table tbody tr").first();
  if (await tableRow.isVisible().catch(() => false)) {
    await tableRow.click();
    await sleep(1500);
  }
  await shot(page, "review-feature-selected");

  // Scroll to properties panel
  await page.evaluate(() => window.scrollTo(0, 400));
  await sleep(500);
  await shot(page, "review-properties");

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(500);
  await shot(page, "review-bottom");

  // Export dialog
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  const exportBtn = page.locator('button:has-text("Export")').first();
  if (await exportBtn.isVisible().catch(() => false) && !(await exportBtn.isDisabled().catch(() => true))) {
    await exportBtn.click();
    await sleep(1500);
    await shot(page, "review-export-dialog");
  }

  console.log("\nDone!");
  await browser.close();
})();
