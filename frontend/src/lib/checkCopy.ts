import type { Bilingual } from "../components/shell/stages";

/** What Check says about one validator check: a plain title and why it matters. */
export type IssueCopy = { title: Bilingual; why: Bilingual };

const NOUNS: Record<string, Bilingual> = {
  venue: { en: "Station", ja: "施設" },
  building: { en: "Building", ja: "建物" },
  footprint: { en: "Footprint", ja: "フットプリント" },
  level: { en: "Floor", ja: "フロア" },
  unit: { en: "Space", ja: "スペース" },
  opening: { en: "Door", ja: "開口部" },
  fixture: { en: "Fixture", ja: "什器" },
  detail: { en: "Drawing line", ja: "線画" },
  amenity: { en: "Amenity", ja: "アメニティ" },
  anchor: { en: "Anchor", ja: "アンカー" },
  geofence: { en: "Geofence", ja: "ジオフェンス" },
  kiosk: { en: "Kiosk", ja: "キオスク" },
  occupant: { en: "Occupant", ja: "テナント" },
  relationship: { en: "Relationship", ja: "リレーション" },
  section: { en: "Section", ja: "セクション" },
  address: { en: "Address", ja: "住所" },
  facility: { en: "Facility", ja: "設備" }
};

export function featureNoun(featureType: string): Bilingual {
  return NOUNS[featureType] ?? { en: featureType, ja: featureType };
}

const WHY_ID: Bilingual = {
  en: "Every feature needs its own UUID so others can point at it; Apple rejects the archive otherwise.",
  ja: "ほかのフィーチャーから参照できるよう、各フィーチャーに固有の UUID が必要です。ないと Apple が受け付けません。"
};
const WHY_SHAPE_KIND: Bilingual = {
  en: "IMDF fixes the kind of shape each feature type has, and a feature with the wrong kind is rejected.",
  ja: "IMDF ではフィーチャーの種類ごとに形状の種類が決まっていて、違う形状は受け付けられません。"
};
const WHY_FLOOR: Bilingual = {
  en: "Everything indoors has to say which floor it is on, or Apple Maps cannot show it on any floor.",
  ja: "屋内のものはすべてどのフロアにあるかが必要です。ないと Apple マップはどのフロアにも表示できません。"
};
const WHY_CATEGORY: Bilingual = {
  en: "The category decides how Apple Maps draws it and whether people can search for it.",
  ja: "カテゴリで Apple マップでの描き方と検索できるかどうかが決まります。"
};
const WHY_LINKS: Bilingual = {
  en: "Links to other features must be lists of their IDs; a malformed one is rejected.",
  ja: "ほかのフィーチャーへのリンクは ID のリストである必要があります。形が崩れていると受け付けられません。"
};
const WHY_ADDRESS: Bilingual = {
  en: "Apple Maps shows the station's address and uses it to find the station.",
  ja: "Apple マップは施設の住所を表示し、施設を探すのにも使います。"
};
const WHY_OUTSIDE: Bilingual = {
  en: "It would show up outside the outline it belongs to, which usually means it is on the wrong floor or offset.",
  ja: "本来の外形の外に表示されます。多くの場合、フロアの割り当てか位置がずれています。"
};
const WHY_SLIVER: Bilingual = {
  en: "Usually left over from drawing; it shows up as a stray line between spaces.",
  ja: "多くは作図の残りで、スペースの間に余計な線として表示されます。"
};
const WHY_DOOR: Bilingual = {
  en: "Directions go through doors, and a door that is not on a wall connects nothing.",
  ja: "経路は開口部を通ります。壁の上にない開口部はどこにもつながりません。"
};

