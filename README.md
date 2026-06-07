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
  tc00_smoke_collect_metrics.js