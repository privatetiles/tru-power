# TRU POWER — Research Notes (2026-10-17)

Goal: an offline, fast tool that estimates each FRC team's **true potential**, meaning robot strength separated from schedule luck, and predicts matches and rankings at competitions.

---

## 1. Rating methods — what works

| Method | Idea | Strengths | Weaknesses |
|---|---|---|---|
| **OPR** | Least squares: alliance score ≈ sum of team contributions. Solve (AᵀA)x = Aᵀb | Credits partners jointly | Undefined or noisy early in an event (only 10–12 matches per team); overstates the gaps between teams |
| **DPR / CCWM** | Same fit on opponent score / on margin | — | DPR measures **opponent luck, not defense** (Gardner 2015) |
| **MMSE / ridge OPR** | (AᵀA + λI)x = Aᵀb + λ·prior, λ≈3 | Stable from match 1; uses a prior | Needs a prior |
| **ixOPR** (Sykes) | Fill unplayed matches with predicted scores, iterate twice | Stable early | Every team needs a prior |
| **EPA** (Statbotics) | Per match: EPA ← EPA + p(n)·error/3, with p = 1/3 for n≤6 falling to 0.2 at n≥12 | Most accurate of these (≈72–77% of match winners) | Ignores partner correlation |
| **Elo** (Sykes) | Margin-based, K=12 in quals / 3 in playoffs, 20% reversion between seasons | Good by Championship | Less accurate than EPA early |

**Key insight:** ridge OPR with a per-team prior is the Bayesian posterior (a batch Kalman filter). It contains OPR (no prior), TBA Insights (λ=3) and EPA (diagonal, fixed gain) as special cases. It also gives **uncertainty per team** at no extra cost, which feeds honest Monte Carlo.

**Prediction accuracy ceiling:** about 70–78% of match winners, Brier 0.15–0.18. Claims above about 80% are usually leaky (in-sample).

**Statbotics constants**
- Win probability: P(red) = 1/(1+10^(−5/8·(S_R−S_B)/σ_w1)), where σ_w1 is the week-1 alliance score SD.
- Season start: rookies and teams with no history start at −0.2 SD (Elo 1450).
- Season-to-season prior: 0.7·last year + 0.3·two years ago, then reverted 40% toward the rookie value.
- Bonus RP probability: σ(4(x−0.5)).
- Playoff matches are weighted 1/3; scores exclude foul points.

**Blending the prior with event data:** event data weight ≈ n/(n+λ), λ≈3. That gives about 50% weight after 3 matches and about 80% after 12.

## 2. Strength of schedule (SOS)

- **Statbotics SOS:** for each team, compare expected RP and rank on the *actual* schedule against N *random balanced* schedules. Each comparison gives a percentile, and the composite is their average. Analytic shortcut: ΔEPA = TP + 2·avg(partner) − 3·avg(opponent), with SD √(5σ²/N).
- **Sykes:** recommends *Average Rank Difference*: average over a team's matches of (Σ opponent ranks − Σ partner ranks) − (T+1)/2, divided by T. It needs no simulator. Going from 7 to 12 matches per team roughly halves schedule variance.
- **Our plan:** schedule luck = E[RS | actual schedule] − E[RS | random schedules]. **SOS-adjusted RS = actual RS − schedule luck.**

## 3. 2026 game — REBUILT (source: Game Manual and Team Update 22)

- Auto 20 s, teleop 2:20.
- FUEL: 1 point each in an *active* hub.
- Hub shifts: in Shift 1, the hub of the alliance that won auto (scored more auto FUEL) is inactive. Hubs then alternate.
- TOWER: L1 is 15 points in auto (at most 2 robots) or 10 in teleop; L2 is 20; L3 is 30.
- Fouls: a minor foul gives the opponent 5 points, a major foul 15.
- RP: win 3 / tie 1, plus three bonus RPs, so up to 6 per match. Thresholds by event level:

  | Bonus RP | Earned for | Regional/District | DCMP | CMP |
  |---|---|---|---|---|
  | ENERGIZED | FUEL in active hub ≥ | 100 | 240 | 360 |
  | SUPERCHARGED | FUEL ≥ | 360 | 360 | 500 |
  | TRAVERSAL | TOWER points ≥ | 50 | 50 | 50 |
- Ranking order: RS (= total RP / matches, surrogate match excluded) → average no-foul match points → average auto FUEL → average TOWER points → random.
- Per-robot data in the TBA breakdown: tower fields only (`autoTowerRobotN`, `endGameTowerRobotN`). FUEL is recorded per alliance (`hubScore.*Count`), so per-team FUEL has to come from component OPR or scouting.

## 4. Data sources (all allow browser CORS, so they can be called from a local file)

- **TBA v3** (`X-TBA-Auth-Key`):
  - `/event/{key}/matches`, `/teams/simple`, `/rankings`, `/coprs`, `/team/{key}/events/{year}`
  - Supports ETag / If-None-Match.
- **FRC Events API v3.0** (Basic auth): schedule, scores, rankings.
- **Statbotics v3** (no auth): team_year and team_event EPA. **Unreliable** (500/503 errors during testing), so snapshot it before events.

