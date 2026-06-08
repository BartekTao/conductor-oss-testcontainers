# TC01 Capacity Report - Preloaded Workflow Poll Task

## Summary

本輪最大短跑 SLA candidate 是 **40 poll RPS**，實際 completed RPS 約 40.1。

## Capacity Sweep

| Target RPS | Completed / Expected | Achieved RPS | Dropped | Poll p95 ms | Complete p95 ms | Errors | SLA Pass |
|---:|---:|---:|---:|---:|---:|---:|:---:|
| 20 | 301/300 | 20.1 | 0 | 27.4 | 43.6 | 0 | PASS |
| 40 | 601/600 | 40.1 | 0 | 279.3 | 26.1 | 0 | PASS |
| 50 | 719/750 | 47.9 | 31 | 822.7 | 1143.0 | 0 | FAIL |
| 60 | 900/900 | 60.0 | 0 | 651.5 | 48.6 | 0 | FAIL |
| 75 | 1030/1125 | 68.7 | 96 | 1876.2 | 2215.9 | 0 | FAIL |
| 100 | 1172/1500 | 78.1 | 329 | 3875.0 | 3333.7 | 0 | FAIL |

## Interpretation

TC01 只量測 preloaded backlog 下的單 queue `poll -> complete` 能力，不把 workflow create 算進 capacity scoring。短跑 SLA candidate 需同時滿足零錯誤、零 dropped iterations、poll/update p95 低於 500ms。

## Artifacts

Raw and selected summaries are archived in the same capacity run directory.