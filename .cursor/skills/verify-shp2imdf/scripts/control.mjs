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
import { fileURLToPath, pathToFileURL } from "node:url";

dns.setDefaultResultOrder("verbatim");

export const DEFAULT_FRONTEND_PORT = 5310;
export const DEFAULT_BACKEND_PORT = 8310;
let FRONTEND_PORT = DEFAULT_FRONTEND_PORT;
let BACKEND_PORT = DEFAULT_BACKEND_PORT;
let FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
let BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const HEALTH_PATH = "/api/health";
const APP_TITLE = "SHP to IMDF Converter";
const APP_HEADER = "IMDF Converter";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const repoRoot = findRepoRoot(here);
const runDir = path.join(skillRoot, ".run");
let statePath = path.join(runDir, "state.json");
const artifactsRoot = path.join(repoRoot, "artifacts", "verify-shp2imdf");
const fixturesDir = path.join(repoRoot, "backend", "tests", "fixtures", "tokyo_station");
const spaceShp = path.join(fixturesDir, "JRTokyoSta_B1_Space.shp");

function isDefaultPair() {
  return FRONTEND_PORT === DEFAULT_FRONTEND_PORT && BACKEND_PORT === DEFAULT_BACKEND_PORT;
}

// A worktree runs its own pair beside the shared 5310/8310 instance; each pair
// keeps its own state file so cleanup never reaches the other pair's PIDs.
export function configurePorts({ frontend = DEFAULT_FRONTEND_PORT, backend = DEFAULT_BACKEND_PORT } = {}) {
  FRONTEND_PORT = Number(frontend);
  BACKEND_PORT = Number(backend);
  FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
  BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
  statePath = path.join(runDir, isDefaultPair() ? "state.json" : `state-${FRONTEND_PORT}-${BACKEND_PORT}.json`);
  return { frontendUrl: FRONTEND_URL, backendUrl: BACKEND_URL };
}

export function takePortFlags(argv) {
  const rest = [];
  const ports = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = /^--(frontend|backend)-port(?:=(.*))?$/.exec(arg);
    if (!match) {
      rest.push(arg);
      continue;
    }
    const value = match[2] ?? argv[(i += 1)];
    if (!/^\d+$/.test(value ?? "")) throw new Error(`${arg} needs a port number`);
    ports[match[1]] = Number(value);
  }
  return { ports, rest };
}

function logName(base) {
  return isDefaultPair() ? `${base}.log` : `${base}-${FRONTEND_PORT}-${BACKEND_PORT}.log`;
}

// vite.config.ts pins 5310 with strictPort and proxies to 8310, so another pair
// gets a derived config. It lives under node_modules so it stays untracked and
// still resolves `vite` and the base config; its own cacheDir keeps two dev
// servers of one checkout from sharing a dep-optimiser cache.
function viteConfigForPorts() {
  if (isDefaultPair()) return null;
  const dir = path.join(repoRoot, "frontend", "node_modules", ".capture");
  ensureDir(dir);
  const file = path.join(dir, `vite.config.${FRONTEND_PORT}-${BACKEND_PORT}.mjs`);
  const body = `import { mergeConfig } from "vite";
import base from "../../vite.config.ts";

export default mergeConfig(base, {
  cacheDir: "node_modules/.vite-${FRONTEND_PORT}",
  server: {
    port: ${FRONTEND_PORT},
    strictPort: true,
    proxy: { "/api": "http://localhost:${BACKEND_PORT}" }
  }
});
`;
  fs.writeFileSync(file, body, "utf8");
  return file;
}

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

