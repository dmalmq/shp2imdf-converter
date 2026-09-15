#!/usr/bin/env node
/**
 * Verification control for SHP → IMDF Converter.
 * Run from the repo root:
 *   node .cursor/skills/verify-shp2imdf/scripts/control.mjs <command>
 */

import { spawnSync } from "node:child_process";
import dns from "node:dns";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

dns.setDefaultResultOrder("verbatim");

const FRONTEND_PORT = 5310;
const BACKEND_PORT = 8310;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const HEALTH_PATH = "/api/health";
const APP_TITLE = "SHP to IMDF Converter";
const APP_HEADER = "IMDF Converter";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const repoRoot = findRepoRoot(here);
const runDir = path.join(skillRoot, ".run");
const statePath = path.join(runDir, "state.json");
const artifactsRoot = path.join(repoRoot, "artifacts", "verify-shp2imdf");
const fixturesDir = path.join(repoRoot, "backend", "tests", "fixtures", "tokyo_station");
const spaceShp = path.join(fixturesDir, "JRTokyoSta_B1_Space.shp");

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, "frontend", "vite.config.ts")) &&
      fs.existsSync(path.join(dir, "backend", "main.py"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find shp2imdf-converter repo root from control.mjs");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readState() {
  if (!fs.existsSync(statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  ensureDir(runDir);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function httpGet(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`timeout ${url}`));
    });
    req.on("error", reject);
  });
}

async function probe(url) {
  try {
    return await httpGet(url);
  } catch (err) {
    return { status: 0, body: "", error: err.message };
  }
}

function parseHealth(body) {
  try {
    const json = JSON.parse(body);
    return json && json.status === "ok";
  } catch {
    return false;
  }
}

function isThisFrontend(body) {
  return typeof body === "string" && body.includes(APP_TITLE);
}

async function waitFor(url, test, timeoutMs, label) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const result = await probe(url);
    last = `${result.status} ${result.error || result.body.slice(0, 80)}`;
    if (test(result)) return result;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timeout waiting for ${label} at ${url} (${last})`);
}

function shapefileParts() {
  if (!fs.existsSync(fixturesDir)) return [];
  return fs
    .readdirSync(fixturesDir)
    .filter((name) => /\.(shp|dbf|shx|prj|cpg)$/i.test(name))
    .map((name) => path.join(fixturesDir, name));
}

function cmdFixtures() {
  if (fs.existsSync(spaceShp)) {
    console.log(`fixtures already present: ${spaceShp}`);
    return;
  }
  const result = spawnSync("python", ["backend/tests/generate_fixtures.py"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`generate_fixtures.py exited ${result.status}`);
  }
  if (!fs.existsSync(spaceShp)) {
    throw new Error(`fixtures ran but ${spaceShp} is still missing`);
  }
  console.log(`fixtures written: ${spaceShp}`);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resolveExecutable(command) {
  if (path.isAbsolute(command) && fs.existsSync(command)) return command;
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [command], { encoding: "utf8" });
  const lines = (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const preferred = lines.find((line) => /\.(exe|cmd)$/i.test(line)) || lines[0];
  if (!preferred) {
    throw new Error(`cannot resolve executable: ${command}`);
  }
  return preferred;
}

function spawnLogged(command, args, cwd, logFile) {
  ensureDir(runDir);
  const stdoutLog = logFile;
  const stderrLog = logFile.replace(/\.log$/i, ".err.log");
  for (const file of [stdoutLog, stderrLog]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  const exe = resolveExecutable(command);
  const ps = [
    `$p = Start-Process -FilePath ${psQuote(exe)} -ArgumentList @(${args.map(psQuote).join(",")}) -WorkingDirectory ${psQuote(cwd)} -RedirectStandardOutput ${psQuote(stdoutLog)} -RedirectStandardError ${psQuote(stderrLog)} -WindowStyle Hidden -PassThru`,
    "Write-Output $p.Id"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`Start-Process failed for ${exe}: ${result.stderr || result.stdout}`);
  }
  const pid = Number((result.stdout || "").trim().split(/\r?\n/).pop());
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Start-Process returned no PID: ${result.stdout}`);
  }
  return pid;
}

