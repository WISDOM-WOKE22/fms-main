"use client";

export interface ProgressBarProps {
  currentStep: number;
  totalSteps: number;
  ariaLabel?: string;
}

export default function ProgressBar({ currentStep, totalSteps, ariaLabel }: ProgressBarProps) {
  const value = totalSteps > 0 ? ((currentStep - 1) / totalSteps) * 100 : 0;
  return (
    <div
      className="w-full"
      role="progressbar"
      aria-valuenow={currentStep}
      aria-valuemin={1}
      aria-valuemax={totalSteps}
      aria-label={ariaLabel ?? `Step ${currentStep} of ${totalSteps}`}
    >
      <div className="h-2 bg-fms-bg-subtle rounded-full overflow-hidden">
        <div
          className="h-full bg-fms-text rounded-full transition-all duration-300 ease-out"
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}
