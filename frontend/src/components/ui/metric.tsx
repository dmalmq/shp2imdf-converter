import * as React from "react";

import { cn } from "@/lib/utils";

type MetricProps = {
  label: string;
  value: React.ReactNode;
  className?: string;
};

/**
 * Technical read-out: a mono micro-label over its value. Carries scale, rotation,
 * CRS, feature counts — the numbers that used to be buried in sentences.
 */
export function Metric({ label, value, className }: MetricProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <span className="truncate font-mono text-[11px] uppercase leading-[14px] tracking-[0.04em] text-muted-foreground">
        {label}
      </span>
      <span className="truncate text-sm font-medium leading-5 text-foreground">{value}</span>
    </div>
  );
}