## 5. Venue constraints

- Manual **E301**: team wireless networks are prohibited, and **phone hotspots count as access points**.
- Cell data is allowed but often poor in venues.
- This is why existing tools (ScoutingPASS and others) preload data and move it by QR code.

## 6. Architecture findings

- **Single self-contained HTML file:** works from file:// on laptops, TBA fetch works from file://, localStorage works.
- **iOS cannot run a local HTML file**, so phones use the same file hosted on GitHub Pages as a PWA, added to the home screen.
- **Speed (benchmarked):** OPR solve for 70 teams ≈ 0.1 ms; 10k Monte Carlo event simulations ≈ 115 ms on a laptop. Run them in a Web Worker.
- **Data sharing:**
  - QR codes: compact arrays, about 40 B per match.
  - JSON export/import with merge by match key.
  - iOS may delete PWA storage after 7 days of non-use, so always keep export available.
- **Python** is fine for pre-event or analyst work, but not as the at-event tool (no phones, install friction on school laptops).

## Sources

- Statbotics source code: github.com/avgupta456/statbotics
- statbotics.io/blog/epa, statbotics.io/blog/sos
- TBA `prediction_helper.py`
- Gardner 2015 MMSE paper (Chief Delphi)
- Sykes SOS series on the TBA blog (2019)
- Krotkov et al. 2024 (Wharton)
- 2026 Game Manual and Team Update 22

---

## 7. Our backtest results (2019 TBA data; each match predicted only from earlier matches)

| Setting | Within-event, all 187 events | DCMP (14) | Champs divisions (12) |
|---|---|---|---|
| OPR-like (λ≈0) | 65.7% / Brier 0.210 | – | – |
| Ridge λ=2, no priors | 67.4% / 0.202 | 62.5% / 0.223 | 66.9% / 0.206 |
| Priors (mean of earlier events), λ=3 | – | 67.0% / 0.206 | 73.1% / 0.175 |
| **Priors, λ=5, +50% per extra event (max 2×), the chosen default** | – | **68.1% / 0.201** | **74.3% / 0.169** |
| Priors from most recent event only, λ=5 | – | 66.6% / 0.212 | 73.1% / 0.175 |

**Findings**
- Priors matter most early in an event: champs accuracy in the first third of matches is 73.6% with priors vs 60.2% without.
- Averaging all earlier events beats using only the most recent one.
- Calibration is good. There is a slight red-side bias in 2019 (actual red-win rate is about 2–3 points above predicted).

**Synthetic validation** (40 simulated events with known true strength), Spearman rank correlation with true strength:

| Ranking | Correlation |
|---|---|
| Actual RS | 0.80 |
| Luck-adjusted RS | 0.88 |
| Raw OPR | 0.94 |
| True Potential | 0.965 |

---

## 8. Real 2026 backtest (TBA API, all 345 events, 18,423 played quals)

The backtest uses the app's own code (`tools/backtest-tba.js`). Events run in date order, priors come only from events that had already finished, and each match is predicted from earlier matches only.

Accuracy / Brier at official events (offseason in brackets):

| Prior strength λ | Accuracy / Brier |
|---|---|
| **λ = 3 (chosen default)** | **78.3% / 0.1458** (77.5% / 0.1512) |
| λ = 5 | 78.4% / 0.1466 (77.3% / 0.1529) |
| λ = 8 | 78.0% / 0.1482 |
| OPR-like (λ ≈ 0) | 76.1% / 0.1636; early 69.6% vs 72.7% |

**Data facts verified on real 2026 data**
- **Breakdown fields:** they match the TBA spec.
- **Fuel:** `hubScore.totalCount` counts only fuel that scored. Inactive-hub fuel is reported separately as `uncounted`.
- **Fouls:** `foulPoints` is the points *received* from the opponent's fouls.
- **Score check:** totalPoints = hub points + tower points + foulPoints + adjustPoints in every alliance checked.
- **Per-robot tower:** the per-robot tower levels add up to `totalTowerPoints` in 45,438 of 45,442 alliances.
- **Official bonus thresholds:** they match the manual exactly — 100/360 at regionals and districts, 240/360 at DCMP, 360/500 at Championship.
- **Offseason bonus thresholds:** they vary widely, e.g. Energized at 75, 150, 190 and 240. The app now infers each event's threshold from its results.
- **Climbing:** it was rare at official events (Championship: 220 of 250 alliances scored 0 tower points) but common at some offseasons, e.g. 2026bc. Prior rescaling is capped at 0.5–2×, and priors are down-weighted when an event departs further than that.

---

## 9. Accuracy experiments (2026 backtest, official events, baseline 78.3% / Brier 0.1458)

| Idea | Result | Kept? |
|---|---|---|
| Recency-weighted priors (decay 0.5 / 0.7) | 78.4% / 0.1456 — noise | no |
| Recency weighting within an event (0.9 / 0.8 per round) | same or worse (0.1478 / 0.1517) | no |
| Expected foul points in win probability | 78.1% / 0.1466 — slightly worse | no |
| Sharpening z (×1.1 / ×1.2) | 0.1455 / 0.1456 — noise | no |
| **Last-season prior (TBA OPR relative to the season mean, 90% carried over, λ=3) for teams with no current-season events** | **80.0% / 0.1396**; low-coverage events early 65.8% → 72.9% | **yes** |

