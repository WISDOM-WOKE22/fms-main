/**
 * Onboarding state — license is required; org & account come from server/env.
 * Legacy optional fields kept for StepOrganization/StepAccount (unused in current flow).
 */

export interface OnboardingData {
  /** Step 1: License */
  licenseKey: string;
  /** Legacy step 2 (unused) */
  organizationName?: string;
  logoUrl?: string | null;
  /** Legacy step 3 (unused) */
  firstName?: string;
  lastName?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
}

export const defaultOnboardingData: OnboardingData = {
  licenseKey: "",
};

/** @deprecated No longer persisted; app config comes from API /api/v1/config */
export const ONBOARDING_STORAGE_KEY = "fms-onboarding";