function spawnLogged(command, args, cwd, logFile, env = {}) {
  ensureDir(runDir);
  const stdoutLog = logFile;
  const stderrLog = logFile.replace(/\.log$/i, ".err.log");
  for (const file of [stdoutLog, stderrLog]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  const exe = resolveExecutable(command);
  const pidFile = logFile.replace(/\.log$/i, ".pid");
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  const ps = [
    `$p = Start-Process -FilePath ${psQuote(exe)} -ArgumentList @(${args.map(psQuote).join(",")}) -WorkingDirectory ${psQuote(cwd)} -RedirectStandardOutput ${psQuote(stdoutLog)} -RedirectStandardError ${psQuote(stderrLog)} -WindowStyle Hidden -PassThru`,
    `Set-Content -Path ${psQuote(pidFile)} -Value $p.Id`
  ].join("; ");
  // The server inherits PowerShell's handles, so a piped stdout would stay open
  // until the server exits and spawnSync would block for its whole lifetime.
  // The PID comes back through a file instead.
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ...env }
  });
  if (result.status !== 0) {
    throw new Error(`Start-Process failed for ${exe} (exit ${result.status})`);
  }
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8").trim()) : NaN;
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Start-Process returned no PID for ${exe}`);
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
  // Timestamps from the previous launch/cleanup would read as this run's.
  const { cleanedAt: _cleaned, launchedAt: _launched, ...state } = readState();
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
    const logFile = path.join(runDir, logName("backend"));
    const pid = spawnLogged(
      "python",
      ["-m", "uvicorn", "backend.main:app", "--port", String(BACKEND_PORT)],
      repoRoot,
      logFile,
      { CORS_ALLOWED_ORIGINS: FRONTEND_URL }
    );
    state.backendPid = pid;
    state.backendMatch = ["uvicorn", "backend.main:app", `--port ${BACKEND_PORT}`];
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
    const logFile = path.join(runDir, logName("frontend"));
    const viteConfig = viteConfigForPorts();
    const viteArgs = viteConfig ? [viteJs, "--config", viteConfig] : [viteJs];
    const pid = spawnLogged(process.execPath, viteArgs, path.join(repoRoot, "frontend"), logFile);
    state.frontendPid = pid;
    state.frontendMatch = viteConfig ? [viteJs, viteConfig] : [viteJs];
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
    return false;
  }
  console.log("doctor OK");
  return true;
}

function cmdStatus() {
  console.log(JSON.stringify({ repoRoot, ...readState() }, null, 2));
}

function processCommandLine(pid) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
    { encoding: "utf8", windowsHide: true }
  );
  return (result.stdout || "").trim();
}

function normalisedCommand(text) {
  return text.replace(/\//g, "\\").replace(/["']/g, "").toLowerCase();
}

// Windows reuses PIDs, so after a crash the recorded one can belong to someone
// else's process. Kill it only if its command line still carries what launch ran.
function stopOwned(role, pid, match) {
  const commandLine = processCommandLine(pid);
  if (!commandLine) {
    console.log(`cleanup: ${role} pid=${pid} is no longer running`);
    return;
  }
  const haystack = normalisedCommand(commandLine);
  const missing = (match || []).filter((needle) => !haystack.includes(normalisedCommand(needle)));
  if (!match || missing.length) {
    console.log(`cleanup: skipping ${role} pid=${pid}; its command line is not the one launched: ${commandLine}`);
    return;
  }
  console.log(`stopping ${role} pid=${pid}`);
  taskkill(pid);
}

function cmdCleanup() {
  const state = readState();
  if (state.startedFrontend && state.frontendPid) {
    stopOwned("frontend", state.frontendPid, state.frontendMatch);
  } else {
    console.log("cleanup: not stopping frontend (not started by this run)");
  }
  if (state.startedBackend && state.backendPid) {
    stopOwned("backend", state.backendPid, state.backendMatch);
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

async function queueTokyoStation(page) {
  await gotoEnglishHome(page);
  await page.getByRole("button", { name: "Standard", exact: true }).click();
  const files = shapefileParts();
  if (files.length === 0) {
    throw new Error("no tokyo_station shapefile parts — run fixtures");
  }
  await page.locator('input[type="file"]:not(#imdf-file-input)').first().setInputFiles(files);
  await page.getByText("JRTokyoSta_B1_Space").first().waitFor({ timeout: 15000 });
}

async function importTokyoStation(page) {
  await queueTokyoStation(page);
  await page.getByRole("button", { name: "Import & Continue" }).click();
  await page.waitForURL("**/wizard", { timeout: 60000 });
  await page.getByLabel(/Venue Name/).waitFor({ timeout: 30000 });
}

// The wizard autosaves 800 ms after typing stops; Summary reads the server's
// copy, so wait for the footer to confirm the save before moving on.
async function fillVenue(page) {
  await page.getByLabel(/Venue Name/).fill("Tokyo Station");
  await page.getByLabel(/Locality/).first().fill("Chiyoda-ku");
  await page.getByText(/^Saved ·/).waitFor({ timeout: 20000 });
}

async function generateReview(page) {
  const generate = page.getByRole("button", { name: "Generate & open Review" });
  await generate.waitFor({ timeout: 15000 });
  if (await generate.isDisabled()) {
    throw new Error("Generate & open Review is disabled — venue/classification/levels/unit mapping incomplete");
  }
  await generate.click();
  await page.waitForURL("**/review", { timeout: 60000 });
  await page.getByRole("button", { name: "Export", exact: true }).waitFor({ timeout: 30000 });
}

async function driveImportShapefiles() {
  await withPage(async (page) => {
    await importTokyoStation(page);
    await writeEvidence("import-shapefiles", page, {
      entry: "Import dropzone + Import & Continue",
      notes: `header ${APP_HEADER}; landed on /wizard`,
      body: "Expected: Standard import of tokyo_station fixtures navigates to the wizard Venue Info section."
    });
    const text = await page.locator("body").innerText();
    if (!text.includes(APP_HEADER) || !text.includes("Venue Name")) {
      throw new Error("import-shapefiles proof missing Venue Info form or app header");
    }
    console.log("drive import-shapefiles OK");
  });
}

async function driveWizardConfigure() {
  await withPage(async (page) => {
    await importTokyoStation(page);
    await fillVenue(page);
    await page.getByRole("button", { name: "Summary & Generate" }).click();
    await page.getByRole("heading", { name: "Summary & Generate", level: 1 }).waitFor({ timeout: 15000 });
    await generateReview(page);
    await writeEvidence("wizard-configure", page, {
      entry: "wizard Venue Info → Summary & Generate",
      notes: "generated draft and opened review",
      body: "Expected: review chrome with Export enabled after Generate & open Review."
    });
    console.log("drive wizard-configure OK");
  });
}

async function openIllustrator(page) {
  await gotoEnglishHome(page);
  await page.getByRole("button", { name: /Illustrator artwork/ }).click();
  await page.waitForURL("**/illustrator", { timeout: 15000 });
  await page.getByRole("heading", { name: /Place Illustrator artwork/ }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Choose file", exact: true }).waitFor();
}

async function driveIllustratorOpen() {
  await withPage(async (page) => {
    await openIllustrator(page);
    await writeEvidence("illustrator-open", page, {
      entry: "Import page card Illustrator artwork",
      body: "Expected: Place Illustrator artwork heading and Choose file. Did not write placements.db."
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

options (any command):
  --frontend-port N     default ${DEFAULT_FRONTEND_PORT}
  --backend-port N      default ${DEFAULT_BACKEND_PORT}
`);
}

export {
  cmdCleanup,
  cmdDoctor,
  cmdFixtures,
  cmdLaunch,
  fillVenue,
  generateReview,
  gotoEnglishHome,
  importTokyoStation,
  loadPlaywright,
  openIllustrator,
  queueTokyoStation,
  repoRoot
};

async function main() {
  const { ports, rest: args } = takePortFlags(process.argv.slice(2));
  configurePorts(ports);
  const [command, ...rest] = args;
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

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
