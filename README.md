# FMS Desktop — Facility Management System

FMS Desktop is a cross-platform **Tauri 2** application that bundles a **Next.js 15** (App Router) UI with an **in-process Rust HTTP API** (Axum) and a **local Python AI service** for face recognition, camera frame handling, and related ML workloads. Data is stored locally in **SQLite**.

This repository is the **desktop product**: one installer contains the UI, the Rust backend, bundled AI assets, and (on supported platforms) **FFmpeg** for streaming features.

---

## Architecture at a glance

```text
┌─────────────────────────────────────────────────────────────┐
│  Next.js UI (static export in production → out/)            │
│  Loaded in WebView (Tauri)                                   │
└──────────────────────────┬──────────────────────────────────┘
                           │  HTTP (127.0.0.1:<dynamic port>)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Rust / Axum API  (src-tauri/src/api/)                       │
│  SQLite (rusqlite), migrations, business routes             │
└──────────────────────────┬──────────────────────────────────┘
                           │  HTTP (127.0.0.1, default :8000)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Python “local AI” service  (src-tauri/resources/ai-python) │
│  FastAPI + InsightFace, optional YOLO / MediaPipe, etc.    │
│  Auto-started by the host when FMS_LOCAL_AI_URL is localhost  │
└─────────────────────────────────────────────────────────────┘
```

- **Dynamic API port**: the desktop UI resolves the Rust API base URL via Tauri’s `get_api_port` command (`src/core/api/baseUrl.ts`). In production WebView contexts, requests may go through `@tauri-apps/plugin-http` to satisfy CSP.
- **`NEXT_PUBLIC_API_URL`**: used when you run the **web frontend only** against a separate backend (for example during full-stack web development). It is **not** the primary path for the packaged desktop app, which talks to the embedded Rust server.

---

## Technology stack

| Layer | Technology | Notes |
|--------|------------|--------|
| Desktop shell | **Tauri 2** | Windows, macOS, Linux targets |
| UI | **Next.js 15**, **React 19**, **TypeScript** | App Router; **Tailwind CSS v4** |
| Desktop API | **Rust**, **Axum**, **Tokio** | Same JSON routes as documented in `src-tauri/src/api/mod.rs` |
| Database | **SQLite** via **rusqlite** (+ **Prisma** for schema/migrations) | Prisma lives under `prisma/` |
| Local AI | **Python 3** + **FastAPI** / **uvicorn** | Sources in `src-tauri/resources/ai-python/` |
| Media | **FFmpeg** (sidecar) | Downloaded/placed via `scripts/download-ffmpeg.js`; referenced in `tauri.conf.json` as `externalBin` |
| Package manager | **pnpm** | Lockfile: `pnpm-lock.yaml` |

Recommended editors/extensions: **VS Code** + **rust-analyzer** + **Tauri** extension.

---

## Repository layout (desktop-relevant)

```text
FMS-main/
├── README.md                 ← This file (project overview & setup)
├── package.json              ← pnpm scripts (dev, build, Tauri, DB)
├── pnpm-lock.yaml
├── next.config.mjs           ← Static export when TAURI_BUILD=1 → out/
├── prisma/                   ← Schema & SQL migrations (used with pnpm db:*)
├── scripts/                  ← build-tauri-frontend, ffmpeg, build config, mediapipe copy
├── src/                      ← Next.js app + modules (see src/README.md for UI structure)
│   ├── app/                  ← Routes (App Router)
│   ├── core/                 ← Shared UI, API helpers, Tauri detection, stores
│   └── modules/              ← Feature areas (auth, employees, settings, …)
├── src-tauri/                ← Rust crate + Tauri config + native resources
│   ├── src/
│   │   ├── lib.rs            ← App entry: config, DB init, local AI bootstrap, API thread
│   │   └── api/              ← Axum routes, handlers, RTSP/camera/face logic
│   ├── tauri.conf.json       ← Window, CSP, bundle resources, FFmpeg external bin
│   ├── resources/
│   │   ├── config.json       ← Generated at build from .env (see below)
│   │   └── ai-python/        ← Bundled AI service (subset also listed in tauri.conf)
│   └── bin/                  ← Platform-specific ffmpeg binaries (from download script)
└── out/                      ← Produced by `pnpm build:tauri:frontend` (Tauri frontendDist)
```

More detail on **frontend folder conventions** (Tailwind, `core/` vs `modules/`) is in [`src/README.md`](src/README.md).

The **Python AI service** (running locally, endpoints like `/health`, `/recognize/json`) is documented in [`src-tauri/resources/ai-python/README.md`](src-tauri/resources/ai-python/README.md) and [`PIPELINE.md`](src-tauri/resources/ai-python/PIPELINE.md).

---

## Prerequisites

