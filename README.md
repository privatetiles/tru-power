# TRU POWER

**TRU POWER** is an offline FRC team-strength calculator. It estimates each robot's **True Potential**, separates real strength from **schedule luck**, predicts matches, and forecasts final rankings.

- It runs entirely on your Mac, with no internet needed at the event.
- It has no installs and no dependencies.
- Every recalculation takes well under a second.

## Quick start

1. **Open `index.html`** by double-clicking it. Safari and Chrome both work. Bookmark it.
2. **Before the event, while you have internet:**
   1. Open the **Data** tab.
   2. Paste a TBA read key (get one at thebluealliance.com/account).
   3. Search for the event by name, city or code (e.g. "battlecry", "worcester") and click **Download**. With your team number set, your team's events are listed first. The event list is saved, so search works offline too.

   This downloads the teams, schedule and results. It also downloads every earlier event each team played this season, which gives each team a starting rating. Everything is saved on the Mac.
3. **At the event (no internet):**
   - Enter scores in the **Matches** tab as matches finish. Only the final score is required.
   - Per-robot tower levels and fuel counts make the ratings sharper.
   - Ratings, luck and forecasts update instantly.
   - **Auto-sync (on by default):** whenever the Mac has internet, new official results arrive from TBA every 2 minutes with no typing. Unchanged data costs almost nothing, since it is checked by ETag.
   - **Downloading mid-event works too:** played results are rated and only the remaining matches are forecast.
4. **Share between laptops:**
   - Use **Data → Export**, then move the file on a **USB stick**. Avoid AirDrop at events: it works by creating an ad-hoc wireless link, and rule E301 bans team ad-hoc networks.
   - On the other laptop, use **Import**. It merges with what is already there; the newest result wins.
   - Hotspots are illegal at events (manual rule E301), so this is the way to share.

If you have no internet at all, use **Data → Create event manually**. Then paste the schedule in the Matches tab (`Q1 254 1678 971 118 148 1323` per line).

**Keyboard:** keys `0`–`9` switch tabs (`0` = Data); `Esc` closes a popup; `Enter` saves a match.

## What the numbers mean

| Number | Meaning |
|---|---|
| **True Potential (TP)** | Points this robot adds to its alliance per match, fouls excluded. It is solved jointly over every match, so being carried by strong partners (or dragged down by weak ones) is accounted for. The ± is one standard deviation. |
| **Auto / Fuel / Tower / Fouls** | The same model applied to each scoring component. Tower uses the per-robot climb data, so it is very accurate. "Fouls" is foul points given away to opponents. |
| **True rank** | Rank by expected RP per match if every team had a random (neutral) schedule. |
| **Schedule luck** | Expected RP per match on this team's actual schedule minus on a random schedule. +0.30 means the schedule alone is worth about 0.3 RP every match. |
| **Ease %ile** | How easy the schedule is compared with random schedules: 100 is easiest, 0 is hardest. |
| **Luck-adj. RS** | Actual ranking score with the schedule effect removed. This is the best single "who deserves to be where" number. |
| **Over/under** | Actual RS minus what the model expected given the schedule: random breaks, or a team improving or declining. |
| **Proj. rank / P(top 8)** | From thousands of Monte Carlo simulations of the remaining qualification matches. Each run redraws team strengths from their uncertainty, so early-event ranges are honest. |

## How it works

Full research notes, formulas and sources are in [RESEARCH.md](RESEARCH.md).

- **Rating model:** Bayesian (ridge / MMSE) component OPR. For each component, it solves (AᵀWA + Λ)θ = AᵀWy + Λμ₀, where μ₀ is the team's average from earlier events.
  - With no data it equals the prior.
  - With lots of data it becomes OPR.
  - In between it blends the two. This is what makes it stable from match 1, where raw OPR is noise.
  - Earlier-event ratings are rescaled to this event's scoring level as data arrives.
  - Teams with no events yet this season start from **last season's relative strength** (90% carried over). Rookies start slightly below average.
