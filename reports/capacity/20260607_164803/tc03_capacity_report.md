# TC03 Capacity Report - Preloaded Independent Poll Scaling

## Summary

本輪最大短跑 SLA candidate 是 **1 pairs x 40 RPS**，total target 40 RPS，scaling efficiency 1.0。

## Capacity Sweep

| Round | Target Total RPS | Completed / Expected | Achieved RPS | Efficiency | Dropped | Poll p95 ms | Complete p95 ms | Errors | SLA Pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 1 pairs x 40 | 40 | 601/600 | 40.1 | 1.0 | 0 | 9.3 | 12.0 | 0 | PASS |
| 2 pairs x 20 | 40 | 573/600 | 38.2 | 1.0 | 28 | 1368.9 | 1091.1 | 0 | FAIL |
| 2 pairs x 40 | 80 | 1075/1200 | 71.7 | 0.9 | 127 | 2452.6 | 2218.5 | 0 | FAIL |
| 4 pairs x 20 | 80 | 1016/1200 | 67.7 | 0.8 | 188 | 2859.3 | 3571.4 | 0 | FAIL |
| 4 pairs x 40 | 160 | 1644/2400 | 109.6 | 0.7 | 759 | 5745.7 | 5142.5 | 0 | FAIL |

## Interpretation

TC03 觀察多 workflow/task pair 的 queue scaling。SLA candidate 不只看 total throughput，還必須確認每輪沒有 dropped iterations，且整體 poll/update latency 仍低於 guardrail。

## Artifacts

Raw and selected summaries are archived in the same capacity run directory.