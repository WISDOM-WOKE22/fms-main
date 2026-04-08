/**
 * Copies @mediapipe runtime files from node_modules so they can be loaded as
 * plain <script> tags at runtime.
 *
 * Target directory (chosen only via env `TAURI_BUILD=1`, not by scanning disk):
 *   - Tauri static export (`build-tauri-frontend.js` sets TAURI_BUILD=1): `out/mediapipe/`
 *     Copied AFTER `next build` so large WASM binaries are not under `public/`
 *     during that build (avoids trace/memory spikes).
 *   - All other runs (incl. `pnpm dev` / `pnpm dev:webpack`): `public/mediapipe/`
 *     Served by `next dev` at `/mediapipe/…`.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

// Pick target: out/ only when packaging the static export (TAURI_BUILD=1).
// Do NOT key off `out/` existing — a leftover `out/` from an old build would
// send assets to the wrong place while `next dev` still serves `public/`.
const isTauriBuild = process.env.TAURI_BUILD === "1";
const targetBase = isTauriBuild ? "out" : "public";

const copies = [
  {
    src: "node_modules/@mediapipe/face_mesh",
    dest: `${targetBase}/mediapipe/face_mesh`,
    files: [
      "face_mesh.js",
      "face_mesh.binarypb",
      "face_mesh_solution_packed_assets.data",
      "face_mesh_solution_packed_assets_loader.js",
      "face_mesh_solution_simd_wasm_bin.data",
      "face_mesh_solution_simd_wasm_bin.js",
      "face_mesh_solution_simd_wasm_bin.wasm",
      "face_mesh_solution_wasm_bin.js",
      "face_mesh_solution_wasm_bin.wasm",
    ],
  },
  {
    src: "node_modules/@mediapipe/drawing_utils",
    dest: `${targetBase}/mediapipe/drawing_utils`,
    files: ["drawing_utils.js"],
  },
];

for (const { src, dest, files } of copies) {
  const destDir = path.join(root, dest);
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of files) {
    const from = path.join(root, src, file);
    const to = path.join(destDir, file);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, to);
    } else {
      console.warn(`[copy-mediapipe] missing: ${from}`);
    }
  }
}

console.log(`[copy-mediapipe] MediaPipe assets copied to ${targetBase}/mediapipe/`);