- **Match prediction:** each alliance's score is modelled as a normal distribution, with the variance taken from match noise plus rating uncertainty. Bonus-RP chances come from predicted fuel and tower totals compared with the official thresholds for the event level.
- **Ranking forecast:** a Monte Carlo of the remaining qualification matches.
  - Points, fuel and tower are drawn jointly, because they are correlated.
  - It applies the official RP rules, surrogate rules and tiebreakers: RS, then average match points, then auto fuel, then tower points.
- **Schedule luck:** each team's expected RP on its real schedule compared with random partners and opponents. This is the same idea as the Statbotics and Caleb Sykes schedule-strength metrics.

### Validation

The full results, with method and definitions, are in **[docs/backtest/BACKTEST.md](docs/backtest/BACKTEST.md)**. Every match's predictions are in `docs/backtest/predictions-all.csv`.

**Method**
- **Matches:** official-event qualification matches with a winner. Each is predicted only from matches before it, using priors from events that had already finished.
- **Seasons:** 2026 is the season the settings were tuned on; 2025 and 2024 are blind tests with all settings frozen.
- **Baseline:** Statbotics EPA, re-implemented from its open-source code because its API was unavailable.
- **Intervals:** 95% cluster-bootstrap intervals that resample whole events, because matches at one event share teams.

**What the Brier score means.** Brier score = mean of (predicted probability − outcome)².
- It runs from 0 (perfect) to 1 (confidently wrong every time).
- Always predicting 50% scores exactly 0.25.
- Lower is better.
- *Brier skill* = 1 − Brier / 0.25: the improvement over always saying 50%.

**Results**

| Season | Matches | TRU POWER winners · Brier | EPA winners · Brier | Brier difference, TRU POWER better if + (95% CI) |
|---|---|---|---|---|
| 2026 (tuned) | 15,132 | 80.0% · 0.1397 | 79.9% · 0.1446 | +0.0050 (+0.0032 to +0.0068) |
| 2025 (blind) | 14,686 | 78.1% · 0.1493 | 78.1% · 0.1522 | +0.0029 (+0.0013 to +0.0044) |
| 2024 (blind) | 13,937 | 77.0% · 0.1565 | 77.0% · 0.1573 | +0.0008 (−0.0007 to +0.0024) |

**Precisely what this supports**
- **Picking winners:** no detectable difference from EPA in any season. Each accuracy-difference interval spans about ±0.5 percentage points around zero.
- **Probabilities:** a lower Brier score than EPA in 2026 and 2025, with intervals above zero. In 2024 the difference is not distinguishable from zero. Log loss shows the same pattern.
- **Calibration:** both models are slightly under-confident (logistic calibration slope above 1).

| Season | TRU POWER slope | EPA slope | TRU POWER calibration error | EPA calibration error |
|---|---|---|---|---|
| 2026 | 1.08 | 1.34 | 2.6% | 5.3% |
| 2025 | 1.10 | 1.32 | 1.6% | 4.3% |
| 2024 | 1.04 | 1.26 | 1.8% | 3.6% |

- **When in an event:**
  - In the middle and last thirds of events, TRU POWER's Brier is lower in all three seasons, with intervals above zero.
  - In the first third, EPA's is lower in all three seasons. That difference is distinguishable from zero only in 2024.

#### Are the ranges honest?

| Check | Result | Target |
|---|---|---|
| Alliance score inside the shown 80% range (2026; ranges widened from z = 1.28 to 1.35 because scores have fat tails) | 77.6% before widening | 80% |
| Final rank inside the forecast's 80% range, predicted at mid-event (2026) | 83.4% | 80% |
| True strength inside a rating's 80% "likely range" (simulated events) | 89.5% | 80% |

The ranges err on the cautious side, as intended.

#### Other evidence

- **Schedule luck (simulated events with known true strength):** rank correlation with true strength.

  | Ranking | Correlation |
  |---|---|
  | Actual RS | 0.80 |
  | Luck-adjusted RS | 0.88 |
  | Plain OPR | 0.94 |
  | True Potential | 0.965 |

- **Last-season priors:** raised 2026 official-event accuracy from 78.3% to 80.0%. At events where most teams had no 2026 history, first-third accuracy went from 65.8% to 72.9%.
- **2019 (older test, scores only, different setup):** 74.3% at Championship divisions with priors, against 66.9% without. This used TBA's public CSV archive, with no event-clustered intervals.

