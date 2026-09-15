import { useUiLanguage } from "../../hooks/useUiLanguage";
import { StatusDot } from "../ui";


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


export function SectionNav({ sections, activeSection, onSelect }: Props) {
  const { t } = useUiLanguage();

  const visibleSections = sections.filter((s) => !s.hidden);

  return (
    <nav className="w-full rounded-lg border border-border bg-card p-3 shadow-sm">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("Sections", "セクション")}
      </h2>
      <ol className="space-y-1">
        {visibleSections.map((section) => {
          const isActive = activeSection === section.id;
          const hasActiveChild = section.children?.some((c) => activeSection === c.id);
          const expanded = isActive || hasActiveChild;

          return (
            <li key={section.id}>
              <button
                type="button"
                onClick={() => onSelect(section.id)}
                className={[
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-foreground hover:bg-muted"
                ].join(" ")}
              >
                <StatusDot
                  status={section.valid ? "success" : "warning"}
                  size="sm"
                />
                <span className="flex-1 truncate">{t(section.labelEn, section.labelJa)}</span>
              </button>

              {/* Sub-sections */}
              {section.children && expanded ? (
                <ol className="ml-5 mt-1 space-y-0.5">
                  {section.children
                    .filter((c) => !c.hidden)
                    .map((child) => {
                      const childActive = activeSection === child.id;
                      return (
                        <li key={child.id}>
                          <button
                            type="button"
                            onClick={() => onSelect(child.id)}
                            className={[
                              "flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs transition-colors",
                              childActive
                                ? "bg-accent text-primary font-medium"
                                : "text-muted-foreground hover:bg-muted"
                            ].join(" ")}
                          >
                            <StatusDot
                              status={child.valid ? "success" : "warning"}
                              size="sm"
                            />
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
