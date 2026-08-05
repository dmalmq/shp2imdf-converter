import { type KeyboardEvent } from "react";

export type TabDefinition = {
  id: string;
  label: string;
};

type Props = {
  tabs: TabDefinition[];
  active: string;
  onChange: (id: string) => void;
  /** Prefix for the generated id / aria-controls pair. */
  idPrefix: string;
  className?: string;
};

const tabId = (idPrefix: string, id: string) => `${idPrefix}-tab-${id}`;
const panelId = (idPrefix: string, id: string) => `${idPrefix}-panel-${id}`;

/**
 * Props for a panel belonging to a {@link Tabs} strip.
 *
 * Every panel stays mounted and the inactive ones are `hidden`, which keeps
 * them out of the accessibility tree while preserving their local state —
 * these panels hold typed values that a remount would discard.
 */
export function tabPanelProps(idPrefix: string, id: string, active: boolean) {
  return {
    id: panelId(idPrefix, id),
    role: "tabpanel" as const,
    "aria-labelledby": tabId(idPrefix, id),
    hidden: !active
  };
}

/**
 * Tab strip following the ARIA tabs pattern: one tab stop for the whole strip,
 * with arrow keys moving between tabs (roving tabindex).
 */
export function Tabs({ tabs, active, onChange, idPrefix, className = "" }: Props) {
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === active)
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = tabs.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = activeIndex === last ? 0 : activeIndex + 1;
    else if (event.key === "ArrowLeft") next = activeIndex === 0 ? last : activeIndex - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next].id);
  };

  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className={`flex gap-1 border-b border-[var(--color-border)] ${className}`}
    >
      {tabs.map((tab, index) => {
        const selected = index === activeIndex;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, tab.id)}
            aria-selected={selected}
            aria-controls={panelId(idPrefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={[
              "-mb-px border-b-2 px-2 py-1.5 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
              "focus-visible:ring-[var(--color-primary)]",
              // The underline, not colour alone, carries the selected state.
              selected
                ? "border-[var(--color-primary)] text-[var(--color-text)]"
                : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            ].join(" ")}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