#### Things the real 2026 data taught us

These are now handled automatically:

- **Offseason events often use their own bonus thresholds.** Examples include Energized at 75, 150 or 190 fuel. Once a few matches are played, the app reads the real cut-off from the results and marks it "detected" on the Overview.
- **Climbing barely happened at official 2026 events but became common at some offseasons.** When an event scores a component very differently from teams' earlier events, those priors are given less weight so the event's own data takes over.

## Reproducing the results

Run `TBA_KEY=<key> ./tools/reproduce.sh` to regenerate every number above from public data. [REPRODUCE.md](REPRODUCE.md) has the expected output, the backtest's guarantees, known caveats, and a map of where each part of the method lives in the code.

## Project layout

```
index.html        open this
css/app.css
js/games.js       ← season-specific rules (scoring components, bonus RP thresholds, tiebreakers)
js/model.js       rating model, predictions, standings
js/sim.js         ranking simulation + schedule luck
js/tba.js         The Blue Alliance import
js/store.js       local storage, export/import
js/app.js         user interface
js/demo.js        synthetic demo event
tools/test.js     node tools/test.js       — model/simulation sanity tests
tools/test-tba.js node tools/test-tba.js   — TBA import against a mock API
tools/backtest.js node tools/backtest.js <dir-of-*_matches.csv> 2019 — backtest on TBA's public CSV archive
tools/backtest-tba.js node tools/backtest-tba.js events.json <dir> — full-season backtest on raw TBA API data
tools/reproduce.sh    TBA_KEY=... ./tools/reproduce.sh — download data and rerun every published number
tools/compare.js      event-clustered comparison of two prediction sets
tools/fetch-tba.js    download a season from TBA
```

## Adding the 2027 game

The 2027 game is announced in January 2027. Add an entry to `GAMES` in `js/games.js`, copying the 2026 entry, and fill in:

1. **`comps`:** the additive scoring components worth rating, plus `perRobot: true` for any field TBA reports per robot.
2. **`levels` and `bonuses`:** the bonus-RP rules and thresholds per event level.
3. **`tiebreakers`:** the tiebreaker order.
4. **`fromTba()`:** map the new TBA `score_breakdown` field names. Check them against the TBA API spec once the season's first events are posted.
5. **`manual`:** the fields shown on the manual entry form.

Until then, any other year falls back to a generic model that uses total score plus the RP field. After week 1, download that season's events and re-run `tools/backtest-tba.js` to retune the prior strength. Its header comment explains the files it needs.

## Notes and limits

- **Storage:**
  - Data is stored in the browser's local storage for this file. Use one browser consistently, and **Export** a backup before and during events.
  - Clearing browser data erases it. Chrome treats the file as a separate site if you move or rename the folder.
- **Fouls:** results entered by hand without "foul pts received" count fouls as earned points. Those matches are slightly less precise.
- **Defense:** it isn't modelled explicitly. Research shows it is a weak statistical signal, and "DPR" mostly measures schedule luck. Use scouting notes for defense.
- **Robot problems:** in the match editor, set a robot to **Broke** (with when, what and an optional note) or **No-show**.
  - A no-show, or a robot that broke in auto, is treated as contributing nothing that match.
  - A breakdown later in the match leaves that alliance's score out of the ratings.
  - Breakdowns show as ⚠ in the match list, in the Teams table's **Problems** column, and on each team's page. They survive TBA refreshes.
  - **Reliability in predictions:** each team gets a breakdown chance from its recorded problems, blended with the event average as if from 6 matches. Predictions, the ranking forecast and schedule luck all account for it; switch it off in Data → Settings. With nothing recorded it changes nothing.
- **Best Picks tab:** teams ranked by **Pick score**, the points per match you can count on (True Potential × reliability − fouls given away). Tick *Picked* during alliance selection and the list re-ranks what's left; your own team is left out.
- **Alliance Selection tab:**
  - Every alliance starts empty. Drag teams in as they're announced: onto any slot, between slots, or back to the list. Dropping onto a filled slot swaps the two teams.
  - **Add ▸** fills the next slot in selection order.
  - A toggle sorts the available list by **Best robots** (pick score) or **Highest ranked** (event ranking). The choice is remembered.
  - Green **captain · A#** tags in the available list show who would captain each alliance right now. When a would-be captain is placed as a pick, the tag moves to the next-ranked team. For example, if Alliance 1 picks the #2 seed, #2 loses its tag and #9 becomes the expected captain of Alliance 8.
  - Each alliance shows its expected points per match, and placed teams are marked as picked on Best Picks.
