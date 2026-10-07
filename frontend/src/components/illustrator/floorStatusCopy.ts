import type { FloorStatus } from "../../lib/floorStatus";

type T = (en: string, ja: string) => string;

export function statusDetail(status: FloorStatus, t: T): string | null {
  if (status.kind === "aligned") {
    const { basis } = status;
    if (basis.kind === "floor") return t(`Matched to ${basis.floor}`, `${basis.floor}に合わせました`);
    if (basis.kind === "reference") return t("Matched to reference data", "参照データに合わせました");
    return t(
      `Fitted to ${basis.pointIds.length} pairs on ${basis.floor}`,
      `${basis.floor}の対応点 ${basis.pointIds.length} 組で合わせました`
    );
  }
  switch (status.reason) {
    case "moved":
      return t("Moved since it was aligned", "位置合わせの後に動かされました");
    case "reference-moved":
      return t("The floor it was matched to has moved", "合わせた先のフロアが動きました");
    case "reference-changed":
      return t(
        "The reference data or the station pin it was matched to changed",
        "合わせた参照データか駅のピンが変わりました"
      );
    case "points-changed":
      return t("Its matching pairs changed", "対応点が変わりました");
    default:
      return null;
  }
}

/** How an Aligned floor got there, for Deliver's per-floor table. */
export function placedBy(status: FloorStatus, t: T): string {
  if (status.kind !== "aligned") return t("Not yet", "未了");
  const { basis } = status;
  if (basis.kind === "points") return t("Control points", "対応点");
  if (basis.kind === "floor") return t(`Shape match to ${basis.floor}`, `${basis.floor}に形状マッチ`);
  return t("Shape match to reference", "参照データに形状マッチ");
}
