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
  className,
  children
}: {
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
  /** Receives the generated id so the label points at the real control. */
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={id}
        className="text-[13px] font-medium leading-[18px] text-foreground"
      >
        {label}
        {required ? <span className="ml-0.5 text-muted-foreground">*</span> : null}
      </label>
      {children(id)}
      {hint ? <p className="text-xs leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
