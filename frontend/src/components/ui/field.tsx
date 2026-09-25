import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * Label over control, the same way every time.
 *
 * The wizard and the review properties panel had fifty hand-rolled
 * `<label><span/><input class="rounded border px-2 py-1.5"/></label>` blocks
 * between them, which is how the required marker, the label colour and the
 * control height drifted apart from screen to screen.
 */
export function Field({
  label,
  required,
  hint,
  code,
  className,
  children
}: {
  label: string;
  required?: boolean;
  hint?: string;
  /** The value as IMDF writes it, under a control that shows it in words. */
  code?: string | null;
  className?: string;
  /** Receives the generated id so the label points at the real control. */
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[13px] font-medium leading-[18px] text-foreground">
        <label htmlFor={id}>{label}</label>
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-muted-foreground">
            *
          </span>
        ) : null}
      </span>
      {children(id)}
      {code ? <p className="font-mono text-[11px] leading-[14px] text-muted-foreground">{code}</p> : null}
      {hint ? <p className="text-xs leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
