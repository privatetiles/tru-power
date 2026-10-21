#!/usr/bin/env bash
# Reproduce every number in REPRODUCE.md from scratch.
#   TBA_KEY=<your read key> ./tools/reproduce.sh [data-dir]
# Needs Node 18+ (uses built-in fetch). Downloads ~200 MB the first time (kept in data-dir).
# Results go to results/ ; the summary is results/summary.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${1:-data}"
OUT=results
: "${TBA_KEY:?Set TBA_KEY to a The Blue Alliance read key (thebluealliance.com/account)}"
mkdir -p "$DATA" "$OUT"

echo "== 1/5 Download data (skips files already present)"
node tools/fetch-tba.js 2026 "$DATA/2026" --matches --oprs
node tools/fetch-tba.js 2025 "$DATA/2025" --matches --oprs
node tools/fetch-tba.js 2024 "$DATA/2024" --matches --oprs
node tools/fetch-tba.js 2023 "$DATA/2023" --oprs
node tools/fetch-tba.js 2022 "$DATA/2022" --oprs

echo "== 2/5 Unit and simulation tests"
node tools/test.js > "$OUT/test.txt"
node tools/test-tba.js > "$OUT/test-tba.txt"
node tools/scouting-value.js > "$OUT/scouting-value.txt"

echo "== 3/5 Season backtests (each match predicted only from earlier matches; ~10 min each, run in parallel)"
# Season S uses season S-1 TBA OPRs for teams with no events yet; the EPA baseline uses S-1 and S-2.
for Y in 2026 2025 2024; do
  P=$((Y - 1)); PP=$((Y - 2))
  node tools/backtest-tba.js "$DATA/$Y/events.json" "$DATA/$Y/matches" '{}' --prev="$DATA/$P/oprs" --ranks \
    --dump="$OUT/tru-$Y.json" > "$OUT/backtest-$Y.txt" &
  node tools/epa-baseline.js "$DATA/$Y/events.json" "$DATA/$Y/matches" "$DATA/$P/oprs" "$DATA/$PP/oprs" \
    --dump="$OUT/epa-$Y.json" > "$OUT/epa-$Y.txt" &
done
wait

echo "== 4/5 Head-to-head with event-level confidence intervals"
for Y in 2026 2025 2024; do
  echo "--- $Y" >> "$OUT/compare.txt"
  node tools/compare.js "$DATA/$Y/matches" "$OUT/tru-$Y.json" "$OUT/epa-$Y.json" "TRU POWER" "Statbotics EPA" >> "$OUT/compare.txt"
done

echo "== 5/5 Summary"
{
  echo "TRU POWER reproduction run — $(date)"
  echo "node $(node --version)"
  for Y in 2026 2025 2024; do echo; echo "### $Y backtest (official events)"; grep -A3 "== official:" "$OUT/backtest-$Y.txt" | grep -vE "energized|supercharged|traversal"; grep "EPA re-implementation" "$OUT/epa-$Y.txt"; done
  echo; echo "### Head-to-head"; cat "$OUT/compare.txt"
  echo; echo "### Tests"; tail -1 "$OUT/test.txt"; tail -1 "$OUT/test-tba.txt"
  echo; echo "### Scouting value"; cat "$OUT/scouting-value.txt"
} > "$OUT/summary.txt"
cat "$OUT/summary.txt"
