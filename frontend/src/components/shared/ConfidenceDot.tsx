type Props = {
  confidence: string | null | undefined;
};


const confidenceStyles: Record<string, string> = {
  green: "bg-success",
  yellow: "bg-warning",
  red: "bg-destructive"
};


export function ConfidenceDot({ confidence }: Props) {
  const key = (confidence || "red").toLowerCase();
  const className = confidenceStyles[key] ?? confidenceStyles.red;
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-2.5 w-2.5 rounded-full ${className}`} />
      <span className="text-xs capitalize text-foreground">{key}</span>
    </span>
  );
}

