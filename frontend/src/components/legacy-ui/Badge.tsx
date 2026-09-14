type Variant = "default" | "primary" | "success" | "warning" | "error";

type Props = {
  variant?: Variant;
  children: React.ReactNode;
  className?: string;
};

const variantClasses: Record<Variant, string> = {
  default: "bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] border-[var(--color-border)]",
  primary: "bg-[var(--color-primary-muted)] text-[var(--color-primary)] border-[var(--color-primary)]/20",
  success: "bg-[var(--color-success-muted)] text-[var(--color-success)] border-[var(--color-success)]/20",
  warning: "bg-[var(--color-warning-muted)] text-[var(--color-warning)] border-[var(--color-warning)]/20",
  error: "bg-[var(--color-error-muted)] text-[var(--color-error)] border-[var(--color-error)]/20"
};

export function Badge({ variant = "default", children, className = "" }: Props) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[11px] font-medium leading-none",
        variantClasses[variant],
        className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}