- **Node.js** (LTS recommended) and **pnpm** (`corepack enable` or install pnpm globally).
- **Rust** toolchain (stable), **Cargo**, and Tauri’s system dependencies for your OS ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).
- **Python 3** on the machine where the app runs, with a normal `python` or `py` launcher on **Windows** (the host creates a venv under the app data directory and installs from `requirements.txt`). Use a **supported** version for scientific wheels (typically **3.10–3.12**); very new Python releases may lack binary packages for some dependencies.
- For **streaming / HLS** features: FFmpeg is fetched by project scripts into `src-tauri/bin/` as part of the Tauri workflow.

---

## Configuration

1. Copy **`.env.example`** to **`.env`** in the project root and adjust values (email, password, license, backend URL, etc.).
2. **`scripts/generate-build-config.js`** reads `.env` and writes **`src-tauri/resources/config.json`**, which the Rust app loads at startup (along with optional overrides from environment variables).

Important variables (non-exhaustive; see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `FMS_EMAIL`, `FMS_PASSWORD` | Default sign-in for the desktop app |
| `FMS_LICENSE_KEY`, `FMS_MAIN_BACKEND_URL`, `FMS_LICENSE_*` | Licensing and cloud verification |
| `FMS_LOCAL_AI_URL` | Base URL for the Python AI service; `http://127.0.0.1:8000` (or with port) triggers **auto-start** of the bundled AI from localhost |
| `FMS_ENV`, `FMS_ALLOW_DEV_LICENSE_FALLBACK` | Environment and dev-only license behavior |

For **web-only** development against an external API, set `NEXT_PUBLIC_API_URL` in `.env` as described in `.env.example`.

---

## Development workflow

Install dependencies from the **`FMS-main`** root:

```bash
pnpm install
```

### Run the desktop app in dev mode

The Tauri config uses `beforeDevCommand: pnpm dev:webpack` and `devUrl: http://localhost:3000`. From the repo root:

```bash
pnpm tauri dev
```

This wrapper runs FFmpeg download (if needed), regenerates `resources/config.json` from `.env`, then starts Tauri (which starts the Next dev server and the Rust backend).

### Run the web UI only (no Tauri)

Useful for faster UI iteration when you do not need the embedded Rust API:

```bash
pnpm dev
```

Uses Turbopack by default; **`pnpm dev:webpack`** is what Tauri’s dev command uses.

### Database (Prisma)

SQLite schema and migrations live under **`prisma/`**. Typical commands:

```bash
pnpm db:migrate      # development migrations
pnpm db:studio       # optional GUI
```

The **`build:app`** scripts run **`pnpm db:migrate:prod`** (`prisma migrate deploy`) before packaging.

---

## Production / installer builds

Frontend for Tauri is a **static export** to **`out/`**, driven by `TAURI_BUILD=1` via `scripts/build-tauri-frontend.js` (Next `output: "export"`). That script temporarily moves `src/app/api` aside so export succeeds.

**Generic desktop build** (from `FMS-main`):

```bash
pnpm build:app
```

**macOS DMG** (example):

```bash
pnpm build:app:dmg
```

**Windows** (cross-compile setup; see script and your CI/local toolchain):

```bash
pnpm build:app:windows
```

These pipelines run migrations, regenerate build config, download/platform-place FFmpeg where applicable, then invoke `tauri build`.

---

## Local AI service (face recognition & cameras)

- **Bundled code**: `src-tauri/resources/ai-python/` (also partially mirrored in `tauri.conf.json` → `bundle.resources`).
- **Runtime**: On startup, if `FMS_LOCAL_AI_URL` points at **localhost**, the Rust host can create a venv, `pip install -r requirements.txt`, and start **uvicorn** for `ai_service:app`.
- **Logs / data**: Face DB and related files are directed under the application data directory (see Rust `FMS_AI_DATA_DIR` usage); an **`ai-service.log`** file is written there for troubleshooting when no console is visible (e.g. Windows release builds).
- **Manual run** (debugging): see [`src-tauri/resources/ai-python/README.md`](src-tauri/resources/ai-python/README.md).

If face endpoints return **503**, the Rust API cannot reach the Python service: verify Python is installed, pip/network access works on first run, and read the AI log file for import or install errors.

---

## Useful scripts (summary)

| Script | Role |
|--------|------|
| `pnpm tauri dev` | Desktop dev (via wrapper: ffmpeg + config + Tauri) |
| `pnpm build:tauri:frontend` | Static Next export → `out/` for Tauri |
| `pnpm build:app` | Full desktop bundle pipeline |
| `pnpm download:ffmpeg` | Fetch FFmpeg sidecar for current platform |
| `node scripts/generate-build-config.js` | `.env` → `src-tauri/resources/config.json` |

---

## Contributing / code style

- Match existing **TypeScript** and **Rust** patterns in the touched areas; keep changes scoped to the task.
- Frontend structure and Tailwind v4 notes: [`src/README.md`](src/README.md).
- After substantive Rust changes, run **`cargo clippy`** / **`cargo test`** from `src-tauri` as appropriate for your environment.

---

## License / product

Product metadata and bundle identifiers are configured in **`src-tauri/tauri.conf.json`** (`productName`, `identifier`). Add or link your license file here if you publish the repo publicly.
