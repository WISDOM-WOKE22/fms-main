"use client";

import { useState, useTransition } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@/core/ui";
import { toast } from "@/core/lib/toast";

export interface LoginFormProps {
  onSubmit?: (payload: { email: string; password: string }) => void | Promise<void>;
}

export default function LoginForm({ onSubmit }: LoginFormProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError(t("auth.pleaseEnterEmail"));
      return;
    }
    if (!password) {
      setError(t("auth.pleaseEnterPassword"));
      return;
    }
    startTransition(async () => {
      try {
        await onSubmit?.({ email: email.trim(), password });
      } catch (err) {
        const message = err instanceof Error ? err.message : t("toast.signInFailed");
        setError(message);
        toast.error(message);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 w-full" noValidate>
      <Input
        label={t("auth.email")}
        type="email"
        autoComplete="email"
        placeholder={t("auth.emailPlaceholder")}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={isPending}
        autoFocus
        className="[&_input]:bg-fms-bg-subtle [&_input]:border-fms-border [&_input]:text-fms-text [&_input]:rounded-2xl [&_label]:text-fms-text"
      />
      <Input
        label={t("auth.password")}
        type="password"
        autoComplete="current-password"
        placeholder={t("auth.passwordPlaceholder")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={isPending}
        error={error ?? undefined}
        className="[&_input]:bg-fms-bg-subtle [&_input]:border-fms-border [&_input]:text-fms-text [&_input]:rounded-2xl [&_label]:text-fms-text"
      />
      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={isPending}
        disabled={isPending}
        className="mt-2 !bg-fms-bg-subtle !text-fms-text hover:!bg-fms-surface-hover rounded-2xl"
      >
        {t("auth.signInButton")}
      </Button>
    </form>
  );
}
