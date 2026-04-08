# FMS Frontend

Next.js (App Router) + Tauri. Offline-first. **Styling: Tailwind CSS v4.**

## Tailwind

- **Config:** `postcss.config.mjs` uses `@tailwindcss/postcss`. No `tailwind.config.js` (v4 uses CSS-first config).
- **Global CSS:** `app/globals.css` — `@import "tailwindcss"`, `@theme { }` for FMS design tokens, `@layer base` for resets and focus, `.animate-fade-in-up` for step transitions.
- **Usage:** Use Tailwind utility classes in components. For onboarding/login/dashboard dark screens, use explicit colors (e.g. `bg-[#1a1a1a]`, `text-white`, `[&_input]:bg-[#2d2d2d]`) to match the design.

## Structure

- **`core/`** — General, shared code used across the app.
  - **`contexts/`** — React context (e.g. `ThemeContext`).
  - **`layout/`** — Global layout components: `AppSidebar`, `AppTopBar`, `DashboardLayout`; `nav-config` and `icons` for sidebar nav.
  - **`styles/`** — Design tokens (`tokens.css`).
  - **`ui/`** — Reusable UI: Button, Input, ThemeToggle.

- **`modules/`** — Code specific to a page or screen.
  - **`auth/`** — Login: `components/LoginForm`, `pages/LoginPage`.
  - **`onboarding/`** — First-time setup:
    - **`types.ts`** — Onboarding state and storage key.
    - **`components/`** — UploadLogo, ProgressBar, BackButton.
    - **`steps/`** — StepLicense (license key validation), StepOrganization (name + logo), StepAccount (account details).
    - **`OnboardingPage.tsx`** — Three-step flow: License → Organization → Account; saves to `localStorage` and redirects to `/login` on finish.

- **`app/`** — Routes.
  - `/` — Onboarding (license → organization → account).
  - `/login` — Login.

## Design

- Tokens in `core/styles/tokens.css`; `data-theme="light" | "dark"` on `<html>`.
- Minimal, curved corners, light glassmorphism; theme toggle in core UI.

## Paths

- `@/core/*` — contexts, styles, ui.
- `@/modules/<module>/*` — auth, onboarding.
