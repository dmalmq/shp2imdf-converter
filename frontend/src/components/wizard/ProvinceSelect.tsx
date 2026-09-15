import { useEffect, useState } from "react";

import { getIsoSubdivisions, type IsoSubdivision } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../ui";

type Props = {
  id?: string;
  country: string;
  value: string | null;
  onChange: (value: string | null) => void;
};

/**
 * Province / state picker that stores the bare ISO 3166-2 code (e.g. "JP-13").
 *
 * IMDF's address.province must be a full ISO 3166-2 code, so options are labelled
 * "<code> <name>" (e.g. "JP-13 Tokyo") but the stored value is just the code.
 * Falls back to a free-text input when the country has no reference list
 * available (unknown country code or the lookup is unavailable offline).
 */
export function ProvinceSelect({ id, country, value, onChange }: Props) {
  const { t } = useUiLanguage();
  const [subdivisions, setSubdivisions] = useState<IsoSubdivision[]>([]);
  const [loading, setLoading] = useState(false);

  const normalizedCountry = country.trim().toUpperCase();

  useEffect(() => {
    let cancelled = false;
    if (normalizedCountry.length !== 2) {
      setSubdivisions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    getIsoSubdivisions(normalizedCountry)
      .then((response) => {
        if (!cancelled) {
          setSubdivisions(response.subdivisions);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSubdivisions([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [normalizedCountry]);

  // No reference list (unknown country / offline): keep manual entry possible.
  if (!loading && subdivisions.length === 0) {
    return (
      <Input
        id={id}
        value={value ?? ""}
        placeholder={t("ISO 3166-2 code (e.g. JP-13)", "ISO 3166-2 コード（例：JP-13）")}
        onChange={(event) => onChange(event.target.value.trim() ? event.target.value.trim() : null)}
      />
    );
  }

  const currentValue = value ?? "";
  const knownValue = subdivisions.some((item) => item.code === currentValue);

  return (
    <Select
      value={currentValue || NONE}
      disabled={loading}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
    >
      <SelectTrigger id={id}>
        <SelectValue
          placeholder={loading ? t("Loading…", "読み込み中…") : t("Select province", "都道府県を選択")}
        />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t("Not set", "未設定")}</SelectItem>
        {/* A code the reference list does not know still has to stay selectable,
            or opening the wizard on an old project would silently clear it. */}
        {currentValue && !knownValue ? (
          <SelectItem value={currentValue}>{currentValue}</SelectItem>
        ) : null}
        {subdivisions.map((item) => (
          <SelectItem key={item.code} value={item.code}>
            {`${item.code} ${item.name}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const NONE = "__none__";
