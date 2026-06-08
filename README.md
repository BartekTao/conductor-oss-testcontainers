# Conductor Performance Capacity Tests

This repository contains k6 scenarios for Conductor + MariaDB Queue capacity
experiments. The main capacity workflow is:

1. Run a repeatable capacity matrix with `scripts/run_capacity.sh`.
2. Archive each round's `*_summary.json` and `*_raw_summary.json`.
3. Generate Markdown reports with `scripts/generate_capacity_report.mjs`.

The local default target is:

```bash
BASE_URL=http://localhost:8080
API_PREFIX=/api
```

## Capacity Runner

Run all supported capacity suites:

```bash
BASE_URL="http://localhost:8080" \
TEST_CASES="tc01,tc03,tc06,tc07" \
./scripts/run_capacity.sh
```

Run only TC06 and TC07:

```bash
BASE_URL="http://localhost:8080" \
TEST_CASES="tc06,tc07" \
RUN_ID="$(date +%Y%m%d_%H%M%S)_tc06_tc07" \
./scripts/run_capacity.sh
```

Artifacts are written to:

```text
reports/capacity/<RUN_ID>/
```

Each run directory contains per-round summaries plus:

```text
capacity_index.md
tc01_capacity_report.md
tc03_capacity_report.md
tc06_capacity_report.md
tc07_capacity_report.md
```

Only reports for selected test cases are generated.

## Capacity Matrix Defaults

The runner defaults are short capacity sweeps. They are useful for finding a
candidate range, but product SLA should still be confirmed with longer soak
runs on the target deployment shape.

```bash
TC01_RPS_LIST="20 40 50 60"
TC01_DURATION="15s"
TC01_PRELOAD_FACTOR=2

TC03_PAIR_COUNT_LIST="1 2 4"
TC03_PAIR_POLL_RPS=40
TC03_DURATION="15s"
TC03_MAX_PAIR_COUNT=4
TC03_PRELOAD_FACTOR=2
TC03_BASELINE_RPS=40

TC06_START_RPS_LIST="1 3 5 8"
TC06_DURATION="30s"
TC06_FAIL_RATIO=0.10
TC06_RETRY_COUNT=1
TC06_RETRY_DELAY_SECONDS=1
TC06_POLL_MULTIPLIER=4

TC07_START_RPS_LIST="1 2 3"
TC07_DURATION="15s"
TC07_RECOVERY_GRACE_DURATION="60s"
TC07_CRASH_RATIO=0.50
TC07_RETRY_COUNT=1
TC07_RETRY_DELAY_SECONDS=1
TC07_RESPONSE_TIMEOUT_SECONDS=3
TC07_TIMEOUT_SECONDS=20
TC07_TASK_TIMEOUT_POLICY=RETRY
TC07_CRASH_POLL_MULTIPLIER=4
TC07_RECOVERY_POLL_MULTIPLIER=6
```

## Current Local Capacity Reports

Latest TC06/TC07 local capacity run:

```text
reports/capacity/20260607_tc06_tc07_capacity/
```

Reports:

```text
reports/capacity/20260607_tc06_tc07_capacity/tc06_capacity_report.md
reports/capacity/20260607_tc06_tc07_capacity/tc07_capacity_report.md
```

Observed short-run candidates from that run:

| Test | Condition | Highest Stable Point Scanned | Cliff Found |
|---|---|---:|:---:|
| TC06 | `FAIL_RATIO=0.10`, `RETRY_COUNT=1` | 20 workflow starts/s | No |
| TC07 | `CRASH_RATIO=0.50`, `TASK_TIMEOUT_POLICY=RETRY` | 8 workflow starts/s | No |

Because no cliff was reached, these are scanned upper bounds, not final hard
limits. Increase the matrix to continue searching.

## Finding Higher Limits

Continue TC06 from the current upper range:

```bash
BASE_URL="http://localhost:8080" \
TEST_CASES="tc06" \
RUN_ID="$(date +%Y%m%d_%H%M%S)_tc06_capacity" \
TC06_START_RPS_LIST="20 30 40 60" \
TC06_DURATION="1m" \
TC06_FAIL_RATIO=0.10 \
TC06_RETRY_COUNT=1 \
TC06_RETRY_DELAY_SECONDS=1 \
TC06_POLL_MULTIPLIER=4 \
./scripts/run_capacity.sh
```

Continue TC07 from the current upper range:

```bash
BASE_URL="http://localhost:8080" \
TEST_CASES="tc07" \
RUN_ID="$(date +%Y%m%d_%H%M%S)_tc07_capacity" \
TC07_START_RPS_LIST="8 12 16 24" \
TC07_DURATION="30s" \
TC07_RECOVERY_GRACE_DURATION="90s" \
TC07_CRASH_RATIO=0.50 \
TC07_RETRY_COUNT=1 \
TC07_RETRY_DELAY_SECONDS=1 \
TC07_RESPONSE_TIMEOUT_SECONDS=3 \
TC07_TIMEOUT_SECONDS=20 \
TC07_TASK_TIMEOUT_POLICY=RETRY \
TC07_CRASH_POLL_MULTIPLIER=4 \
TC07_RECOVERY_POLL_MULTIPLIER=6 \
./scripts/run_capacity.sh
```

