import { Check } from "lucide-react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import { cn } from "@/lib/utils";


export type SectionDef = {
  id: string;
  labelEn: string;
  labelJa: string;
  valid: boolean;
  hidden?: boolean;
  children?: SectionDef[];
};

type Props = {
  sections: SectionDef[];
  activeSection: string;
  onSelect: (id: string) => void;
};

/**
 * Done, or not yet.
 *
 * Both states used to be a filled dot — green against amber — so an untouched
 * wizard showed a column of amber that reads as a column of warnings. Only
 * "done" is now a positive mark; not-yet is an empty ring.
 */
function SectionMark({ valid, active }: { valid: boolean; active: boolean }) {
  if (valid) {
    return (
      <Check
        className={cn("h-3.5 w-3.5 shrink-0", active ? "text-primary-foreground" : "text-success")}
        strokeWidth={3}
      />
    );
  }
  return (
    <span
      className={cn(
        "h-3 w-3 shrink-0 rounded-full border",
        active ? "border-primary-foreground/50" : "border-muted-foreground/40"
      )}
    />
  );
}


export function SectionNav({ sections, activeSection, onSelect }: Props) {
  const { t } = useUiLanguage();

  const visibleSections = sections.filter((s) => !s.hidden);
  const doneCount = visibleSections.filter((s) => s.valid).length;

  // The rail is the only navigation on this screen, so it has to stay reachable
  // once the form runs past a screenful. `self-start` also stops the grid
  // stretching the card to the height of the tallest section.
  return (
    <nav className="sticky top-0 w-full self-start rounded-lg border border-border bg-card p-3">
      <div className="mb-3 flex items-baseline justify-between gap-2 px-1">
        <h2 className="font-mono text-[10px] font-medium uppercase leading-[13px] tracking-[0.06em] text-muted-foreground">
          {t("Sections", "セクション")}
        </h2>
        {/* How far along the whole wizard is — the rail showed per-section
            state but never the total, so "am I nearly done" needed counting. */}
        <span className="font-mono text-[11px] leading-[14px] tracking-[0.02em] text-muted-foreground">
          {doneCount} / {visibleSections.length}
        </span>
      </div>
      <ol className="space-y-0.5">
        {visibleSections.map((section) => {
          const isActive = activeSection === section.id;
          const hasActiveChild = section.children?.some((c) => activeSection === c.id);
          const expanded = isActive || hasActiveChild;

          return (
            <li key={section.id}>
              <button
                type="button"
                onClick={() => onSelect(section.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] leading-[18px] transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-primary font-medium text-primary-foreground"
                    : "text-foreground hover:bg-muted"
                )}
              >
                <SectionMark valid={section.valid} active={isActive} />
                <span className="flex-1 truncate">{t(section.labelEn, section.labelJa)}</span>
              </button>

              {/* Sub-sections */}
              {section.children && expanded ? (
                <ol className="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-2">
                  {section.children
                    .filter((c) => !c.hidden)
                    .map((child) => {
                      const childActive = activeSection === child.id;
                      return (
                        <li key={child.id}>
                          <button
                            type="button"
                            onClick={() => onSelect(child.id)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs leading-4 transition-colors",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              childActive
                                ? "bg-accent font-medium text-foreground"
                                : "text-muted-foreground hover:bg-muted"
                            )}
                          >
                            <SectionMark valid={child.valid} active={false} />
                            <span className="flex-1 truncate">{t(child.labelEn, child.labelJa)}</span>
                          </button>
                        </li>
                      );
                    })}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
