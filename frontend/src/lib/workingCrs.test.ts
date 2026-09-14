import { workingCrsLabel } from "./workingCrs";

test("JPR codes use the same zone labels as the backend", () => {
  expect(workingCrsLabel("EPSG:6677")).toBe("EPSG:6677 — JPR CS IX");
  expect(workingCrsLabel("EPSG:6679")).toBe("EPSG:6679 — JPR CS XI");
  expect(workingCrsLabel("EPSG:6669")).toBe("EPSG:6669 — JPR CS I");
  expect(workingCrsLabel("EPSG:4326")).toBe("EPSG:4326");
});
