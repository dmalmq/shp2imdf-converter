import { type SelectHTMLAttributes, forwardRef } from "react";

type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
};

export const Select = forwardRef<HTMLSelectElement, Props>(
  ({ label, className = "", id, children, ...rest }, ref) => {
    const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

    return (
      <div className="grid gap-1 text-sm">
        {label ? (
          <label htmlFor={selectId} className="font-medium text-[var(--color-text-secondary)]">
            {label}
          </label>
        ) : null}
        <select
          ref={ref}
          id={selectId}
          className={[
            "h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm",
            "transition-colors",
            "focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:ring-offset-0",
            className
          ]
            .filter(Boolean)
            .join(" ")}
          {...rest}
        >
          {children}
        </select>
      </div>
    );
  }
);

Select.displayName = "Select";
