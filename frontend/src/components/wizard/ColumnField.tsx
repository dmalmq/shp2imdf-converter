import {
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../ui";

/** Radix Select has no empty-string value, so "no column" needs a sentinel. */
const NO_COLUMN = "__none__";

/**
 * Picks one source attribute column for an IMDF field.
 *
 * The three attribute-mapping steps had fifteen copies of the same
 * label-plus-native-select block, each with its own idea of what the empty
 * option should be called.
 */
export function ColumnField({
  label,
  hint,
  columns,
  value,
  onChange,
  emptyLabel,
  className
}: {
  label: string;
  hint?: string;
  columns: string[];
  value: string | null;
  onChange: (value: string | null) => void;
  emptyLabel: string;
  className?: string;
}) {
  return (
    <Field label={label} hint={hint} className={className}>
      {(id) => (
        <Select
          value={value ?? NO_COLUMN}
          onValueChange={(next) => onChange(next === NO_COLUMN ? null : next)}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_COLUMN}>{emptyLabel}</SelectItem>
            {columns.map((column) => (
              <SelectItem key={column} value={column}>
                {column}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}
