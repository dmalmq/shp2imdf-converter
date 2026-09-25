import type { Bilingual, ShapefileStageId } from "../../components/shell/stages";
import { featureNoun } from "../checkCopy";
import type { CheckSnapshot } from "./source";
import type { Command, FloorRef, LevelRef, Preview } from "./types";

export type PreviewContext = {
  check: CheckSnapshot | null;
  /** Where a stage of the loaded project opens, or null when it cannot be opened yet. */
  stagePath: (stage: ShapefileStageId) => string | null;
  /** Where a station opens, optionally at a floor. */
  stationPath: (projectId: string, floor: string | null) => string;
  /** The loaded project's Check at a floor, when Check is not on screen. */
  floorPath: (label: string) => string | null;
};

const STAGE_NAMES: Record<ShapefileStageId, Bilingual> = {
  "bring-in": { en: "Bring in", ja: "取り込み" },
  "set-up": { en: "Set up", ja: "設定" },
  check: { en: "Check", ja: "チェック" },
  deliver: { en: "Deliver", ja: "書き出し" }
};

const NEEDS_CHECK: Bilingual = { en: "Open this project’s Check first", ja: "先にこのプロジェクトのチェックを開いてください" };

function count(n: number, featureType: string): Bilingual {
  const noun = featureNoun(featureType);
  const lower = noun.en.toLowerCase();
  const plural = n === 1 ? lower : lower.endsWith("y") ? `${lower.slice(0, -1)}ies` : `${lower}s`;
  return { en: `${n} ${plural}`, ja: `${noun.ja} ${n} 件` };
}

function list(items: Bilingual[]): Bilingual {
  if (items.length === 0) return { en: "", ja: "" };
  const en =
    items.length === 1
      ? items[0].en
      : `${items.slice(0, -1).map((item) => item.en).join(", ")} and ${items[items.length - 1].en}`;
  return { en, ja: items.map((item) => item.ja).join("、") };
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function previewAssign(
  level: LevelRef,
  to: FloorRef,
  outdoor: "set" | "clear" | "keep",
  check: CheckSnapshot | null
): Preview {
  const sentence: Bilingual = { en: `Move ${level.name} onto floor ${to.label}`, ja: `${level.name}を${to.label}に移動` };
  if (!check || check.contentRev === null) return { kind: "unavailable", sentence, reason: NEEDS_CHECK };

  const nextOutdoor = outdoor === "keep" ? level.outdoor : outdoor === "set";
  const moves = level.floor.label !== to.label || level.ordinal !== to.ordinal;
  if (!moves && nextOutdoor === level.outdoor) {
    return {
      kind: "nothing-to-do",
      sentence: {
        en: `${level.name} is already on ${to.label}${nextOutdoor ? " and outdoor" : ""}.`,
        ja: `${level.name}はすでに${to.label}${nextOutdoor ? "で屋外" : ""}です。`
      }
    };
  }

  const riders = check.features.filter((feature) => feature.properties.level_id === level.id);
  const byType = new Map<string, number>();
  for (const feature of riders) byType.set(feature.feature_type, (byType.get(feature.feature_type) ?? 0) + 1);
  const counted = list([...byType.entries()].map(([type, n]) => count(n, type)));

  const flagText: Bilingual =
    outdoor === "set"
      ? { en: " and mark it as outdoor", ja: "、屋外にします" }
      : outdoor === "clear"
        ? { en: " and mark it as indoor", ja: "、屋内にします" }
        : { en: "", ja: "" };
  const rows = [
    ...(moves
      ? [
          { field: { en: "Floor", ja: "フロア" }, before: level.floor.label, after: to.label },
          { field: { en: "Ordinal", ja: "階層番号" }, before: String(level.ordinal), after: String(to.ordinal) }
        ]
      : []),
    ...(outdoor !== "keep"
      ? [{ field: { en: "Outdoor", ja: "屋外" }, before: yesNo(level.outdoor), after: yesNo(nextOutdoor) }]
      : [])
  ];

  return {
    kind: "change",
    sentence: moves
      ? { en: `Move the ${level.name} level onto floor ${to.label}${flagText.en}.`, ja: `${level.name}レベルを${to.label}に移動${flagText.ja}。` }
      : { en: `Keep ${level.name} on ${to.label}${flagText.en}.`, ja: `${level.name}は${to.label}のまま${flagText.ja}。` },
    consequence:
      riders.length > 0
        ? {
            en: `Its ${counted.en} move with it. The blue outlines on the map show them. Nothing is saved until you apply.`,
            ja: `${counted.ja}が一緒に移動します。地図の青い輪郭が対象です。適用するまで何も保存されません。`
          }
        : { en: "Nothing is saved until you apply.", ja: "適用するまで何も保存されません。" },
    rows,
    followUp: {
      en: "Afterwards the whole project is checked again; anything new joins your to-do list.",
      ja: "適用後はプロジェクト全体をもう一度チェックし、新しい問題は ToDo に加わります。"
    },
    highlight: [level.id, ...riders.map((feature) => feature.id)],
    certainty: "exact",
    basis: check.contentRev
  };
}

function overlapPairs(check: CheckSnapshot): Array<[string, string]> {
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];
  for (const issue of [...(check.validation?.errors ?? []), ...(check.validation?.warnings ?? [])]) {
    if (issue.check !== "overlapping_units" || !issue.feature_id || !issue.related_feature_id) continue;
    const pair = [issue.feature_id, issue.related_feature_id].sort() as [string, string];
    const key = pair.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(pair);
  }
  return pairs;
}

