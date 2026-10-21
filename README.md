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
   - Use **Data → Export**, then AirDrop or USB the file.
   - On the other laptop, use **Import**. It merges with what is already there; the newest result wins.
   - Hotspots are illegal at events (manual rule E301), so this is the way to share.

If you have no internet at all, use **Data → Create event manually**. Then paste the schedule in the Matches tab (`Q1 254 1678 971 118 148 1323` per line).

**Keyboard:** keys `1`–`7` switch tabs; `Esc` closes a popup; `Enter` saves a match.

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

#### Real 2026 REBUILT season

This is the most important test. It covers every 2026 event on TBA, 18,371 decided qualification matches.
- Events were processed in date order.
- Each event's priors come only from events that had already finished.
- Each match was predicted from earlier matches only.

| | Official events (208) | Offseasons (93) |
|---|---|---|
| **Match winner accuracy** | **80.0%** | **77.6%** |
| Accuracy, first third of each event | 76.1% | 75.7% |
| Brier score (lower is better; coin flip = 0.25) | 0.140 | 0.152 |
| Plain OPR, for comparison | 76.1% (69.6% early) | 73.9% |
| Energized RP chance: predicted vs actual | 57.8% vs 58.1% | 62.3% vs 57.2% |
| Supercharged RP chance: predicted vs actual | 6.4% vs 8.2% | 9.8% vs 12.5% |

- Win chances are well calibrated: when it says 75%, the favourite wins about 77% of the time.
- Schedule luck averaged ±0.23 RP per match. Removing it changes about 1.3 of the top-8 seeds at a typical event.

#### 2019 season

The 2019 backtest uses TBA's public archive, so it is scores only.

| | Accuracy | Brier |
|---|---|---|
| Plain OPR, within event | 65.7% | 0.210 |
| This model, no priors | 67.4% | 0.202 |
| With priors, Championship divisions | 74.3% | 0.169 |
| Statbotics EPA at 2019 Championship (reference) | 72.2% | — |

#### Synthetic events with known true strength

Rank correlation with true strength:

| Ranking | Correlation |
|---|---|
| Actual RS | 0.80 |
| Luck-adjusted RS | 0.88 |
| Plain OPR | 0.94 |
| True Potential | 0.965 |

**Against Statbotics EPA:** on the same 15,132 matches, EPA (re-implemented from Statbotics' open-source code) scored 79.9% with a Brier of 0.1446. TRU POWER ties on picking winners and has significantly better win probabilities (Brier 0.1396). See RESEARCH.md §10.

**Last season's results** are used as a starting rating for teams with no events yet this season, via TBA's per-event OPRs from the previous year. This raised official-event accuracy from 78.3% to 80.0%. At events where most teams were on their first event, early-match accuracy went from 65.8% to 72.9%.

#### Things the real 2026 data taught us

These are now handled automatically:

- **Offseason events often use their own bonus thresholds.** Examples include Energized at 75, 150 or 190 fuel. Once a few matches are played, the app reads the real cut-off from the results and marks it "detected" on the Overview.
- **Climbing barely happened at official 2026 events but became common at some offseasons.** When an event scores a component very differently from teams' earlier events, those priors are given less weight so the event's own data takes over.

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
- **Scouting data:** a CSV import is supported. Link a column (e.g. per-robot fuel scored) to a component so it feeds the rating directly.
