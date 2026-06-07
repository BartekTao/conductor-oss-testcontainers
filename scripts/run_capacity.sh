#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
API_PREFIX="${API_PREFIX:-/api}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d_%H%M%S)}"
TEST_CASES="${TEST_CASES:-tc01,tc03,tc06,tc07}"
OUT_DIR="${OUT_DIR:-reports/capacity/${RUN_ID}}"

TC01_RPS_LIST="${TC01_RPS_LIST:-20 40 50 60}"
TC01_DURATION="${TC01_DURATION:-15s}"
TC01_PRELOAD_FACTOR="${TC01_PRELOAD_FACTOR:-2}"

TC03_PAIR_COUNT_LIST="${TC03_PAIR_COUNT_LIST:-1 2 4}"
TC03_PAIR_POLL_RPS="${TC03_PAIR_POLL_RPS:-40}"
TC03_DURATION="${TC03_DURATION:-15s}"
TC03_MAX_PAIR_COUNT="${TC03_MAX_PAIR_COUNT:-4}"
TC03_PRELOAD_FACTOR="${TC03_PRELOAD_FACTOR:-2}"
TC03_BASELINE_RPS="${TC03_BASELINE_RPS:-40}"

TC06_START_RPS_LIST="${TC06_START_RPS_LIST:-1 3 5 8}"
TC06_DURATION="${TC06_DURATION:-30s}"
TC06_FAIL_RATIO="${TC06_FAIL_RATIO:-0.10}"
TC06_RETRY_COUNT="${TC06_RETRY_COUNT:-1}"
TC06_RETRY_DELAY_SECONDS="${TC06_RETRY_DELAY_SECONDS:-1}"
TC06_POLL_MULTIPLIER="${TC06_POLL_MULTIPLIER:-4}"

TC07_START_RPS_LIST="${TC07_START_RPS_LIST:-1 2 3}"
TC07_DURATION="${TC07_DURATION:-15s}"
TC07_RECOVERY_GRACE_DURATION="${TC07_RECOVERY_GRACE_DURATION:-60s}"
TC07_CRASH_RATIO="${TC07_CRASH_RATIO:-0.50}"
TC07_RETRY_COUNT="${TC07_RETRY_COUNT:-1}"
TC07_RETRY_DELAY_SECONDS="${TC07_RETRY_DELAY_SECONDS:-1}"
TC07_RESPONSE_TIMEOUT_SECONDS="${TC07_RESPONSE_TIMEOUT_SECONDS:-3}"
TC07_TIMEOUT_SECONDS="${TC07_TIMEOUT_SECONDS:-20}"
TC07_TASK_TIMEOUT_POLICY="${TC07_TASK_TIMEOUT_POLICY:-RETRY}"
TC07_CRASH_POLL_MULTIPLIER="${TC07_CRASH_POLL_MULTIPLIER:-4}"
TC07_RECOVERY_POLL_MULTIPLIER="${TC07_RECOVERY_POLL_MULTIPLIER:-6}"

mkdir -p "${OUT_DIR}"

selected() {
  local tc="$1"
  [[ ",${TEST_CASES}," == *",${tc},"* ]]
}

duration_seconds() {
  local value="$1"
  case "${value}" in
    *ms) echo 1 ;;
    *s) echo "${value%s}" ;;
    *m) echo "$(( ${value%m} * 60 ))" ;;
    *h) echo "$(( ${value%h} * 3600 ))" ;;
    *) echo "${value}" ;;
  esac
}

archive_summary() {
  local prefix="$1"
  local summary="$2"
  local raw="$3"

  cp "${summary}" "${OUT_DIR}/${prefix}_summary.json"
  cp "${raw}" "${OUT_DIR}/${prefix}_raw_summary.json"
}

