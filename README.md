## TC00
k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_single_hot" \
  -e TASK_TYPE="perf_task_hot" \
  -e WORKFLOW_VERSION=1 \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=true \
  -e VUS=1 \
  -e ITERATIONS=10 \
  k6/scenarios/tc00_smoke_collect_metrics.js

## TC01
k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_tc01_smoke" \
  -e TASK_TYPE="perf_task_tc01_smoke" \
  -e WORKFLOW_VERSION=1 \
  -e PRELOAD_WORKFLOW_COUNT=3 \
  -e PRELOAD_BATCH_SIZE=1 \
  -e PRELOAD_MAX_IN_FLIGHT_BATCHES=1 \
  -e POLL_RPS=1 \
  -e TEST_DURATION="5s" \
  -e WORKER_PRE_ALLOCATED_VUS=1 \
  -e WORKER_MAX_VUS=4 \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=true \
  -e STRICT_LATENCY_THRESHOLD=false \
  k6/scenarios/tc01_preloaded_workflow_poll_capacity.js

## TC03
k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_PREFIX="wf_perf_tc03_smoke" \
  -e TASK_PREFIX="perf_task_tc03_smoke" \
  -e WORKFLOW_VERSION=1 \
  -e MAX_PAIR_COUNT=1 \
  -e PAIR_COUNT=1 \
  -e PAIR_PRELOAD_WORKFLOW_COUNT=6 \
  -e PRELOAD_BATCH_SIZE=1 \
  -e PRELOAD_MAX_IN_FLIGHT_BATCHES=1 \
  -e PAIR_POLL_RPS=1 \
  -e TEST_DURATION="3s" \
  -e PAIR_WORKER_PRE_ALLOCATED_VUS=1 \
  -e PAIR_WORKER_MAX_VUS=4 \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=true \
  -e STRICT_LATENCY_THRESHOLD=false \
  k6/scenarios/tc03_preloaded_independent_poll_scale.js

## TC06
Retry storm test. TC06 keeps workflow producer and task worker running at the
same time, then injects task failures by `FAIL_RATIO` to measure retry
amplification and latency impact.

Smoke run:

k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_tc06_smoke" \
  -e TASK_TYPE="perf_task_tc06_smoke" \
  -e WORKFLOW_VERSION=1 \
  -e WORKFLOW_START_RPS=1 \
  -e POLL_RPS=5 \
  -e FAIL_RATIO=0.10 \
  -e RETRY_COUNT=1 \
  -e RETRY_DELAY_SECONDS=1 \
  -e TEST_DURATION="30s" \
  -e PRODUCER_PRE_ALLOCATED_VUS=2 \
  -e PRODUCER_MAX_VUS=10 \
  -e WORKER_PRE_ALLOCATED_VUS=5 \
  -e WORKER_MAX_VUS=20 \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=false \
  -e STRICT_LATENCY_THRESHOLD=false \
  k6/scenarios/tc06_retry_storm.js

No-failure baseline:

k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_tc06_no_fail" \
  -e TASK_TYPE="perf_task_tc06_no_fail" \
  -e WORKFLOW_START_RPS=1 \
  -e POLL_RPS=3 \
  -e FAIL_RATIO=0 \
  -e RETRY_COUNT=1 \
  -e RETRY_DELAY_SECONDS=1 \
  -e TEST_DURATION="30s" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=false \
  k6/scenarios/tc06_retry_storm.js

Capacity / retry matrix runs should increase `WORKFLOW_START_RPS`,
`FAIL_RATIO`, `RETRY_COUNT`, and `RETRY_DELAY_SECONDS` according to
`spec/spec-tc06.md`. The script writes:

- `tc06_summary.json`
- `tc06_raw_summary.json`

## TC07
Worker crash / response timeout recovery test. TC07 keeps producer, crash
worker, and recovery worker running together. The crash worker simulates a
worker crash by polling a task and not sending any task update.

Smoke run:

k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_tc07_smoke" \
  -e TASK_TYPE="perf_task_tc07_smoke" \
  -e WORKFLOW_VERSION=1 \
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
  -e STRICT_LATENCY_THRESHOLD=false \
  k6/scenarios/tc07_worker_crash_recovery.js

No-crash baseline:

k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_tc07_no_crash" \
  -e TASK_TYPE="perf_task_tc07_no_crash" \
  -e WORKFLOW_START_RPS=1 \
  -e CRASH_WORKER_POLL_RPS=5 \
  -e RECOVERY_WORKER_POLL_RPS=2 \
  -e CRASH_RATIO=0 \
  -e RETRY_COUNT=1 \
  -e RETRY_DELAY_SECONDS=1 \
  -e RESPONSE_TIMEOUT_SECONDS=3 \
  -e TIMEOUT_SECONDS=20 \
  -e TASK_TIMEOUT_POLICY=RETRY \
  -e TEST_DURATION="10s" \
  -e RECOVERY_GRACE_DURATION="5s" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=false \
  k6/scenarios/tc07_worker_crash_recovery.js

Recovery validation:

k6 run \
  -e BASE_URL="http://localhost:8080" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_tc07_recovery" \
  -e TASK_TYPE="perf_task_tc07_recovery" \
  -e WORKFLOW_START_RPS=1 \
  -e CRASH_WORKER_POLL_RPS=5 \
  -e RECOVERY_WORKER_POLL_RPS=5 \
  -e CRASH_RATIO=1 \
  -e RETRY_COUNT=1 \
  -e RETRY_DELAY_SECONDS=1 \
  -e RESPONSE_TIMEOUT_SECONDS=3 \
  -e TIMEOUT_SECONDS=20 \
  -e TASK_TIMEOUT_POLICY=RETRY \
  -e TEST_DURATION="10s" \
  -e RECOVERY_GRACE_DURATION="60s" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=false \
  k6/scenarios/tc07_worker_crash_recovery.js

The script writes:

- `tc07_summary.json`
- `tc07_raw_summary.json`
