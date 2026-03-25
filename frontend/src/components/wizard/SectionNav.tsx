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
    <nav className="w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-sm)]">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
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
                  "flex w-full items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-left text-sm transition-colors",
                  isActive
                    ? "bg-[var(--color-primary)] text-white font-medium"
                    : "text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]"
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
                              "flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-xs transition-colors",
                              childActive
                                ? "bg-[var(--color-primary-muted)] text-[var(--color-primary)] font-medium"
                                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
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