- **Likely ranges & confidence:** ratings show an 80% likely range (e.g. "likely 78–106") and a High / Medium / Low confidence tag. Predicted scores show ranges too.
- **Trends:**
  - **This event:** each team is marked improving ↑, steady → or slipping ↓, but only when the change is clearly beyond match noise. About 6% of unchanged teams get flagged, and 5 of 6 real mid-event upgrades were caught in tests.
  - **This season:** the team page shows its rating at each earlier event.
  - **Reliability:** recent breakdowns count more than old ones.
- **Playoff odds:**
  - Alliance Selection shows each alliance's chance to win the event and reach the finals, by simulating the double-elimination bracket. Empty slots are filled with likely picks.
  - **Best next pick** ranks candidates by how much they raise the picking alliance's chance to win the event.
- **Printable reports:** a team report (team page → Print report), a match strategy sheet (Matches → Sheet), and a pick list with checkboxes (Best Picks → Print pick list). Use the print dialog's *Save as PDF* to share them.
- **Scout mode** (Scout tab): one scout per robot.
  - Set your name and seat (Red 1–3 / Blue 1–3) once. Count auto and teleop fuel with big **+1 / +5 / −1** buttons, or **A/Z** and **S/X** on the keyboard.
  - Mark breakdowns, note defense, and press **Enter** to save and jump to your next match.
  - The **Scouting quality** panel adds up the three scouted robots on each alliance and compares the sum with the official fuel count. It shows your typical miss, each scout's habitual over- or under-count, and the matches worth rechecking.
  - Merge laptops with Export / Import; the newest entry per robot, match and scout wins.
  - **Robot path:** trace the robot's route on a to-scale 2026 field.
    - **The field:** it shows the HUBs, BUMPs, TRENCHes (overhead arm dashed, floor post solid), TOWERs, DEPOTs, OUTPOSTs, starting lines, centerline, zones, the starting FUEL pile and the driver stations.
      - Positions come from FIRST's 2026 Field Dimension Drawings and the manual, cross-checked with the AprilTag layout. Driver-station spans are estimates.
      - The layout lives in `js/games.js` (`field`), so a new season's field can be added there.
    - **Several pieces:** lift and drag again as often as you like.
      - A piece that starts where the last one ended continues it.
      - **Link ends** joins two pieces by hand, reversing one if needed. **Erase piece** and **Undo** fix slips.
    - **Markers:** click on a line to add one. It snaps exactly onto the path, points along the direction of travel, and holds a note. Notes sit beside the field.
    - The team page and printed team report show all traced paths for that team, one color per match, with the marker notes listed.
  - **Fuel counted** checkbox: untick it if you only traced the path or lost count. The path and notes are saved, but no fuel number is, so the ratings aren't fed a false 0.
- **Scouted fuel per robot:** the match editor has a **Fuel** box for each robot. Typed counts feed that robot's fuel rating directly, so it no longer has to be estimated from the alliance total.
  - On simulated events, scouting after about 3 matches raised the fuel rating's correlation with true ability from 0.73 to 0.92, roughly what 12 matches of scores alone give.
  - It still helped with sloppy (±30%) counts. Measure it with `node tools/scouting-value.js`.
- **Defense rating:** tested and switched off.
  - It helped on 2025, was borderline on 2026, and made blind 2024 worse, so it failed a rule set before the 2024 test.
  - The code stays for future seasons: set `defenseLambda` to try it again.
- **Scout ratings:** driving 1–5, defense role and robot condition, set on each team page. They're shown in Best Picks and the printed reports, and are scouts' opinions that don't feed the model.
- **Scouting data:** a CSV import is supported. Link a column (e.g. per-robot fuel scored) to a component so it feeds the rating directly.
