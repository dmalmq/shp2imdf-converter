type Props = {
  icon?: "upload" | "map" | "search";
  title: string;
  description?: string;
  children?: React.ReactNode;
};

const ICONS: Record<string, React.ReactNode> = {
  upload: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="text-[var(--color-text-muted)]">
      <rect x="6" y="12" width="36" height="28" rx="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M24 20v14M18 26l6-6 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  map: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="text-[var(--color-text-muted)]">
      <rect x="6" y="8" width="36" height="32" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 18l14-4 8 6 14-4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M20 14v22M28 20v18" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
    </svg>
  ),
  search: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="text-[var(--color-text-muted)]">
      <circle cx="22" cy="22" r="12" stroke="currentColor" strokeWidth="1.5" />
      <path d="M31 31l9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
};

export function EmptyState({ icon = "map", title, description, children }: Props) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center animate-fade-in">
      {ICONS[icon]}
      <h3 className="mt-3 text-sm font-medium text-[var(--color-text)]">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-xs text-xs text-[var(--color-text-muted)]">{description}</p>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