function taskkill(pid) {
  if (!pid) return;
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true
  });
  const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (text) console.log(text);
}

async function cmdLaunch() {
  cmdFixtures();
  const state = readState();
  const backend = await probe(`${BACKEND_URL}${HEALTH_PATH}`);
  const frontend = await probe(FRONTEND_URL);

  if (backend.status && !parseHealth(backend.body)) {
    throw new Error(
      `port ${BACKEND_PORT} is in use but /api/health is not this app: ${backend.body.slice(0, 200)}`
    );
  }
  if (frontend.status && !isThisFrontend(frontend.body) && frontend.status !== 0) {
    if (frontend.body && !isThisFrontend(frontend.body)) {
      throw new Error(
        `port ${FRONTEND_PORT} is in use but the document is not ${APP_TITLE}`
      );
    }
  }

  if (!parseHealth(backend.body)) {
    const logFile = path.join(runDir, "backend.log");
    const pid = spawnLogged(
      "python",
      ["-m", "uvicorn", "backend.main:app", "--port", String(BACKEND_PORT)],
      repoRoot,
      logFile
    );
    state.backendPid = pid;
    state.startedBackend = true;
    state.backendLog = logFile;
    writeState(state);
    console.log(`started backend pid=${pid} (no --reload)`);
  } else {
    console.log(`backend already healthy at ${BACKEND_URL}${HEALTH_PATH} — attaching`);
    state.startedBackend = state.startedBackend === true && Boolean(state.backendPid);
    writeState(state);
  }

  const frontendOk = isThisFrontend((await probe(FRONTEND_URL)).body);
  if (!frontendOk) {
    const viteJs = path.join(repoRoot, "frontend", "node_modules", "vite", "bin", "vite.js");
    if (!fs.existsSync(viteJs)) {
      throw new Error(`Vite is not installed at ${viteJs} — run npm ci in frontend/`);
    }
    const logFile = path.join(runDir, "frontend.log");
    const pid = spawnLogged(process.execPath, [viteJs], path.join(repoRoot, "frontend"), logFile);
    state.frontendPid = pid;
    state.startedFrontend = true;
    state.frontendLog = logFile;
    writeState(state);
    console.log(`started frontend pid=${pid}`);
  } else {
    console.log(`frontend already healthy at ${FRONTEND_URL} — attaching`);
    state.startedFrontend = state.startedFrontend === true && Boolean(state.frontendPid);
    writeState(state);
  }

  await waitFor(
    `${BACKEND_URL}${HEALTH_PATH}`,
    (r) => parseHealth(r.body),
    90000,
    "backend health"
  );
  await waitFor(FRONTEND_URL, (r) => isThisFrontend(r.body), 90000, "frontend document");
  writeState({ ...readState(), launchedAt: new Date().toISOString() });
  console.log("launch ready");
}

