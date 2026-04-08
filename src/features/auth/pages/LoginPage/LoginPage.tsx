"use client";

import { ThemeToggle } from "@/components/ThemeToggle";
import { LoginForm } from "@/features/auth/components/LoginForm";
import styles from "./LoginPage.module.css";

/**
 * Login page for FMS.
 * Handles offline auth; onSubmit can be wired to Tauri/backend later.
 */
export default function LoginPage() {
  const handleSubmit = async (payload: { username: string; password: string }) => {
    // Placeholder: wire to Tauri command or local auth when backend is ready.
    await new Promise((r) => setTimeout(r, 800));
    if (payload.username && payload.password) {
      // Success: e.g. router.push('/dashboard') or setSession()
      console.log("Login requested", payload);
    }
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.bg} aria-hidden />
      <header className={styles.header}>
        <ThemeToggle />
      </header>

      <main className={styles.main}>
        <section className={styles.card} role="main" aria-label="Sign in">
          <div className={styles.cardInner}>
            <div className={styles.brand}>
              <h1 className={styles.title}>FMS</h1>
              <p className={styles.subtitle}>
                Facility Management System
              </p>
            </div>
            <LoginForm onSubmit={handleSubmit} />
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span className={styles.footerText}>Offline • Secure • Private</span>
      </footer>
    </div>
  );
}