const COPY: Record<string, IssueCopy> = {
  missing_id: { title: { en: "A feature has no ID", ja: "ID のないフィーチャー" }, why: WHY_ID },
  id_not_uuid: { title: { en: "A feature ID is not a UUID", ja: "UUID ではない ID" }, why: WHY_ID },
  duplicate_uuids: { title: { en: "Two features share an ID", ja: "同じ ID のフィーチャー" }, why: WHY_ID },
  empty_geometry: {
    title: { en: "A feature has no shape", ja: "形状のないフィーチャー" },
    why: { en: "There is nothing to draw, so Apple Maps drops it.", ja: "描くものがないため、Apple マップでは表示されません。" }
  },
  invalid_geometry: {
    title: { en: "A shape is broken", ja: "壊れた形状" },
    why: {
      en: "An outline that crosses itself cannot be drawn or measured reliably.",
      ja: "自己交差する外形は正しく描画も計測もできません。"
    }
  },
  coordinates_out_of_bounds: {
    title: { en: "Coordinates are off the globe", ja: "座標が範囲外" },
    why: {
      en: "Usually a wrong coordinate system on the way in; the feature lands nowhere.",
      ja: "多くは取り込み時の座標系の誤りで、フィーチャーが正しい位置に置かれません。"
    }
  },
  null_island_detection: {
    title: { en: "A feature sits at 0°, 0°", ja: "緯度経度 0°, 0° のフィーチャー" },
    why: { en: "It means the location was lost on the way in.", ja: "取り込み時に位置が失われています。" }
  },
  excessive_precision: {
    title: { en: "Coordinates are more precise than needed", ja: "座標の桁数が多すぎる" },
    why: {
      en: "More than 7 decimals is sub-centimetre noise that only makes the file bigger.",
      ja: "小数点以下 7 桁を超える分は 1 cm 未満の誤差で、ファイルを大きくするだけです。"
    }
  },
  polygon_has_interior_rings: {
    title: { en: "A shape has holes", ja: "穴のある形状" },
    why: {
      en: "Holes are right for courtyards and atria; check that these are meant.",
      ja: "中庭や吹き抜けなら正しい形です。意図したものか確認してください。"
    }
  },
  labels_format_valid: {
    title: { en: "A name is not split by language", ja: "言語別になっていない名前" },
    why: {
      en: "IMDF names are per language, like { ja: … }; plain text is rejected.",
      ja: "IMDF の名前は { ja: … } のように言語ごとに持ちます。ただの文字列は受け付けられません。"
    }
  },
  display_point_within_geometry: {
    title: { en: "A label point sits outside its shape", ja: "ラベル位置が形状の外" },
    why: {
      en: "Apple Maps puts the label there, so it would float away from the space.",
      ja: "Apple マップはそこにラベルを置くため、スペースから離れて表示されます。"
    }
  },
  orphaned_reference_error: {
    title: { en: "A feature points at a floor that does not exist", ja: "存在しないフロアを参照" },
    why: WHY_FLOOR
  },
  unspecified_category: {
    title: { en: "A space has no specific category", ja: "カテゴリが未指定のスペース" },
    why: {
      en: "Unspecified spaces are drawn plainly and cannot be found by search.",
      ja: "未指定のスペースは無地で描かれ、検索でも見つかりません。"
    }
  },
  sliver_polygon_warning: { title: { en: "A thin sliver of a space", ja: "細い切れ端のスペース" }, why: WHY_SLIVER },
  unit_sliver: { title: { en: "A tiny sliver of a space", ja: "ごく小さな切れ端のスペース" }, why: WHY_SLIVER },
  amenity_unit_ids_invalid: { title: { en: "An amenity's space links are malformed", ja: "アメニティのリンクが不正" }, why: WHY_LINKS },
  geofence_feature_ids_invalid: { title: { en: "A geofence's links are malformed", ja: "ジオフェンスのリンクが不正" }, why: WHY_LINKS },
  relationship_direction_invalid: { title: { en: "A relationship has no valid direction", ja: "リレーションの方向が不正" }, why: WHY_LINKS },
  relationship_reference_invalid: { title: { en: "A relationship's links are malformed", ja: "リレーションのリンクが不正" }, why: WHY_LINKS },
  detail_degenerate_line: {
    title: { en: "A drawing line has no length", ja: "長さのない線画" },
    why: { en: "There is nothing to draw; it is usually a stray click.", ja: "描くものがなく、多くは誤ったクリックの残りです。" }
  },
  level_missing_ordinal_error: {
    title: { en: "A floor has no height order", ja: "高さの順序がないフロア" },
    why: {
      en: "The order stacks the floors; without it the floor switcher cannot place this one.",
      ja: "順序でフロアを積み重ねます。ないとフロア切り替えに並べられません。"
    }
  },
  level_missing_short_name_error: {
    title: { en: "A floor has no short name", ja: "略称のないフロア" },
    why: { en: "The short name, like 1F, is what the floor switcher shows.", ja: "フロア切り替えには 1F のような略称が表示されます。" }
  },
  level_missing_outdoor_error: {
    title: { en: "A floor does not say whether it is outdoors", ja: "屋外かどうか未設定のフロア" },
    why: { en: "Apple Maps draws outdoor floors differently.", ja: "Apple マップは屋外のフロアを別の描き方で表示します。" }
  },
  level_missing_building_ids_error: {
    title: { en: "A floor is not tied to a building", ja: "建物に結び付いていないフロア" },
    why: { en: "Each floor belongs to a building, or it has nowhere to be shown.", ja: "各フロアは建物に属します。ないと表示する場所がありません。" }
  },
  footprint_missing_building_ids_error: {
    title: { en: "A footprint is not tied to a building", ja: "建物に結び付いていないフットプリント" },
    why: { en: "The footprint is the outline of a building, so it has to name one.", ja: "フットプリントは建物の外形なので、建物の指定が必要です。" }
  },
  venue_missing_address_error: { title: { en: "The station has no address", ja: "施設に住所がない" }, why: WHY_ADDRESS },
  venue_missing_address_id: { title: { en: "The station's address link is broken", ja: "施設の住所リンクが切れている" }, why: WHY_ADDRESS },
  building_address_id_valid: { title: { en: "A building's address link is broken", ja: "建物の住所リンクが切れている" }, why: WHY_ADDRESS },
  address_invalid_country: { title: { en: "The address country code is not valid", ja: "住所の国コードが不正" }, why: WHY_ADDRESS },
  address_invalid_province: { title: { en: "The address prefecture code is not valid", ja: "住所の都道府県コードが不正" }, why: WHY_ADDRESS },
  address_province_country_mismatch: {
    title: { en: "The prefecture does not match the country", ja: "都道府県と国が一致しない" },
    why: WHY_ADDRESS
  },
  orphaned_address: {
    title: { en: "An address is not used", ja: "使われていない住所" },
    why: { en: "Nothing points at it, so it can go or be linked.", ja: "どこからも参照されていないため、削除するかリンクしてください。" }
  },
  venue_missing_display_point_error: {
    title: { en: "The station has no label point", ja: "施設のラベル位置がない" },
    why: { en: "Apple Maps puts the station's name there.", ja: "Apple マップはそこに施設名を表示します。" }
  },
  venue_placeholder_metadata: {
    title: { en: "The station still has the placeholder name", ja: "施設名が仮のまま" },
    why: { en: "It is the name people see in Apple Maps.", ja: "Apple マップで利用者に見える名前です。" }
  },
  venue_phone_format: {
    title: { en: "The phone number is not in international form", ja: "電話番号が国際形式でない" },
    why: { en: "Phones dial it as written, so it needs the +81 form.", ja: "表示どおりに発信されるため、+81 の形式が必要です。" }
  },
  venue_hours_format: {
    title: { en: "The opening hours are not in the standard form", ja: "営業時間が標準形式でない" },
    why: { en: "Apple Maps can only show hours it can read.", ja: "Apple マップは読める形式の営業時間しか表示できません。" }
  },
  building_missing_footprint: {
    title: { en: "A building has no footprint", ja: "フットプリントのない建物" },
    why: { en: "The footprint is the outline Apple Maps draws for the building.", ja: "Apple マップは建物の外形としてフットプリントを描きます。" }
  },
  unit_outside_level_warning: { title: { en: "A space sits outside its floor", ja: "フロアの外にあるスペース" }, why: WHY_OUTSIDE },
  detail_outside_level: { title: { en: "A drawing line sits outside its floor", ja: "フロアの外にある線画" }, why: WHY_OUTSIDE },
  footprint_outside_venue_warning: {
    title: { en: "The footprint sits outside the station", ja: "施設の外にあるフットプリント" },
    why: WHY_OUTSIDE
  },
  level_outside_footprint_warning: {
    title: { en: "A floor sits outside the footprint", ja: "フットプリントの外にあるフロア" },
    why: WHY_OUTSIDE
  },
  footprint_level_coverage: {
    title: { en: "The footprint does not cover a floor", ja: "フロアを覆っていないフットプリント" },
    why: {
      en: "The building outline should hold every floor, or the floor sticks out past it.",
      ja: "建物の外形はすべてのフロアを含む必要があります。含まないとフロアがはみ出します。"
    }
  },
  overlapping_units: {
    title: { en: "Two spaces overlap", ja: "重なっているスペース" },
    why: {
      en: "Apple Maps can’t draw two spaces on the same spot, and directions through there would break.",
      ja: "Apple マップは同じ場所に 2 つのスペースを描けず、そこを通る経路案内も壊れます。"
    }
  },
  duplicate_geometry_warning: {
    title: { en: "Two features are drawn on the same spot", ja: "同じ場所に描かれた 2 つのフィーチャー" },
    why: { en: "One is usually a copy left behind; it doubles what Apple Maps draws.", ja: "多くは残ったコピーで、同じものが二重に描かれます。" }
  },
  opening_not_touching_boundary: { title: { en: "A door doesn’t touch a wall", ja: "壁に接していない開口部" }, why: WHY_DOOR },
  opening_through_unit: { title: { en: "A door sits inside a space, not on its wall", ja: "スペースの内側にある開口部" }, why: WHY_DOOR },
  opening_too_short: {
    title: { en: "A door is unusually narrow", ja: "幅が狭すぎる開口部" },
    why: { en: "Under 30 cm is usually a drawing slip rather than a real door.", ja: "30 cm 未満は多くの場合、実際の開口部ではなく作図のずれです。" }
  },
  opening_too_long: {
    title: { en: "A door is unusually wide", ja: "幅が広すぎる開口部" },
    why: { en: "Over 10 m is usually a wall drawn as a door.", ja: "10 m を超えるものは多くの場合、壁を開口部として描いたものです。" }
  },
  opening_missing_door_warning: {
    title: { en: "A doorway has no door details", ja: "ドア情報のない出入口" },
    why: {
      en: "Whether a door is automatic or manual helps step-free directions.",
      ja: "自動ドアか手動かは、段差のない経路案内に役立ちます。"
    }
  },
  level_ordinal_gap: {
    title: { en: "The floors skip a height", ja: "フロアの高さに欠番" },
    why: { en: "A gap leaves an empty step in the floor switcher.", ja: "欠番があるとフロア切り替えに空の段ができます。" }
  },
  level_no_units: {
    title: { en: "A floor has no spaces", ja: "スペースのないフロア" },
    why: { en: "Apple Maps would show an empty floor.", ja: "Apple マップに空のフロアが表示されます。" }
  },
  level_floor_mismatch: {
    title: { en: "A file’s floor does not match its level", ja: "ファイルの階とレベルが一致しない" },
    why: { en: "The file name says one floor and the data is on another.", ja: "ファイル名の階とデータのフロアが異なります。" }
  },
  space_missing_name: {
    title: { en: "Spaces without a name", ja: "名前のないスペース" },
    why: { en: "Unnamed spaces cannot be found by search.", ja: "名前のないスペースは検索で見つかりません。" }
  }
};

