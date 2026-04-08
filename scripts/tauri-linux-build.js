#!/usr/bin/env node
const { spawnSync } = require("child_process");

const target = process.argv[2];
const isLinuxHost = process.platform === "linux";
const allowCrossFromNonLinux = process.env.ALLOW_NON_LINUX_TAURI_CROSS === "1";
const useDockerLinuxBuild = process.env.USE_DOCKER_LINUX_BUILD === "1";

if (!isLinuxHost && !allowCrossFromNonLinux && useDockerLinuxBuild) {
  const dockerCheck = spawnSync("docker", ["--version"], { stdio: "ignore" });
  if (dockerCheck.status === 0) {
    console.warn(`Non-Linux host detected (${process.platform}); using Docker Linux builder fallback.`);
    const dockerTarget = target || "x86_64-unknown-linux-gnu";
    const cwd = process.cwd();
    const dockerArgs = [
      "run",
      "--rm",
      "-t",
      "-v",
      `${cwd}:/workspace`,
      "-w",
      "/workspace",
      "ghcr.io/tauri-apps/tauri:latest",
      "bash",
      "-lc",
      [
        "corepack enable",
        "pnpm install --frozen-lockfile",
        "pnpm db:migrate:prod",
        "node scripts/generate-build-config.js",
        `node scripts/download-ffmpeg.js ${dockerTarget}`,
        `CI=true pnpm tauri build --target ${dockerTarget} --bundles appimage,deb`,
      ].join(" && "),
    ];
    const dockerResult = spawnSync("docker", dockerArgs, { stdio: "inherit" });
    process.exit(dockerResult.status ?? 1);
  }

  console.error(
    [
      `Linux bundling target${target ? ` (${target})` : ""} was requested on ${process.platform}.`,
      "Tauri Linux bundles require Linux system libraries (GTK/WebKit) and pkg-config sysroot support.",
      "Docker fallback was not available. Use a Linux machine/CI runner for Linux bundles.",
      "If you intentionally set up a full cross-compile sysroot, rerun with ALLOW_NON_LINUX_TAURI_CROSS=1.",
    ].join("\n"),
  );
  process.exit(1);
}

if (!isLinuxHost && !allowCrossFromNonLinux) {
  console.warn(
    [
      `Linux bundling target${target ? ` (${target})` : ""} was requested on ${process.platform}.`,
      "Skipping Linux bundle on non-Linux host.",
      "Use a Linux machine/CI runner for Linux bundles (no Docker required).",
      "Optional: set USE_DOCKER_LINUX_BUILD=1 only if you explicitly want Docker fallback.",
      "If you intentionally set up a full cross-compile sysroot, rerun with ALLOW_NON_LINUX_TAURI_CROSS=1.",
    ].join("\n"),
  );
  process.exit(0);
}

const args = ["tauri", "build"];
if (target) {
  args.push("--target", target);
}

if (isLinuxHost) {
  args.push("--bundles", "appimage,deb");
} else if (allowCrossFromNonLinux) {
  console.warn(`Non-Linux host detected (${process.platform}); attempting cross-compile mode by override.`);
}

const result = spawnSync("pnpm", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
