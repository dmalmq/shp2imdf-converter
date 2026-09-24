#!/usr/bin/env node
/**
 * Screenshot every screen the B+ redesign touches, in light/dark and EN/日本語,
 * so a phase is judged as before vs after. Run from the repo root:
 *   node .cursor/skills/verify-shp2imdf/scripts/capture.mjs [--label baseline]
 *     [--frontend-port 5310] [--backend-port 8310] [--out <dir>] [--cleanup]
 * Output defaults to artifacts/captures/<label>/ with manifest.json listing
 * { screen, theme, lang, path } per image, path relative to the manifest.
 * Servers are attached or launched as `control.mjs launch` does; --cleanup
 * stops afterwards only the ones this pair's state file records as started.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  cmdCleanup,
  cmdDoctor,
  cmdFixtures,
  cmdLaunch,
  configurePorts,
  fillVenue,
  generateReview,
  gotoEnglishHome,
  loadPlaywright,
  openIllustrator,
  queueTokyoStation,
  repoRoot,
  takePortFlags
} from "./control.mjs";

const THEMES = ["light", "dark"];
const LANGS = ["en", "ja"];
const VIEWPORT = { width: 1440, height: 960 };

// Accessible names in both languages, since the toggles are pressed from
// whichever language the previous capture left the page in.
const THEME_TOGGLE = 'button[aria-label="Switch theme"], button[aria-label="テーマを切り替え"]';
const LANG_TOGGLE = 'button[title="Switch UI language"], button[title="表示言語を切り替え"]';

const WIZARD_SECTIONS = [
  { screen: "wizard-venue-info", nav: ["Project & Venue", "Venue Info"] },
  { screen: "wizard-buildings", nav: ["Project & Venue", "Buildings"] },
  { screen: "wizard-footprint", nav: ["Project & Venue", "Footprint"] },
  { screen: "wizard-file-classification", nav: ["File Classification"] },
  { screen: "wizard-level-mapping", nav: ["Level Mapping"] },
  { screen: "wizard-unit-mapping", nav: ["Attribute Mapping", "Unit Mapping"] },
  { screen: "wizard-opening-mapping", nav: ["Attribute Mapping", "Opening Mapping"] },
  { screen: "wizard-summary", nav: ["Summary & Generate"] }
];

function parseArgs(argv) {
  const { ports, rest } = takePortFlags(argv);
  const options = { label: "capture", out: null, ports, cleanup: false };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--cleanup") {
      options.cleanup = true;
      continue;
    }
    const match = /^--(label|out)(?:=(.*))?$/.exec(rest[i]);
    if (!match) throw new Error(`unknown argument ${rest[i]}`);
    const value = match[2] ?? rest[(i += 1)];
    if (!value) throw new Error(`--${match[1]} needs a value`);
    options[match[1]] = value;
  }
  if (!/^[\w.-]+$/.test(options.label)) throw new Error(`label must be a plain name: ${options.label}`);
  options.out = path.resolve(options.out ?? path.join(repoRoot, "artifacts", "captures", options.label));
  return options;
}

// Built from the backend's own test helper so the artwork is the three-page
// document the Illustrator tests use; the name makes the station lookup query 東京駅.
function writeArtworkFixture(dir) {
  const file = path.join(dir, "0001_東京.ai");
  const script = [
    "import sys",
    "from backend.tests.test_illustrator_import import _build_multipage_ai_pdf",
    "open(sys.argv[1], 'wb').write(_build_multipage_ai_pdf())"
  ].join("\n");
  const result = spawnSync("python", ["-c", script, file], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`artwork fixture failed: ${result.stderr}`);
  return file;
}

async function readMode(page) {
  return page.evaluate(() => ({
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    lang: document.documentElement.lang
  }));
}

// Clicked through the DOM rather than Playwright so a toggle still works while
// a modal dialog marks the rest of the page inert.
async function pressToggle(page, selector) {
  return page.evaluate((sel) => {
    const button = document.querySelector(sel);
    if (!button) return false;
    button.click();
    return true;
  }, selector);
}

async function setMode(page, theme, lang) {
  const mode = await readMode(page);
  if (mode.theme !== theme) {
    if (!(await pressToggle(page, THEME_TOGGLE))) {
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    }
    await page.waitForFunction(
      (dark) => document.documentElement.classList.contains("dark") === dark,
      theme === "dark"
    );
  }
  if (mode.lang !== lang) {
    if (!(await pressToggle(page, LANG_TOGGLE))) throw new Error(`no language toggle on ${page.url()}`);
    await page.waitForFunction((want) => document.documentElement.lang === want, lang);
  }
}

// Toasts time out after 4 s, so whether one is in a shot depends on how long
// the steps before it took; dismissing them keeps two runs comparable.
async function dismissToasts(page) {
  await page.evaluate(() => {
    for (const close of document.querySelectorAll('[role="status"][aria-live="polite"] button')) close.click();
  });
  await page
    .waitForFunction(() => !document.querySelector('[role="status"][aria-live="polite"]'), null, { timeout: 3000 })
    .catch(() => {});
}

async function settle(page, ms) {
  await dismissToasts(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

function makeShooter(page, outDir, manifest) {
  return async function shoot(screen, { wait = 400 } = {}) {
    for (const theme of THEMES) {
      for (const lang of LANGS) {
        await setMode(page, theme, lang);
        await settle(page, wait);
        const file = `${screen}.${theme}.${lang}.png`;
        await page.screenshot({ path: path.join(outDir, file) });
        manifest.push({ screen, theme, lang, path: file });
      }
    }
    await setMode(page, "light", "en");
    console.log(`captured ${screen}`);
  };
}

async function captureShapefileFlow(page, shoot) {
  await setMode(page, "light", "en");
  await shoot("upload");
  await queueTokyoStation(page);
  await shoot("upload-queued");
  await page.getByRole("button", { name: "Import & Continue" }).click();
  await page.waitForURL("**/wizard", { timeout: 60000 });
  await page.getByLabel(/Venue Name/).waitFor({ timeout: 30000 });
  await fillVenue(page);

  for (const { screen, nav } of WIZARD_SECTIONS) {
    for (const name of nav) {
      await page.getByRole("button", { name, exact: true }).click();
    }
    await page.getByRole("heading", { name: nav.at(-1), level: 1 }).waitFor({ timeout: 15000 });
    await shoot(screen);
  }

  await generateReview(page);
  await page.locator(".maplibregl-canvas").first().waitFor({ timeout: 30000 });
  await shoot("review", { wait: 2500 });

  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await page.getByRole("button", { name: "Validate", exact: true }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => !document.body.innerText.includes("Validating..."), null, { timeout: 60000 });
  await shoot("review-validated", { wait: 1500 });

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("dialog").waitFor({ timeout: 15000 });
  await shoot("review-export-dialog", { wait: 800 });
  await page.keyboard.press("Escape");
}

