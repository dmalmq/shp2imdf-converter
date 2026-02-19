type Props = {
  confidence: string | null | undefined;
};


const confidenceStyles: Record<string, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500"
};


export function ConfidenceDot({ confidence }: Props) {
  const key = (confidence || "red").toLowerCase();
  const className = confidenceStyles[key] ?? confidenceStyles.red;
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-2.5 w-2.5 rounded-full ${className}`} />
      <span className="text-xs capitalize text-slate-700">{key}</span>
    </span>
  );
}

