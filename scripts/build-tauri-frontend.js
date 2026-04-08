#!/usr/bin/env node
/**
 * Build Next.js static export for Tauri (out/). Works on Windows and macOS/Linux.
 * Temporarily moves app/api aside so static export succeeds (no API routes in desktop bundle).
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const apiDir = path.join(root, "src", "app", "api");
const apiBak = path.join(root, "src", "app", "_api_tauri_bak");

console.log("Cleaning previous build...");
const nextDir = path.join(root, ".next");
const outDir = path.join(root, "out");
if (fs.existsSync(nextDir)) fs.rmSync(nextDir, { recursive: true });
if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true });

if (fs.existsSync(apiDir)) {
  console.log("Temporarily moving app/api aside for static export...");
  if (fs.existsSync(apiBak)) fs.rmSync(apiBak, { recursive: true });
  fs.renameSync(apiDir, apiBak);
}

console.log("Building static export (TAURI_BUILD=1)...");
const configuredHeapMb = Number(process.env.TAURI_FRONTEND_HEAP_MB || "2048");
const heapCandidates = [
  configuredHeapMb,
  2048,
  1536,
  1024,
].filter((v, i, arr) => Number.isFinite(v) && v > 0 && arr.indexOf(v) === i);

let status = 0;
let lastSignal = null;
try {
  for (const heapMb of heapCandidates) {
    const env = {
      ...process.env,
      TAURI_BUILD: "1",
      NODE_ENV: "production",
      // Keep heap configurable for constrained hosts; too-large heaps can trigger OS SIGKILL.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${heapMb}`].filter(Boolean).join(" "),
    };

    console.log(`Running next build with heap ${heapMb} MB...`);
    const r = spawnSync("pnpm", ["exec", "next", "build"], { stdio: "inherit", cwd: root, env });
    status = r.status ?? 1;
    lastSignal = r.signal ?? null;

    if (status === 0) break;
    if (lastSignal !== "SIGKILL") break;
    console.warn(`Build worker was SIGKILLed. Retrying with a smaller heap...`);
  }
} finally {
  if (fs.existsSync(apiBak)) {
    console.log("Restoring app/api...");
    fs.renameSync(apiBak, apiDir);
  }
}

if (status !== 0) {
  if (lastSignal === "SIGKILL") {
    console.error("Next.js build kept getting SIGKILL (likely memory pressure).");
    console.error("Try closing memory-heavy apps or setting TAURI_FRONTEND_HEAP_MB manually.");
  }
  process.exit(status);
}

// Copy MediaPipe runtime assets into out/ AFTER the Next.js build.
// They must NOT live in public/ because Next.js traces every file there during
// build, which inflates memory usage by ~200 MB for the WASM binaries.
console.log("Copying MediaPipe assets to out/mediapipe/...");
spawnSync("node", [path.join(__dirname, "copy-mediapipe.js")], { stdio: "inherit", cwd: root });

console.log("Frontend built to out/ (ready for Tauri bundle).");
