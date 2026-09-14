import { cn } from "@/lib/utils";

type SectionHeaderProps = {
  title: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  className?: string;
};

/**
 * Row heading inside a panel. The action slot replaces the inline prose links the
 * old sidebar used ("Unlock above to change the drawing scale…").
 */
export function SectionHeader({ title, action, className }: SectionHeaderProps) {
  return (
    <div className={cn("flex items-center justify-between gap-2 py-0.5", className)}>
      <h3 className="text-[13px] font-semibold leading-[18px] text-foreground">{title}</h3>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          className="rounded-sm text-xs font-medium leading-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