async function cmdDoctor() {
  const problems = [];
  const backend = await probe(`${BACKEND_URL}${HEALTH_PATH}`);
  if (!parseHealth(backend.body)) {
    problems.push(`backend health failed (${backend.status} ${backend.error || backend.body})`);
  }
  const frontend = await probe(FRONTEND_URL);
  if (!isThisFrontend(frontend.body)) {
    problems.push(`frontend is not ${APP_TITLE} (${frontend.status} ${frontend.error || "no title"})`);
  }
  const proxied = await probe(`${FRONTEND_URL}${HEALTH_PATH}`);
  if (!parseHealth(proxied.body)) {
    problems.push(`Vite /api proxy health failed (${proxied.status} ${proxied.error || proxied.body})`);
  }
  if (!fs.existsSync(spaceShp)) {
    problems.push(`missing fixture ${spaceShp} — run fixtures`);
  }
  const state = readState();
  if (state.startedBackend && state.backendPid) {
    console.log(`owned backend pid=${state.backendPid}`);
  } else {
    console.log("backend: attached (this run did not start it)");
  }
  if (state.startedFrontend && state.frontendPid) {
    console.log(`owned frontend pid=${state.frontendPid}`);
  } else {
    console.log("frontend: attached or not recorded as started by this run");
  }
  console.log(`frontend ${FRONTEND_URL}`);
  console.log(`backend ${BACKEND_URL}${HEALTH_PATH}`);
  console.log(`fixture ${spaceShp} ${fs.existsSync(spaceShp) ? "ok" : "MISSING"}`);
  if (problems.length) {
    for (const p of problems) console.error(`doctor FAIL: ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log("doctor OK");
}

function cmdStatus() {
  console.log(JSON.stringify({ repoRoot, ...readState() }, null, 2));
}

function cmdCleanup() {
  const state = readState();
  if (state.startedFrontend && state.frontendPid) {
    console.log(`stopping frontend pid=${state.frontendPid}`);
    taskkill(state.frontendPid);
  } else {
    console.log("cleanup: not stopping frontend (not started by this run)");
  }
  if (state.startedBackend && state.backendPid) {
    console.log(`stopping backend pid=${state.backendPid}`);
    taskkill(state.backendPid);
  } else {
    console.log("cleanup: not stopping backend (not started by this run)");
  }
  writeState({
    ...state,
    backendPid: state.startedBackend ? null : state.backendPid,
    frontendPid: state.startedFrontend ? null : state.frontendPid,
    startedBackend: false,
    startedFrontend: false,
    cleanedAt: new Date().toISOString()
  });
  console.log(`evidence kept at ${artifactsRoot}`);
}

function loadPlaywright() {
  const require = createRequire(path.join(repoRoot, "frontend", "package.json"));
  return require("@playwright/test");
}

async function withPage(fn) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    localStorage.setItem("ui_language", "en");
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

function writeEvidence(featureId, page, extra) {
  const dir = path.join(artifactsRoot, featureId);
  ensureDir(dir);
  return (async () => {
    const screenshotPath = path.join(dir, "result.png");
    const ariaPath = path.join(dir, "result.aria.txt");
    const reportPath = path.join(dir, "report.md");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    let aria = "";
    try {
      aria = await page.locator("body").ariaSnapshot();
    } catch (err) {
      aria = `(ariaSnapshot failed: ${err.message})\n${await page.locator("body").innerText()}`;
    }
    fs.writeFileSync(ariaPath, aria, "utf8");
    const report = [
      `# ${featureId}`,
      "",
      `- time: ${new Date().toISOString()}`,
      `- url: ${page.url()}`,
      `- title: ${await page.title()}`,
      `- entry: ${extra.entry || "unknown"}`,
      extra.notes ? `- notes: ${extra.notes}` : "",
      "",
      extra.body || ""
    ]
      .filter(Boolean)
      .join("\n");
    fs.writeFileSync(reportPath, `${report}\n`, "utf8");
    console.log(`evidence: ${dir}`);
    return dir;
  })();
}

