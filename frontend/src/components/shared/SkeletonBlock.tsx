type Props = {
  className?: string;
};

export function SkeletonBlock({ className = "" }: Props) {
  return <div className={`animate-pulse rounded bg-slate-200/80 ${className}`.trim()} />;
}
