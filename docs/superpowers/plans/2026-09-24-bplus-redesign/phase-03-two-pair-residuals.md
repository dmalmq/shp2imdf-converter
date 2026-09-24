# Two-pair residuals when scale is locked

Back to [overview](overview.md).

**Goal.** With scale locked (the default), the fit and residuals are available after two
matching pairs; unlocked still needs three.

**Changes.**
- `frontend/src/hooks/useIllustratorPlacement.ts`: replace `MIN_CONTROL_POINTS` with a
  `minControlPoints(state)` helper used by the fit guard and `currentResiduals`.
- `IllustratorPage.tsx` picking loop and every `ControlPointList.tsx` use, including the
  hard-coded "3" copy and the segmented progress bar length.
- `fitHelmert`, the backend and the golden fixture do not change.

**Data structures.** `minControlPoints(state: PlacementState): 2 | 3`.

**Verification.** Tests that fail on main: locked with 2 pairs fits and shows residuals;
unlocked with 2 pairs does not. Existing golden tests (both languages) still pass. Live: place
two pairs with scale locked, residuals and RMSE appear, Apply works.
