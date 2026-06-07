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
