import { cn } from "@/lib/utils";

type Status = "success" | "warning" | "error" | "neutral";

type Props = {
  status: Status;
  size?: "sm" | "md";
  label?: string;
  className?: string;
};

const colorClasses: Record<Status, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  neutral: "bg-muted-foreground"
};

const sizeClasses = { sm: "h-2 w-2", md: "h-2.5 w-2.5" };

/**
 * Status and confidence indicator.
 *
 * The label has to say what the state MEANS. The old confidence dot rendered the
 * literal colour name — "green" / "yellow" / "red" — which tells the reader
 * nothing they cannot already see, and nothing at all without colour vision.
 */
export function StatusDot({ status, size = "md", label, className }: Props) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} title={label}>
      <span className={cn("inline-block shrink-0 rounded-full", colorClasses[status], sizeClasses[size])} />
      {label ? <span className="text-xs leading-4 text-muted-foreground">{label}</span> : null}
    </span>
  );
}