Longer SLA confirmation example:

```bash
BASE_URL="http://localhost:8080" \
TEST_CASES="tc01,tc03,tc06,tc07" \
RUN_ID="$(date +%Y%m%d_%H%M%S)_soak" \
TC01_DURATION="10m" \
TC03_DURATION="10m" \
TC06_DURATION="10m" \
TC07_DURATION="10m" \
TC07_RECOVERY_GRACE_DURATION="3m" \
./scripts/run_capacity.sh
```

## Test Case Models

### TC01

Single workflow/task queue poll capacity. Setup preloads workflow instances;
runtime only measures worker `poll -> complete`.

Script:

```text
k6/scenarios/tc01_preloaded_workflow_poll_capacity.js
```

Primary variable:

```text
POLL_RPS
```

### TC03

Multi workflow/task pair poll scaling. Setup creates independent pairs and
preloads backlog per active pair; runtime has one worker scenario per pair.

Script:

```text
k6/scenarios/tc03_preloaded_independent_poll_scale.js
```

Primary variables:

```text
PAIR_COUNT
PAIR_POLL_RPS
```

### TC06

Retry storm capacity. Runtime includes producer and worker. Worker completes or
injects `FAILED` according to `FAIL_RATIO`, so capacity is measured as workflow
start RPS plus retry-amplified task attempts.

Script:

```text
k6/scenarios/tc06_retry_storm.js
```

Primary variables:

```text
WORKFLOW_START_RPS
POLL_RPS
FAIL_RATIO
RETRY_COUNT
RETRY_DELAY_SECONDS
```

### TC07

Worker crash / response timeout recovery capacity. Runtime includes producer,
crash worker, and recovery worker. Crash worker simulates a worker crash by
polling a task and not sending any task update. Recovery requires:

```text
TASK_TIMEOUT_POLICY=RETRY
```

Script:

```text
k6/scenarios/tc07_worker_crash_recovery.js
```

Primary variables:

```text
WORKFLOW_START_RPS
CRASH_WORKER_POLL_RPS
RECOVERY_WORKER_POLL_RPS
CRASH_RATIO
RESPONSE_TIMEOUT_SECONDS
TIMEOUT_SECONDS
TASK_TIMEOUT_POLICY
```

## Smoke Commands

Use smoke commands only to verify local executability, not for SLA.

TC01:

```bash
k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_tc01_smoke" \
  -e TASK_TYPE="perf_task_tc01_smoke" \
  -e PRELOAD_WORKFLOW_COUNT=3 \
  -e POLL_RPS=1 \
  -e TEST_DURATION="5s" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=false \
  k6/scenarios/tc01_preloaded_workflow_poll_capacity.js
```

TC03:

```bash
k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_PREFIX="wf_perf_tc03_smoke" \
  -e TASK_PREFIX="perf_task_tc03_smoke" \
  -e MAX_PAIR_COUNT=1 \
  -e PAIR_COUNT=1 \
  -e PAIR_PRELOAD_WORKFLOW_COUNT=6 \
  -e PAIR_POLL_RPS=1 \
  -e TEST_DURATION="3s" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=false \
  k6/scenarios/tc03_preloaded_independent_poll_scale.js
```

TC06:

```bash
k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_tc06_smoke" \
  -e TASK_TYPE="perf_task_tc06_smoke" \
  -e WORKFLOW_START_RPS=1 \
  -e POLL_RPS=5 \
  -e FAIL_RATIO=0.10 \
  -e RETRY_COUNT=1 \
  -e RETRY_DELAY_SECONDS=1 \
  -e TEST_DURATION="30s" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=false \
  k6/scenarios/tc06_retry_storm.js
```

TC07:

```bash
k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_tc07_smoke" \
  -e TASK_TYPE="perf_task_tc07_smoke" \
  -e WORKFLOW_START_RPS=1 \
  -e CRASH_WORKER_POLL_RPS=4 \
  -e RECOVERY_WORKER_POLL_RPS=4 \
  -e CRASH_RATIO=0.50 \
  -e RETRY_COUNT=1 \
  -e RETRY_DELAY_SECONDS=1 \
  -e RESPONSE_TIMEOUT_SECONDS=5 \
  -e TIMEOUT_SECONDS=30 \
  -e TASK_TIMEOUT_POLICY=RETRY \
  -e TEST_DURATION="30s" \
  -e RECOVERY_GRACE_DURATION="20s" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=false \
  k6/scenarios/tc07_worker_crash_recovery.js
```