function previewFix(check: CheckSnapshot | null): Preview {
  const sentence: Bilingual = { en: "Trim the overlaps that have a clear answer", ja: "はっきりした重なりを解消" };
  if (!check || check.contentRev === null) return { kind: "unavailable", sentence, reason: NEEDS_CHECK };
  if (!check.validation) {
    return { kind: "unavailable", sentence, reason: { en: "Run the checks first", ja: "先にチェックを実行してください" } };
  }
  const pairs = overlapPairs(check);
  if (pairs.length === 0) {
    return { kind: "nothing-to-do", sentence: { en: "No spaces overlap.", ja: "重なっているスペースはありません。" } };
  }
  const n = pairs.length;
  return {
    kind: "change",
    sentence: {
      en: `Trim up to ${n} overlap${n === 1 ? "" : "s"} where one space clearly keeps the area.`,
      ja: `一方のスペースが残るとはっきりしている重なりを最大 ${n} 件解消します。`
    },
    consequence: {
      en: "Any overlap that needs your choice stays on the list. Nothing is saved until you apply.",
      ja: "選択が必要な重なりはリストに残ります。適用するまで何も保存されません。"
    },
    rows: [{ field: { en: "Overlaps", ja: "重なり" }, before: String(n), after: `0–${n}` }],
    followUp: {
      en: "Afterwards the whole project is checked again; anything new joins your to-do list.",
      ja: "適用後はプロジェクト全体をもう一度チェックし、新しい問題は ToDo に加わります。"
    },
    highlight: [...new Set(pairs.flat())],
    certainty: "at-most",
    basis: check.contentRev
  };
}

export function preview(command: Command, context: PreviewContext): Preview {
  if (command.verb === "assign") return previewAssign(command.level, command.to, command.outdoor, context.check);
  if (command.verb === "fix") return previewFix(context.check);

  const place = command.place;
  switch (place.kind) {
    case "station":
      return {
        kind: "go",
        sentence: place.floor
          ? { en: `Open ${place.floor} of ${place.station.name} on the map`, ja: `${place.station.name}の${place.floor}を地図で開く` }
          : { en: `Open ${place.station.name}`, ja: `${place.station.name}を開く` },
        target: { kind: "route", to: context.stationPath(place.station.projectId, place.floor) }
      };
    case "floor": {
      const sentence = { en: `Go to ${place.floor.label}`, ja: `${place.floor.label}へ移動` };
      if (context.check) return { kind: "go", sentence, target: { kind: "floor", label: place.floor.label } };
      const to = context.floorPath(place.floor.label);
      return to ? { kind: "go", sentence, target: { kind: "route", to } } : { kind: "unavailable", sentence, reason: NEEDS_CHECK };
    }
    case "level": {
      const sentence = { en: `Go to ${place.level.name}`, ja: `${place.level.name}へ移動` };
      return context.check
        ? { kind: "go", sentence, target: { kind: "level", id: place.level.id } }
        : { kind: "unavailable", sentence, reason: NEEDS_CHECK };
    }
    case "stage": {
      const name = STAGE_NAMES[place.stage];
      const sentence = { en: `Open ${name.en}`, ja: `${name.ja}を開く` };
      const to = context.stagePath(place.stage);
      return to
        ? { kind: "go", sentence, target: { kind: "route", to } }
        : {
            kind: "unavailable",
            sentence,
            reason: { en: `${name.en} can’t be opened yet`, ja: `${name.ja}はまだ開けません` }
          };
    }
  }
}
