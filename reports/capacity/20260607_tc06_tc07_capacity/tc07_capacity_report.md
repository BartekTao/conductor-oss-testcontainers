# TC07 Capacity Report - Worker Crash Recovery

## Summary

本輪在 crash ratio 0.5 下，最大短跑 SLA candidate 是 **8 workflow starts/s**，recovered-to-crashed ratio 1.0。
本輪掃描範圍內尚未觀察到 cliff。

## Capacity Sweep

| Start RPS | Crash Poll RPS | Recovery Poll RPS | Started / Expected | Crashed | Recovered | Completed Ratio | Recovered Ratio | Recovery p95 ms | Dropped | Errors | SLA Pass |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 1 | 4 | 6 | 16/15 | 3 | 3 | 1.0 | 1.0 | 35302.7 | 0 | 0 | PASS |
| 2 | 8 | 12 | 31/30 | 6 | 6 | 1.0 | 1.0 | 35148.5 | 0 | 0 | PASS |
| 3 | 12 | 18 | 46/45 | 8 | 8 | 1.0 | 1.0 | 35458.8 | 0 | 0 | PASS |
| 5 | 20 | 30 | 76/75 | 18 | 18 | 1.0 | 1.0 | 35471.3 | 0 | 0 | PASS |
| 8 | 32 | 48 | 120/120 | 27 | 27 | 1.0 | 1.0 | 36132.2 | 0 | 0 | PASS |

## Interpretation

TC07 使用 `TASK_TIMEOUT_POLICY=RETRY` 量測 worker poll 後不回報時，task timeout retry 與 recovery worker 的恢復能力。第一版 recovery latency 是從 workflow createdAtMs 到 recovery complete 的近似值，不能解讀為精準 crash-to-repoll latency。

## Artifacts

Raw and selected summaries are archived in the same capacity run directory.