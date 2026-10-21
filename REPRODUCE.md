# Reproducing TRU POWER's results

Everything in the README's validation section can be regenerated from public data with one command. This page covers how to run it, what you should see, and where to look in the code.

## Run it

Requirements:
- Node 18 or newer. The published numbers were made with Node 22.
- A free read key from [The Blue Alliance](https://www.thebluealliance.com/account).
- About 200 MB of disk.

```
TBA_KEY=<your key> ./tools/reproduce.sh
```

The script runs in five stages:
1. Downloads 2022–2026 data into `data/`. Files already present are skipped, so it can be rerun.
2. Runs the test scripts.
3. Backtests three seasons for TRU POWER and the Statbotics EPA re-implementation, in parallel. This takes about 10 minutes.
4. Compares them with event-level confidence intervals.
5. Writes `results/summary.txt`.

Everything is deterministic: fixed random seeds, no time-dependent logic. The one thing that can move results is TBA itself: late score corrections or newly added offseason events can shift the last digit.

The numbers below are from a full run of `reproduce.sh` on 2026-10-20 with Node 22.22.1.

## Expected results

The complete tables (accuracy with intervals, Brier, Brier skill, log loss, calibration, results by event phase) are published in [docs/backtest/BACKTEST.md](docs/backtest/BACKTEST.md). The script regenerates them into `results/backtest/` for comparison. `docs/backtest/predictions-all.csv` has every match's predictions, so any number can be checked without rerunning the backtest.

**Brier score:** mean (p − outcome)². It runs from 0 (perfect) to 1, always predicting 50% scores exactly 0.25, and lower is better.

### Headline numbers

**Official-event qualification matches**, each predicted only from matches before it (`backtest-tba.js`, `epa-baseline.js`):

| Season | Matches | TRU POWER winners / Brier | Statbotics EPA (re-implemented) winners / Brier |
|---|---|---|---|
| 2026 (settings tuned here) | 15,132 | 80.0% / 0.1397 | 79.9% / 0.1446 |
| 2025 (blind) | 14,686 | 78.1% / 0.1493 | 78.1% / 0.1522 |
| 2024 (blind) | 13,937 | 77.0% / 0.1565 | 77.0% / 0.1573 |

**Head-to-head** with 95% intervals from resampling whole events (`metrics.js`; the canonical numbers are in BACKTEST.md):

| Season | Brier advantage (95% range) | Accuracy difference (95% range) | Events where TRU POWER's Brier is better |
|---|---|---|---|
| 2026 | 0.0050 (0.0032 to 0.0068) | +0.05 pts (−0.42 to +0.49) | 133 / 208 |
| 2025 | 0.0029 (0.0013 to 0.0044) | −0.07 pts (−0.55 to +0.42) | 119 / 198 |
| 2024 | 0.0008 (−0.0007 to +0.0024) | −0.04 pts (−0.49 to +0.43) | 94 / 185 |

`tools/compare.js` gives the same point estimates. It draws its bootstrap resamples in a different order, so the last digit of an interval can differ from BACKTEST.md; BACKTEST.md is the reference.

**Tests**
- `test.js` and `test-tba.js` print `ALL TESTS PASSED` / `TBA IMPORT TESTS PASSED`.
- `test.js` also reports:
  - rating ranges cover the true strength ~89.5% of the time (target 80%)
  - trend detection catches 5 of 6 upgrades, with 6.4% false alarms
- `scouting-value.js`, after ~3 matches per team:
  - **Careful scouts:** the fuel rating's correlation with true ability rises from 0.728 to 0.919 with raw counts, and 0.921 using scouts only for shares of the official total.
  - **Sloppy and biased scouts:** the same pattern holds.

## What the backtest guarantees

- **Order:** events are processed by start date. A team's starting rating uses only events whose end date is before the current event's start date. The same applies to the match-noise setting.
- **Per match:** each qualification match is predicted from a fit on that event's earlier matches only (`include` filter). Bonus-RP thresholds are inferred from those same earlier matches.
- **Last season:** the prior for teams with no events yet comes from the previous season's TBA OPRs, which were complete before the season began.
- **Scope:** only decided qualification matches count. Ties are skipped, and playoffs are excluded from scoring.

## Known caveats (please check these)

1. **The EPA baseline is a re-implementation.** It's built from Statbotics' open-source code (`backend/src/models/epa`) because its API returned errors throughout testing. There are two approximations:
   - The previous-season normalized EPA is replaced by a z-score of TBA OPR.
   - Week-1 season constants use all of week 1, as Statbotics does. That gives the baseline a little future information, which favors it.
2. **Settings were tuned on 2026.** The prior strength (λ = 3), the extra weight per earlier event and the last-season shrink (0.9) were all chosen on 2026, so 2025 and 2024 are the clean tests.
   - The defense rating was tuned on 2026 and 2025, failed a rule set before the 2024 run, and is off.
3. **2024 and 2025 use the generic game definition.** That means total score, fouls and the RP field, without the season-specific components that 2026 has.
4. **Some evidence is simulation-based.** The scouting-value numbers and the trend-detection rates come from synthetic events whose true strengths are known (`js/demo.js`). They depend on how realistic that simulator is.

## Where the logic lives

| Topic | File · function |
|---|---|
| Rating model (ridge component OPR with priors) | `js/model.js` · `fitComponent`, `collectRows`, `fit` |
| Priors from earlier events, last-season priors, rescaling | `js/model.js` · `fitComponent` (scale/trust); `js/tba.js` · `buildPriors`, `buildPrevYear` |
| Match prediction, bonus RP chances | `js/model.js` · `allianceDist`, `predictAlliance`, `predictMatch`, `eventThresholds` |
| Reliability (breakdowns) | `js/model.js` · `robotIssue`, `reliabilityOf` |
| Trends | `js/model.js` · `trendWithin` |
| Ranking forecast, schedule luck, playoff odds | `js/sim.js` · `simulateRankings`, `scheduleLuck`, `playoffOdds` |
| Season backtest | `tools/backtest-tba.js` |
| Statbotics EPA baseline | `tools/epa-baseline.js` |
| Event-clustered comparison | `tools/compare.js` |
| Data download | `tools/fetch-tba.js` |