run_tc01() {
  local duration_seconds_value
  duration_seconds_value="$(duration_seconds "${TC01_DURATION}")"

  for rps in ${TC01_RPS_LIST}; do
    local preload=$(( rps * duration_seconds_value * TC01_PRELOAD_FACTOR ))
    local name_suffix="tc01_${RUN_ID}_r${rps}"
    echo "[capacity] TC01 rps=${rps}, preload=${preload}"

    k6 run \
      -e BASE_URL="${BASE_URL}" \
      -e API_PREFIX="${API_PREFIX}" \
      -e TEST_RUN_ID="${name_suffix}" \
      -e WORKFLOW_NAME="wf_perf_${name_suffix}" \
      -e TASK_TYPE="perf_task_${name_suffix}" \
      -e WORKFLOW_VERSION=1 \
      -e PRELOAD_WORKFLOW_COUNT="${preload}" \
      -e PRELOAD_BATCH_SIZE=25 \
      -e PRELOAD_MAX_IN_FLIGHT_BATCHES=4 \
      -e POLL_RPS="${rps}" \
      -e TEST_DURATION="${TC01_DURATION}" \
      -e WORKER_PRE_ALLOCATED_VUS="${rps}" \
      -e WORKER_MAX_VUS="$(( rps * 4 ))" \
      -e AUTO_CREATE_DEFINITIONS=true \
      -e FAIL_ON_DEFINITION_MISMATCH=true \
      -e STRICT_LATENCY_THRESHOLD=false \
      k6/scenarios/tc01_preloaded_workflow_poll_capacity.js

    archive_summary "tc01_rps_${rps}" tc01_summary.json tc01_raw_summary.json
  done
}

run_tc03() {
  local duration_seconds_value
  duration_seconds_value="$(duration_seconds "${TC03_DURATION}")"

  for pair_count in ${TC03_PAIR_COUNT_LIST}; do
    local preload=$(( TC03_PAIR_POLL_RPS * duration_seconds_value * TC03_PRELOAD_FACTOR ))
    local name_suffix="tc03_${RUN_ID}_p${pair_count}"
    echo "[capacity] TC03 pair_count=${pair_count}, pair_poll_rps=${TC03_PAIR_POLL_RPS}, pair_preload=${preload}"

    k6 run \
      -e BASE_URL="${BASE_URL}" \
      -e API_PREFIX="${API_PREFIX}" \
      -e TEST_RUN_ID="${name_suffix}" \
      -e WORKFLOW_PREFIX="wf_perf_${name_suffix}" \
      -e TASK_PREFIX="perf_task_${name_suffix}" \
      -e WORKFLOW_VERSION=1 \
      -e MAX_PAIR_COUNT="${TC03_MAX_PAIR_COUNT}" \
      -e PAIR_COUNT="${pair_count}" \
      -e PAIR_PRELOAD_WORKFLOW_COUNT="${preload}" \
      -e PRELOAD_BATCH_SIZE=25 \
      -e PRELOAD_MAX_IN_FLIGHT_BATCHES=4 \
      -e PAIR_POLL_RPS="${TC03_PAIR_POLL_RPS}" \
      -e TEST_DURATION="${TC03_DURATION}" \
      -e PAIR_WORKER_PRE_ALLOCATED_VUS="${TC03_PAIR_POLL_RPS}" \
      -e PAIR_WORKER_MAX_VUS="$(( TC03_PAIR_POLL_RPS * 4 ))" \
      -e TC01_SINGLE_PAIR_STABLE_TASK_COMPLETED_RPS="${TC03_BASELINE_RPS}" \
      -e AUTO_CREATE_DEFINITIONS=true \
      -e FAIL_ON_DEFINITION_MISMATCH=true \
      -e STRICT_LATENCY_THRESHOLD=false \
      k6/scenarios/tc03_preloaded_independent_poll_scale.js

    archive_summary "tc03_pairs_${pair_count}" tc03_summary.json tc03_raw_summary.json
  done
}