async function gotoEnglishHome(page) {
  await page.goto(FRONTEND_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=IMDF Converter", { timeout: 30000 });
  const enToggle = page.getByRole("button", { name: "EN", exact: true });
  if (await enToggle.count()) {
    await enToggle.click();
    await page.getByRole("button", { name: "日本語", exact: true }).waitFor({ timeout: 10000 });
  }
}

async function importTokyoStation(page) {
  await gotoEnglishHome(page);
  await page.getByRole("button", { name: "Standard import" }).click();
  const files = shapefileParts();
  if (files.length === 0) {
    throw new Error("no tokyo_station shapefile parts — run fixtures");
  }
  await page.locator('input[type="file"]:not(#imdf-file-input)').first().setInputFiles(files);
  await page.getByText("JRTokyoSta_B1_Space").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Import & Continue" }).click();
  await page.waitForURL("**/wizard", { timeout: 60000 });
  await page.getByRole("heading", { name: /Step 1: Project Info/ }).waitFor({ timeout: 30000 });
  await page.getByLabel(/Venue Name/).waitFor({ timeout: 30000 });
}

async function driveImportShapefiles() {
  await withPage(async (page) => {
    await importTokyoStation(page);
    await writeEvidence("import-shapefiles", page, {
      entry: "Import dropzone + Import & Continue",
      notes: `header ${APP_HEADER}; landed on /wizard`,
      body: "Expected: Standard import of tokyo_station fixtures navigates to the wizard Project Info step."
    });
    const text = await page.locator("body").innerText();
    if (!text.includes("Step 1: Project Info") || !text.includes(APP_HEADER) || !text.includes("Venue Name")) {
      throw new Error("import-shapefiles proof missing Project Info form or app header");
    }
    console.log("drive import-shapefiles OK");
  });
}

async function driveWizardConfigure() {
  await withPage(async (page) => {
    await importTokyoStation(page);
    await page.getByLabel(/Venue Name/).fill("Tokyo Station");
    await page.getByLabel(/Locality/).first().fill("Chiyoda-ku");
    await page.getByRole("button", { name: "Save Project Info" }).click();
    await page.getByText(/Venue Info|saved|Project Info/i).first().waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Summary & Generate" }).click();
    await page.getByRole("heading", { name: /Step 10: Summary/ }).waitFor({ timeout: 15000 });
    const confirm = page.getByRole("button", { name: "Confirm & Open Review" });
    await confirm.waitFor({ timeout: 10000 });
    if (await confirm.isDisabled()) {
      throw new Error("Confirm & Open Review is disabled — classification/levels/unit mapping incomplete");
    }
    await confirm.click();
    await page.waitForURL("**/review", { timeout: 60000 });
    await page.getByRole("button", { name: "Export" }).waitFor({ timeout: 30000 });
    await writeEvidence("wizard-configure", page, {
      entry: "wizard Venue Info → Summary & Generate",
      notes: "generated draft and opened review",
      body: "Expected: review chrome with Export enabled after Confirm & Open Review."
    });
    console.log("drive wizard-configure OK");
  });
}

async function driveIllustratorOpen() {
  await withPage(async (page) => {
    await gotoEnglishHome(page);
    await page.getByRole("button", { name: "Illustrator (.ai) → place on map" }).click();
    await page.waitForURL("**/illustrator", { timeout: 15000 });
    await page.getByRole("heading", { name: /Place Illustrator artwork/ }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Choose .ai file" }).waitFor();
    await writeEvidence("illustrator-open", page, {
      entry: "Import page button Illustrator (.ai) → place on map",
      body: "Expected: Place Illustrator artwork heading and Choose .ai file. Did not write placements.db."
    });
    console.log("drive illustrator-open OK");
  });
}

async function cmdDrive(featureId) {
  const doctorExit = await (async () => {
    try {
      await cmdDoctor();
      return process.exitCode || 0;
    } catch (err) {
      console.error(err);
      return 1;
    }
  })();
  if (doctorExit !== 0) {
    throw new Error("doctor failed; refusing to drive");
  }
  if (featureId === "import-shapefiles") return driveImportShapefiles();
  if (featureId === "wizard-configure") return driveWizardConfigure();
  if (featureId === "illustrator-open") return driveIllustratorOpen();
  throw new Error(
    `no one-shot drive for "${featureId}". Implemented: import-shapefiles, wizard-configure, illustrator-open. See features/${featureId}.md`
  );
}

function cmdHelp() {
  console.log(`verify-shp2imdf control
repo: ${repoRoot}

commands:
  help
  fixtures              generate tokyo_station shapefiles if missing
  launch                attach or start :8310 and :5310
  doctor                read-only readiness
  status                print .run/state.json
  drive <feature-id>    import-shapefiles | wizard-configure | illustrator-open
  cleanup               kill only PIDs this run started; keep artifacts
`);
}

const [command, ...rest] = process.argv.slice(2);

async function main() {
  if (!command || command === "help" || command === "-h" || command === "--help") {
    cmdHelp();
    return;
  }
  if (command === "fixtures") return cmdFixtures();
  if (command === "launch") return cmdLaunch();
  if (command === "doctor") return cmdDoctor();
  if (command === "status") return cmdStatus();
  if (command === "cleanup") return cmdCleanup();
  if (command === "drive") {
    if (!rest[0]) throw new Error("drive requires a feature id");
    return cmdDrive(rest[0]);
  }
  throw new Error(`unknown command ${command}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
