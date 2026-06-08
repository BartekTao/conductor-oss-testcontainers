# TC06 Capacity Report - Retry Storm

## Summary

本輪在 fail ratio 0.1 下，最大短跑 SLA candidate 是 **20 workflow starts/s**，實際 task attempt RPS 約 22.9。
本輪掃描範圍內尚未觀察到 cliff。

## Capacity Sweep

| Start RPS | Poll RPS | Started / Expected | Completed | Failed Attempts | Attempt RPS | Observed Amp | Theoretical Amp | Dropped | Start p95 ms | Update p95 ms | Errors | SLA Pass |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 1 | 4 | 30/30 | 30 | 0 | 1.0 | 1.0 | 1.1 | 0 | 67.4 | 31.5 | 0 | PASS |
| 3 | 12 | 90/90 | 87 | 13 | 3.3 | 1.1 | 1.1 | 0 | 60.0 | 20.9 | 0 | PASS |
| 5 | 20 | 150/150 | 150 | 17 | 5.6 | 1.1 | 1.1 | 0 | 39.4 | 19.1 | 0 | PASS |
| 8 | 32 | 240/240 | 239 | 24 | 8.8 | 1.1 | 1.1 | 0 | 31.6 | 17.6 | 0 | PASS |
| 12 | 48 | 361/360 | 356 | 34 | 13.0 | 1.1 | 1.1 | 0 | 47.9 | 19.6 | 0 | PASS |
| 20 | 80 | 601/600 | 590 | 97 | 22.9 | 1.1 | 1.1 | 0 | 15.0 | 13.7 | 0 | PASS |

## Interpretation

TC06 的 capacity 不是單純 workflow start RPS，而是 retry policy 放大後的 task attempt pressure。SLA candidate 需同時滿足 start/update latency、API error、dropped iterations、completion ratio 與 retry amplification 可解釋性。

## Artifacts

Raw and selected summaries are archived in the same capacity run directory.