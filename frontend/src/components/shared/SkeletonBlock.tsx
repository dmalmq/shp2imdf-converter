type Props = {
  className?: string;
};

export function SkeletonBlock({ className = "" }: Props) {
  return <div className={`animate-pulse rounded bg-border/80 ${className}`.trim()} />;
}
