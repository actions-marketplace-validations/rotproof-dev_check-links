// The Rotproof link check, as GitHub runs it. This file only touches the machine: it reads the
// build folder, makes the requests to rotproof.dev and writes the results. Everything it decides
// is in dist/ (built from src/run.ts and src/report.ts).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { run } = require("./dist/apps/action/src/run.js");
const { logLines, missingCount, renderSummary } = require("./dist/apps/action/src/report.js");

// The same cap the crawler puts on a page (crawler rule 8).
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 200000;
const REQUEST_TIMEOUT_MS = 30000;

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();

function listFiles(root) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= MAX_FILES) return;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // Links out of the folder aren't followed.
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  walk(root, "");
  return found;
}

async function main() {
  const root = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), input("path"));
  if (input("path") === "" || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.log("::error title=Rotproof::`path` must be the folder your build writes the finished site to. Run this step after the build.");
    process.exitCode = 1;
    return;
  }
  const io = {
    files: () => listFiles(root),
    read: (file) => {
      const full = path.join(root, file);
      return fs.statSync(full).size > MAX_FILE_BYTES ? null : fs.readFileSync(full, "utf8");
    },
    request: async (method, url, headers, body) => {
      // Never followed anywhere else: the token goes to rotproof.dev and nowhere it points.
      const response = await fetch(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return { status: response.status, body: await response.text() };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
  const outcome = await run({ site: input("site"), token: input("token"), failOn: input("fail-on") }, io);
  for (const line of logLines(outcome)) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSummary(outcome));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `new-breaks=${outcome.newBreaks.length}\nin-build=${outcome.inBuild.length}\nmissing-pages=${missingCount(outcome)}\n`);
  if (outcome.failed) process.exitCode = 1;
}

main().catch((error) => {
  // The message only: a stack trace helps nobody reading a build log.
  console.log(`::error title=Rotproof::The link check stopped unexpectedly: ${String(error && error.message ? error.message : error).replace(/[\r\n%]/g, " ")}`);
  process.exitCode = 1;
});