run_tc06() {
  for start_rps in ${TC06_START_RPS_LIST}; do
    local poll_rps=$(( start_rps * TC06_POLL_MULTIPLIER ))
    local name_suffix="tc06_${RUN_ID}_s${start_rps}"
    echo "[capacity] TC06 start_rps=${start_rps}, poll_rps=${poll_rps}, fail_ratio=${TC06_FAIL_RATIO}"

    k6 run \
      -e BASE_URL="${BASE_URL}" \
      -e API_PREFIX="${API_PREFIX}" \
      -e TEST_RUN_ID="${name_suffix}" \
      -e WORKFLOW_NAME="wf_perf_${name_suffix}" \
      -e TASK_TYPE="perf_task_${name_suffix}" \
      -e WORKFLOW_VERSION=1 \
      -e WORKFLOW_START_RPS="${start_rps}" \
      -e POLL_RPS="${poll_rps}" \
      -e FAIL_RATIO="${TC06_FAIL_RATIO}" \
      -e RETRY_COUNT="${TC06_RETRY_COUNT}" \
      -e RETRY_DELAY_SECONDS="${TC06_RETRY_DELAY_SECONDS}" \
      -e TEST_DURATION="${TC06_DURATION}" \
      -e PRODUCER_PRE_ALLOCATED_VUS="$(( start_rps * 2 + 2 ))" \
      -e PRODUCER_MAX_VUS="$(( start_rps * 10 + 10 ))" \
      -e WORKER_PRE_ALLOCATED_VUS="${poll_rps}" \
      -e WORKER_MAX_VUS="$(( poll_rps * 4 ))" \
      -e AUTO_CREATE_DEFINITIONS=true \
      -e FAIL_ON_DEFINITION_MISMATCH=true \
      -e STRICT_LATENCY_THRESHOLD=false \
      k6/scenarios/tc06_retry_storm.js

    archive_summary "tc06_start_${start_rps}" tc06_summary.json tc06_raw_summary.json
  done
}

run_tc07() {
  for start_rps in ${TC07_START_RPS_LIST}; do
    local crash_poll_rps=$(( start_rps * TC07_CRASH_POLL_MULTIPLIER ))
    local recovery_poll_rps=$(( start_rps * TC07_RECOVERY_POLL_MULTIPLIER ))
    local name_suffix="tc07_${RUN_ID}_s${start_rps}"
    echo "[capacity] TC07 start_rps=${start_rps}, crash_poll_rps=${crash_poll_rps}, recovery_poll_rps=${recovery_poll_rps}, crash_ratio=${TC07_CRASH_RATIO}"

    k6 run \
      -e BASE_URL="${BASE_URL}" \
      -e API_PREFIX="${API_PREFIX}" \
      -e TEST_RUN_ID="${name_suffix}" \
      -e WORKFLOW_NAME="wf_perf_${name_suffix}" \
      -e TASK_TYPE="perf_task_${name_suffix}" \
      -e WORKFLOW_VERSION=1 \
      -e WORKFLOW_START_RPS="${start_rps}" \
      -e CRASH_WORKER_POLL_RPS="${crash_poll_rps}" \
      -e RECOVERY_WORKER_POLL_RPS="${recovery_poll_rps}" \
      -e CRASH_RATIO="${TC07_CRASH_RATIO}" \
      -e RETRY_COUNT="${TC07_RETRY_COUNT}" \
      -e RETRY_DELAY_SECONDS="${TC07_RETRY_DELAY_SECONDS}" \
      -e RESPONSE_TIMEOUT_SECONDS="${TC07_RESPONSE_TIMEOUT_SECONDS}" \
      -e TIMEOUT_SECONDS="${TC07_TIMEOUT_SECONDS}" \
      -e TASK_TIMEOUT_POLICY="${TC07_TASK_TIMEOUT_POLICY}" \
      -e TEST_DURATION="${TC07_DURATION}" \
      -e RECOVERY_GRACE_DURATION="${TC07_RECOVERY_GRACE_DURATION}" \
      -e PRODUCER_PRE_ALLOCATED_VUS="$(( start_rps * 2 + 2 ))" \
      -e PRODUCER_MAX_VUS="$(( start_rps * 10 + 10 ))" \
      -e CRASH_WORKER_PRE_ALLOCATED_VUS="${crash_poll_rps}" \
      -e CRASH_WORKER_MAX_VUS="$(( crash_poll_rps * 4 ))" \
      -e RECOVERY_WORKER_PRE_ALLOCATED_VUS="${recovery_poll_rps}" \
      -e RECOVERY_WORKER_MAX_VUS="$(( recovery_poll_rps * 4 ))" \
      -e AUTO_CREATE_DEFINITIONS=true \
      -e FAIL_ON_DEFINITION_MISMATCH=true \
      -e STRICT_LATENCY_THRESHOLD=false \
      k6/scenarios/tc07_worker_crash_recovery.js

    archive_summary "tc07_start_${start_rps}" tc07_summary.json tc07_raw_summary.json
  done
}

selected tc01 && run_tc01
selected tc03 && run_tc03
selected tc06 && run_tc06
selected tc07 && run_tc07

node scripts/generate_capacity_report.mjs "${OUT_DIR}"
echo "[capacity] reports written to ${OUT_DIR}"
