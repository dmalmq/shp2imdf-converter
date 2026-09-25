import { Check } from "lucide-react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { SectionId, SetUpSection } from "../../lib/setUp";
import { cn } from "@/lib/utils";

type Props = {
  sections: SetUpSection[];
  activeSection: SectionId;
  onSelect: (id: SectionId) => void;
};

/** Done is an ink check, not yet is a hollow ring: nothing on the rail reads as a warning. */
function SectionMark({ done }: { done: boolean }) {
  return done ? (
    <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-foreground" strokeWidth={2.5} />
  ) : (
    <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full border-[1.5px] border-muted-foreground/60" />
  );
}

export function SectionNav({ sections, activeSection, onSelect }: Props) {
  const { t } = useUiLanguage();
  const visible = sections.filter((section) => !section.hidden);
  const done = visible.filter((section) => section.done).length;

  const item = (section: SetUpSection, child: boolean) => {
    const active = activeSection === section.id;
    return (
      <li key={section.id}>
        <button
          type="button"
          aria-current={active ? "step" : undefined}
          onClick={() => onSelect(section.id)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md text-left transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            child ? "py-1.5 pl-7 pr-2.5 text-[13px]" : "px-2.5 py-2 text-sm",
            active ? "bg-muted font-medium text-foreground" : "text-foreground hover:bg-muted/60",
            child && !active && !section.done && "text-muted-foreground"
          )}
        >
          <SectionMark done={section.done} />
          <span className="flex-1 truncate">{t(section.label.en, section.label.ja)}</span>
        </button>
      </li>
    );
  };

  return (
    <nav
      aria-label={t("Sections", "セクション")}
      className="flex w-[264px] shrink-0 flex-col gap-3 overflow-auto border-r border-border bg-card px-4 py-5"
    >
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {t("Sections", "セクション")}
        </h2>
        <span className="font-mono text-[11px] text-muted-foreground">
          {t(`${done} of ${visible.length} done`, `${visible.length} 件中 ${done} 件完了`)}
        </span>
      </div>
      <ol className="flex flex-col gap-0.5">
        {visible.map((section) => {
          const children = section.children?.filter((child) => !child.hidden) ?? [];
          const open = activeSection === section.id || children.some((child) => child.id === activeSection);
          return [
            item(section, false),
            ...(open ? children.map((child) => item(child, true)) : [])
          ];
        })}
      </ol>
    </nav>
  );
}
