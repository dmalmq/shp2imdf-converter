"""Validate the ISO 3166-2 prefecture -> JPR zone table before it enters the plan.

Check: each prefecture's capital, projected into its assigned zone, must fall
well inside the zone's +/-130 km easting design envelope.
"""

import math

from pyproj import Transformer

ZONE_EPSG = {r: 6669 + i for i, r in enumerate(
    ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
     "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX"])}

MULTI = {"JP-01", "JP-13", "JP-47", "JP-46"}

# code, prefecture, capital, lon, lat, zone
TABLE = [
    ("JP-01", "Hokkaido", "Sapporo", 141.3469, 43.0642, "XII"),
    ("JP-02", "Aomori", "Aomori", 140.7400, 40.8244, "X"),
    ("JP-03", "Iwate", "Morioka", 141.1527, 39.7036, "X"),
    ("JP-04", "Miyagi", "Sendai", 140.8719, 38.2688, "X"),
    ("JP-05", "Akita", "Akita", 140.1024, 39.7186, "X"),
    ("JP-06", "Yamagata", "Yamagata", 140.3633, 38.2404, "X"),
    ("JP-07", "Fukushima", "Fukushima", 140.4676, 37.7500, "IX"),
    ("JP-08", "Ibaraki", "Mito", 140.4468, 36.3418, "IX"),
    ("JP-09", "Tochigi", "Utsunomiya", 139.8836, 36.5658, "IX"),
    ("JP-10", "Gunma", "Maebashi", 139.0608, 36.3912, "IX"),
    ("JP-11", "Saitama", "Saitama", 139.6489, 35.8569, "IX"),
    ("JP-12", "Chiba", "Chiba", 140.1233, 35.6051, "IX"),
    ("JP-13", "Tokyo", "Tokyo", 139.6917, 35.6895, "IX"),
    ("JP-14", "Kanagawa", "Yokohama", 139.6425, 35.4478, "IX"),
    ("JP-15", "Niigata", "Niigata", 139.0232, 37.9026, "VIII"),
    ("JP-16", "Toyama", "Toyama", 137.2113, 36.6953, "VII"),
    ("JP-17", "Ishikawa", "Kanazawa", 136.6256, 36.5947, "VII"),
    ("JP-18", "Fukui", "Fukui", 136.2216, 36.0652, "VI"),
    ("JP-19", "Yamanashi", "Kofu", 138.5683, 35.6642, "VIII"),
    ("JP-20", "Nagano", "Nagano", 138.1812, 36.6513, "VIII"),
    ("JP-21", "Gifu", "Gifu", 136.7222, 35.3912, "VII"),
    ("JP-22", "Shizuoka", "Shizuoka", 138.3831, 34.9769, "VIII"),
    ("JP-23", "Aichi", "Nagoya", 136.9066, 35.1802, "VII"),
    ("JP-24", "Mie", "Tsu", 136.5086, 34.7303, "VI"),
    ("JP-25", "Shiga", "Otsu", 135.8686, 35.0045, "VI"),
    ("JP-26", "Kyoto", "Kyoto", 135.7556, 35.0211, "VI"),
    ("JP-27", "Osaka", "Osaka", 135.5023, 34.6937, "VI"),
    ("JP-28", "Hyogo", "Kobe", 135.1830, 34.6913, "V"),
    ("JP-29", "Nara", "Nara", 135.8328, 34.6851, "VI"),
    ("JP-30", "Wakayama", "Wakayama", 135.1675, 34.2261, "VI"),
    ("JP-31", "Tottori", "Tottori", 134.2380, 35.5039, "V"),
    ("JP-32", "Shimane", "Matsue", 133.0505, 35.4723, "III"),
    ("JP-33", "Okayama", "Okayama", 133.9350, 34.6618, "V"),
    ("JP-34", "Hiroshima", "Hiroshima", 132.4596, 34.3853, "III"),
    ("JP-35", "Yamaguchi", "Yamaguchi", 131.4714, 34.1859, "III"),
    ("JP-36", "Tokushima", "Tokushima", 134.5594, 34.0658, "IV"),
    ("JP-37", "Kagawa", "Takamatsu", 134.0434, 34.3401, "IV"),
    ("JP-38", "Ehime", "Matsuyama", 132.7657, 33.8416, "IV"),
    ("JP-39", "Kochi", "Kochi", 133.5311, 33.5597, "IV"),
    ("JP-40", "Fukuoka", "Fukuoka", 130.4181, 33.6064, "II"),
    ("JP-41", "Saga", "Saga", 130.2988, 33.2494, "II"),
    ("JP-42", "Nagasaki", "Nagasaki", 129.8737, 32.7448, "I"),
    ("JP-43", "Kumamoto", "Kumamoto", 130.7417, 32.7898, "II"),
    ("JP-44", "Oita", "Oita", 131.6126, 33.2382, "II"),
    ("JP-45", "Miyazaki", "Miyazaki", 131.4239, 31.9077, "II"),
    ("JP-46", "Kagoshima", "Kagoshima", 130.5581, 31.5602, "II"),
    ("JP-47", "Okinawa", "Naha", 127.6809, 26.2124, "XV"),
]

LIMIT_KM = 130.0
worst = []
fails = []
for code, pref, cap, lon, lat, zone in TABLE:
    epsg = ZONE_EPSG[zone]
    e, n = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True).transform(lon, lat)
    ekm, nkm = e / 1000, n / 1000
    worst.append((abs(ekm), code, pref, cap, zone, epsg, ekm, nkm))
    if abs(ekm) > LIMIT_KM:
        fails.append((code, pref, cap, zone, ekm))

print(f"{len(TABLE)} prefectures, codes JP-01..JP-47 unique: "
      f"{len({t[0] for t in TABLE}) == 47}")
print(f"multi-zone prefectures needing fallback: {sorted(MULTI)}")
print(f"\nzones used: {sorted({t[5] for t in TABLE}, key=lambda r: r)}")

worst.sort(reverse=True)
print(f"\nlargest |easting| (design envelope +/-{LIMIT_KM:.0f} km):")
for aek, code, pref, cap, zone, epsg, ekm, nkm in worst[:6]:
    print(f"  {code} {pref:11s} {cap:11s} zone {zone:5s} EPSG:{epsg}  "
          f"E={ekm:+7.1f} km  N={nkm:+7.1f} km")

print(f"\nout of envelope: {len(fails)}")
for f in fails:
    print("  FAIL", f)
print("\nRESULT:", "ALL WITHIN ENVELOPE" if not fails else "TABLE HAS ERRORS")