const FALLBACK: IssueCopy = {
  title: { en: "Something to look at", ja: "確認が必要な項目" },
  why: { en: "The checker flagged this against the IMDF rules.", ja: "IMDF の規則に照らして指摘された項目です。" }
};

/** Checks the validator names after a feature type, e.g. `unit_missing_category_error`. */
const FAMILIES: Array<[RegExp, (noun: Bilingual) => IssueCopy]> = [
  [/^missing_(\w+)$/, (n) => ({
    title: { en: `No ${n.en.toLowerCase()} in the project`, ja: `${n.ja}がありません` },
    why: { en: "IMDF needs one, and Apple rejects the archive without it.", ja: "IMDF では必須で、ないと Apple が受け付けません。" }
  })],
  [/^(\w+)_must_be_(null|polygon|linestring|point)$/, (n) => ({
    title: { en: `${n.en} has the wrong kind of shape`, ja: `${n.ja}の形状の種類が違う` },
    why: WHY_SHAPE_KIND
  })],
  [/^(\w+)_missing_level_id_error$/, (n) => ({
    title: { en: `${n.en} is not on a floor`, ja: `フロアのない${n.ja}` },
    why: WHY_FLOOR
  })],
  [/^(\w+)_missing_category_error$/, (n) => ({
    title: { en: `${n.en} has no category`, ja: `カテゴリのない${n.ja}` },
    why: WHY_CATEGORY
  })]
];

export function issueCopy(check: string): IssueCopy {
  const known = COPY[check];
  if (known) return known;
  for (const [pattern, build] of FAMILIES) {
    const match = pattern.exec(check);
    if (match) return build(featureNoun(match[1]));
  }
  return FALLBACK;
}