async function captureIllustratorFlow(page, shoot, artwork) {
  await openIllustrator(page);
  await shoot("illustrator-bring-in");

  await page.locator("#illustrator-georef-input").setInputFiles(artwork);
  await page.getByRole("heading", { name: "Name each floor", level: 1 }).waitFor({ timeout: 60000 });
  await shoot("illustrator-name-floors", { wait: 800 });

  await page.getByRole("button", { name: "Done assigning", exact: true }).click();
  await page.getByRole("tab", { name: "Place", exact: true }).waitFor({ timeout: 30000 });
  await page.getByTestId("placement-hold").waitFor({ state: "detached", timeout: 30000 }).catch(() => {
    console.log("illustrator-place: station lookup did not settle; capturing the held state");
  });
  await shoot("illustrator-place", { wait: 2500 });

  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await shoot("illustrator-export", { wait: 800 });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  configurePorts(options.ports);
  cmdFixtures();
  await cmdLaunch();
  if (!(await cmdDoctor())) throw new Error("doctor failed; refusing to capture");

  fs.rmSync(options.out, { recursive: true, force: true });
  fs.mkdirSync(options.out, { recursive: true });
  const artwork = writeArtworkFixture(options.out);

  const manifest = [];
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    // Separate contexts so the Illustrator route starts from a fresh store,
    // the way a user arriving from the Import page would.
    for (const flow of [
      (page, shoot) => captureShapefileFlow(page, shoot),
      (page, shoot) => captureIllustratorFlow(page, shoot, artwork)
    ]) {
      const context = await browser.newContext({ viewport: VIEWPORT });
      await context.addInitScript(() => {
        localStorage.setItem("ui_language", "en");
        localStorage.setItem("ui_theme", "light");
      });
      const page = await context.newPage();
      await gotoEnglishHome(page);
      await flow(page, makeShooter(page, options.out, manifest));
      await context.close();
    }
  } finally {
    await browser.close();
    fs.rmSync(artwork, { force: true });
    fs.writeFileSync(path.join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (options.cleanup) cmdCleanup();
  }
  const screens = new Set(manifest.map((entry) => entry.screen));
  console.log(`${screens.size} screens, ${manifest.length} images → ${options.out}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
