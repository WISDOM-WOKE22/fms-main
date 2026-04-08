#!/usr/bin/env node
/**
 * Download a static FFmpeg binary for the current platform.
 *
 * Places it at  src-tauri/bin/ffmpeg-<target-triple>[.exe]
 * so Tauri's `externalBin` can bundle it with the app.
 *
 * Run:  node scripts/download-ffmpeg.js
 *
 * Sources:
 *   macOS/Linux : https://github.com/BtbN/FFmpeg-Builds (GPL static)
 *   Windows     : https://github.com/BtbN/FFmpeg-Builds (GPL static)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

// ── Target triple mapping ──────────────────────────────────────────

function getTargetTriple() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

// ── Download URLs ──────────────────────────────────────────────────

// We use BtbN auto-builds for Linux/Windows and evermeet.cx for macOS
// (BtbN does not provide macOS builds)
function getDownloadInfo(triple) {
  switch (triple) {
    case "aarch64-apple-darwin":
    case "x86_64-apple-darwin":
      // evermeet.cx provides universal macOS builds
      return {
        url: "https://evermeet.cx/ffmpeg/getrelease/zip",
        type: "zip",
        binaryInsidePath: "ffmpeg", // zip contains just the binary
      };

    case "x86_64-unknown-linux-gnu":
      return {
        url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
        type: "tar.xz",
        binaryInsidePath: "*/ffmpeg",
      };

    case "aarch64-unknown-linux-gnu":
      return {
        url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz",
        type: "tar.xz",
        binaryInsidePath: "*/ffmpeg",
      };

    case "x86_64-pc-windows-msvc":
      return {
        url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
        type: "zip",
        binaryInsidePath: "*/bin/ffmpeg.exe",
      };

    default:
      throw new Error(`No ffmpeg download URL for ${triple}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function downloadFile(url, destPath) {
  console.log(`  Downloading: ${url}`);
  // Use curl for reliable large downloads (handles redirects, retries, resume)
  execSync(
    `curl -fSL --retry 3 --retry-delay 5 -C - --progress-bar -o "${destPath}" "${url}"`,
    { stdio: "inherit", timeout: 600_000 },
  );
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  // Allow overriding the target triple for cross-compilation builds.
  // Tauri sets TAURI_ENV_TARGET_TRIPLE during `tauri build --target …`,
  // and the script can also be invoked with a CLI argument:
  //   node scripts/download-ffmpeg.js x86_64-pc-windows-msvc
  // Find first positional arg (not a flag starting with --)
  const positionalArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const triple =
    positionalArgs[0] ||
    process.env.TAURI_ENV_TARGET_TRIPLE ||
    getTargetTriple();

  // When cross-compiling (e.g. Windows target on macOS), the download can be
  // very large and may fail.  Skip silently if --optional flag is passed;
  // the caller (build:app:windows) should have already run this explicitly.
  const isOptional = process.argv.includes("--optional");

  const isWindows = triple.includes("windows");
  const ext = isWindows ? ".exe" : "";

  const binDir = path.join(__dirname, "..", "src-tauri", "bin");
  const destBinary = path.join(binDir, `ffmpeg-${triple}${ext}`);

  // Skip if already downloaded
  if (fs.existsSync(destBinary)) {
    const stat = fs.statSync(destBinary);
    if (stat.size > 1_000_000) {
      console.log(`✓ FFmpeg already exists at ${destBinary} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
      return;
    }
  }

  fs.mkdirSync(binDir, { recursive: true });

  const info = getDownloadInfo(triple);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-dl-"));
  const archiveName = `ffmpeg-archive${info.type === "zip" ? ".zip" : ".tar.xz"}`;
  const archivePath = path.join(tmpDir, archiveName);

  try {
    console.log(`Downloading FFmpeg for ${triple}...`);
    await downloadFile(info.url, archivePath);

    console.log("Extracting...");

    if (info.type === "zip") {
      execSync(`unzip -o -j "${archivePath}" "${info.binaryInsidePath}" -d "${tmpDir}"`, {
        stdio: "pipe",
      });
      // Find the binary
      const extracted = isWindows ? path.join(tmpDir, "ffmpeg.exe") : path.join(tmpDir, "ffmpeg");
      if (!fs.existsSync(extracted)) {
        // Try finding it with glob-like approach
        const files = fs.readdirSync(tmpDir);
        const ffmpegFile = files.find(f => f === "ffmpeg" || f === "ffmpeg.exe");
        if (!ffmpegFile) {
          // For windows zip with nested dirs, use a different extraction
          execSync(`unzip -o "${archivePath}" -d "${tmpDir}"`, { stdio: "pipe" });
          // Find ffmpeg.exe recursively
          const found = execSync(`find "${tmpDir}" -name "ffmpeg${ext}" -type f`, { encoding: "utf8" }).trim().split("\n")[0];
          if (found) {
            fs.copyFileSync(found, destBinary);
          } else {
            throw new Error("Could not find ffmpeg binary in archive");
          }
        } else {
          fs.copyFileSync(path.join(tmpDir, ffmpegFile), destBinary);
        }
      } else {
        fs.copyFileSync(extracted, destBinary);
      }
    } else if (info.type === "tar.xz") {
      execSync(`tar -xf "${archivePath}" -C "${tmpDir}"`, { stdio: "pipe" });
      // Find ffmpeg in extracted dir
      const found = execSync(`find "${tmpDir}" -name "ffmpeg" -type f -not -name "*.txt"`, {
        encoding: "utf8",
      })
        .trim()
        .split("\n")[0];
      if (!found) throw new Error("Could not find ffmpeg binary in archive");
      fs.copyFileSync(found, destBinary);
    }

    // Make executable
    if (!isWindows) {
      fs.chmodSync(destBinary, 0o755);
    }

    const size = fs.statSync(destBinary).size;
    console.log(`✓ FFmpeg installed: ${destBinary} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  const optional = process.argv.includes("--optional");
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const triple = positional[0] || "";
  const isCrossCompile = triple && triple !== getTargetTriple();

  if (optional) {
    console.warn(`Warning: FFmpeg download failed (optional): ${err.message}`);
    console.warn("The binary can be downloaded manually before building.");
  } else if (isCrossCompile) {
    // For cross-compilation, create a placeholder so Tauri's resource check
    // passes.  The real ffmpeg must be placed before distributing the app.
    const isWin = triple.includes("windows");
    const ext = isWin ? ".exe" : "";
    const binDir = path.join(__dirname, "..", "src-tauri", "bin");
    const dest = path.join(binDir, `ffmpeg-${triple}${ext}`);
    if (!fs.existsSync(dest) || fs.statSync(dest).size < 1_000_000) {
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(dest, "PLACEHOLDER: replace with real ffmpeg binary before distribution\n");
      if (!isWin) fs.chmodSync(dest, 0o755);
      console.warn(`⚠ FFmpeg download failed for cross-target ${triple}: ${err.message}`);
      console.warn(`  Created placeholder at ${dest}`);
      console.warn("  Replace with real ffmpeg binary before distributing the app!");
    }
  } else {
    console.error("Error downloading FFmpeg:", err.message);
    process.exit(1);
  }
});
