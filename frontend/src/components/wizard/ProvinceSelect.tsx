import { useEffect, useState } from "react";

import { getIsoSubdivisions, type IsoSubdivision } from "../../api/client";
import { useUiLanguage } from "../../hooks/useUiLanguage";

type Props = {
  country: string;
  value: string | null;
  onChange: (value: string | null) => void;
  className?: string;
};

/**
 * Province / state picker that stores the bare ISO 3166-2 code (e.g. "JP-13").
 *
 * IMDF's address.province must be a full ISO 3166-2 code, so options are labelled
 * "<code> <name>" (e.g. "JP-13 Tokyo") but the stored value is just the code.
 * Falls back to a free-text input when the country has no reference list
 * available (unknown country code or the lookup is unavailable offline).
 */
export function ProvinceSelect({ country, value, onChange, className }: Props) {
  const { t } = useUiLanguage();
  const [subdivisions, setSubdivisions] = useState<IsoSubdivision[]>([]);
  const [loading, setLoading] = useState(false);

  const normalizedCountry = country.trim().toUpperCase();
  const inputClass = className ?? "w-full rounded border px-2 py-1.5";

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
      <input
        className={inputClass}
        value={value ?? ""}
        placeholder={t("ISO 3166-2 code (e.g. JP-13)", "ISO 3166-2 コード（例：JP-13）")}
        onChange={(event) => onChange(event.target.value.trim() ? event.target.value.trim() : null)}
      />
    );
  }

  const currentValue = value ?? "";
  const knownValue = subdivisions.some((item) => item.code === currentValue);

  return (
    <select
      className={inputClass}
      value={currentValue}
      disabled={loading}
      onChange={(event) => onChange(event.target.value ? event.target.value : null)}
    >
      <option value="">{loading ? t("Loading…", "読み込み中…") : t("— Select province —", "— 都道府県を選択 —")}</option>
      {currentValue && !knownValue ? <option value={currentValue}>{currentValue}</option> : null}
      {subdivisions.map((item) => (
        <option key={item.code} value={item.code}>
          {`${item.code} ${item.name}`}
        </option>
      ))}
    </select>
  );
}