**Conclusion:** the model is well tuned on the information it has. The gains came from new information (last season), not from tweaks. The next lever would be scouting data on per-robot fuel, the one big quantity TBA reports only per alliance.

---

## 10. Head-to-head vs Statbotics EPA (2026, identical 15,132 official qual matches)

The Statbotics API was down (HTTP 500/503), so EPA was re-implemented from their source code in `tools/epa-baseline.js`. It uses the same constants, initialization, update rule, win-probability formula and chronological processing as Statbotics. The previous-season norm EPA is approximated by a TBA-OPR z-score, using 2025 and 2024.

| Model | Accuracy | Brier |
|---|---|---|
| **TRU POWER** | **79.98%** | **0.1396** |
| Statbotics EPA (re-implemented) | 79.94% | 0.1446 |
| Average of both | 80.54% | 0.1392 |

**Paired comparison:** TRU POWER's Brier is better by 0.0050 ± 0.0014 (95% CI; z = 7.1), so the difference is statistically significant. Picking the winner is a tie; TRU POWER's win probabilities are better calibrated and sharper.

**Caveat:** the real Statbotics numbers could differ slightly from this re-implementation (its normalized-EPA mapping and data cleaning were not replicated).

---

## 11. Round 5: held-out testing, honest ranges, trends, alliances, reports

**Held-out season (2025, frozen settings).** On official events, TRU POWER called 78.1% with a Brier of 0.1493. EPA (re-implemented) got 78.1% / 0.1523, and OPR 74.7% / 0.1709. Paired Brier advantage over EPA: 0.0030 ± 0.0013 (z = 4.4). The gains from tuning on 2026 carry over to an unseen game.

**Range calibration**
- **Alliance-score 80% intervals at z = 1.2816:** covered 77.6% (2026) and 78.3% (2025). Score errors have fat tails (breakdowns, fouls, jams), so displayed score ranges use z = 1.35.
- **Halfway rank forecast, 80% ranges:** covered 83.4% of final ranks (2026 official) and 84.0% (offseason). The average absolute rank error is 3.9, which is slightly conservative.
- **Rating 80% ranges vs. known truth (simulated):** 89.5%, also conservative.

**Alliance compatibility (is scoring additive?)**
- **Method:** regress alliance residuals on the squared alliance strength, using OLS ratings so shrinkage doesn't create a fake effect.
- **2026:** +2% for the strongest alliances (t = 9).
- **2025:** −3% (t = −7), consistent with contention for game pieces.
- **Conclusion:** the effect is real but tiny, a few points per match, so alliance strength stays additive.
- **Consequence:** whole-alliance evaluation is done through playoff bracket simulation instead.
- **Note:** with ridge ratings (λ = 1.5) the same test shows a spurious +16%, a shrinkage artifact worth remembering.

**Trend detection**
- **Method:** the slope of a team's alliance residuals over its clean matches.
- **Threshold:** at |t| > 1.5, 15.8% of unchanged teams were falsely flagged. At |t| > 2.2 that drops to 6.4%, and 5 of 6 injected +60-point upgrades are still caught.
- **Usage:** display only, since recency weighting did not improve 2026 predictions (§9).
- **Reliability:** reliability now discounts problems by 0.85 per match of age.

---

## 12. Round 6: addressing the review's limitations

**1. Benchmark is a re-implementation.** The Statbotics API still returned HTTP 500 on 2026-10-20. Rerun `tools/epa-baseline.js` against live predictions when it returns. The held-out 2025 result already shows the edge is not a 2026 artifact.

**2. Per-robot fuel is estimated.** Added per-robot scouted fuel entry to the match editor; it is stored as scouting rows mapped to the fuel component. `tools/scouting-value.js` measures the effect on simulated events where true ability is known (12 seeds each), as correlation of the fuel rating with true ability:

| Matches per team | Scores only | Scouting (±10% counts) | Scouting (±30% counts) |
|---|---|---|---|
| ~3 | 0.728 | 0.920 | 0.895 |
| ~6 | 0.863 | 0.963 | 0.949 |
| ~12 | 0.942 | 0.980 | 0.971 |

- Typical error after ~3 matches: 14.2 → 8.3 fuel.
- Scout weight 3 beat 1 even with sloppy counts, so the default is now 3.

**3. Can't see defense, driving, condition.** A two-stage defense rating was added: alliance residuals regressed on opposing teams with ridge λd.

| λd | 2026 Brier | 2025 Brier (held out) |
|---|---|---|
| none | 0.1396 | 0.1493 |
| 10 | 0.1402 | 0.1478 |
| **30 (default)** | **0.1393** | **0.1481** |
| 100 | 0.1394 | 0.1488 |

- λd = 30 is the only setting better on both seasons. Accuracy is 79.9% (2026) and 78.3% (2025).
- The defense signal is small but real, and larger in 2025.
- Driving quality and robot condition cannot be read from scores. Qualitative scout ratings were added for display only.
