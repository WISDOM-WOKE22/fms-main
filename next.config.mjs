const isProd = process.env.NODE_ENV === "production";
const internalHost = process.env.TAURI_DEV_HOST || "localhost";
const isTauriBuild = process.env.TAURI_BUILD === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // When TAURI_BUILD=1 (scripts/build-tauri-frontend.sh), static export to out/ for Tauri. API routes are moved aside for that build.
  ...(isTauriBuild
    ? {
        output: "export",
        // Trailing slashes so paths like /employees/123 become /employees/123/ and the asset protocol
        // can fall back to index.html when employees/123/index.html doesn't exist (SPA routing).
        trailingSlash: true,
      }
    : {}),
  images: {
    unoptimized: true,
  },
  // Tauri bundle: no asset prefix so all paths are relative (asset protocol serves from $RESOURCE)
  assetPrefix: isTauriBuild ? "" : (isProd ? undefined : `http://${internalHost}:3000`),

  // Reduce build memory footprint on constrained machines (8 GB RAM).
  // Next.js 15 strips --max-old-space-size from build workers (isolatedMemory),
  // so we limit worker count instead to stay within OS memory limits.
  experimental: {
    workerThreads: false,
    cpus: 1,
    memoryBasedWorkersCount: true,
  },
};

export default nextConfig;
