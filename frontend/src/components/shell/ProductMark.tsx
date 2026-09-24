import { cn } from "@/lib/utils";

/**
 * Concept A's mark (Figma 118:13): a 22 px pine square with its lower-right
 * quarter cut away. The cut is left transparent rather than painted paper, so
 * it takes whatever the bar behind it is in either theme.
 */
export function ProductMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 22 22"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0 text-primary", className)}
    >
      <path d="M2 0h18a2 2 0 0 1 2 2v9H11v11H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2Z" fill="currentColor" />
    </svg>
  );
}
