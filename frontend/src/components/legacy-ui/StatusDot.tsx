type Status = "success" | "warning" | "error" | "neutral";

type Props = {
  status: Status;
  size?: "sm" | "md";
  label?: string;
};

const colorClasses: Record<Status, string> = {
  success: "bg-[var(--color-success)]",
  warning: "bg-[var(--color-warning)]",
  error: "bg-[var(--color-error)]",
  neutral: "bg-[var(--color-text-muted)]"
};

const sizeClasses = {
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5"
};

export function StatusDot({ status, size = "md", label }: Props) {
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span className={`inline-block shrink-0 rounded-full ${colorClasses[status]} ${sizeClasses[size]}`} />
      {label ? <span className="text-xs text-[var(--color-text-secondary)]">{label}</span> : null}
    </span>
  );
}
