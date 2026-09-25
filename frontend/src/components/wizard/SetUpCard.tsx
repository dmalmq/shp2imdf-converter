import type { ReactNode } from "react";

/** A titled card of the Set up stage. */
export function SetUpCard({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-[14px] border border-border bg-card p-5">
      <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
      {intro ? <p className="mt-1 text-[13px] leading-[18px] text-muted-foreground">{intro}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}
