"use client";

import { useState, useTransition } from "react";
import { Button, Input } from "@/components/ui";
import styles from "./LoginForm.module.css";

export interface LoginFormProps {
  onSubmit?: (payload: { username: string; password: string }) => void | Promise<void>;
}

export default function LoginForm({ onSubmit }: LoginFormProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!username.trim()) {
      setError("Please enter your username.");
      return;
    }
    if (!password) {
      setError("Please enter your password.");
      return;
    }

    startTransition(async () => {
      try {
        await onSubmit?.({ username: username.trim(), password });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign in failed. Please try again.");
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className={styles.form} noValidate>
      <Input
        label="Username"
        type="text"
        autoComplete="username"
        placeholder="Enter your username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        disabled={isPending}
        autoFocus
      />
      <Input
        label="Password"
        type="password"
        autoComplete="current-password"
        placeholder="Enter your password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={isPending}
        error={error ?? undefined}
      />
      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={isPending}
        disabled={isPending}
        className={styles.submit}
      >
        Sign in
      </Button>
    </form>
  );
}
