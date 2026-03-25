import { type InputHTMLAttributes, forwardRef } from "react";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
};

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ label, error, className = "", id, ...rest }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

    return (
      <div className="grid gap-1 text-sm">
        {label ? (
          <label htmlFor={inputId} className="font-medium text-[var(--color-text-secondary)]">
            {label}
          </label>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          className={[
            "h-9 w-full rounded-[var(--radius-md)] border px-2.5 text-sm",
            "transition-colors placeholder:text-[var(--color-text-muted)]",
            "focus:outline-none focus:ring-2 focus:ring-offset-0",
            error
              ? "border-[var(--color-error)] focus:ring-[var(--color-error)]/20"
              : "border-[var(--color-border)] focus:border-[var(--color-primary)] focus:ring-[var(--color-primary)]/20",
            className
          ]
            .filter(Boolean)
            .join(" ")}
          {...rest}
        />
        {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
      </div>
    );
  }
);

Input.displayName = "Input";
