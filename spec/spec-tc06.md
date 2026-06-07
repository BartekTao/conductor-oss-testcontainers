# spec-tc06.md

# TC06 - Retry Storm Test

## 1. 目的

測試 task failure 與 retry policy 對 Conductor + MariaDB Queue 的衝擊。

本測試用來回答：

1. 當 task 有一定比例失敗時，retry 產生多少額外 task 壓力。
2. retry 是否造成 queue backlog、poll latency、task update latency 增加。
3. aggressive retry policy 是否會導致平台不穩。
4. 對內應限制 retryCount、retryDelaySeconds、failure ratio 與高 RPS task 的 retry 使用方式。

---

## 2. 測試模型

建立一個 workflow：

    wf_perf_tc06_retry

workflow 內只有一個 SIMPLE task：

    perf_task_tc06_retry

task definition 設定：

    retryCount = 可由環境變數控制，預設 3
    retryDelaySeconds = 可由環境變數控制，預設 5
    timeoutSeconds = 60
    responseTimeoutSeconds = 30

Worker poll 到 task 後，根據 FAIL_RATIO 決定 complete 或 fail。

例如：

    FAIL_RATIO=0.10

代表大約 10% poll hit task 會被 worker 回報 FAILED。

---

## 3. k6 腳本目標

AI agent 需要建立：

    k6/scenarios/tc06_retry_storm.js

此腳本需要：

1. setup() 檢查並建立 task definition。
2. setup() 檢查並建立 workflow definition。
3. task definition 的 retryCount、retryDelaySeconds 由 ENV 控制。
4. Producer 固定 RPS 啟動 workflow。
5. Worker 固定 RPS poll task。
6. Worker 根據 FAIL_RATIO 決定 complete 或 fail。
7. 收集 failed task、retry task、completed task 指標。
8. 收集 schedule-to-poll latency。
9. 收集 workflow-submit-to-task-complete latency。
10. 輸出 retry 放大倍率。
11. 輸出 summary JSON。

---

## 4. 必要環境變數

    BASE_URL="https://your-conductor-domain"
    API_PREFIX="/api"

    WORKFLOW_NAME="wf_perf_tc06_retry"
    TASK_TYPE="perf_task_tc06_retry"
    WORKFLOW_VERSION=1
    OWNER_EMAIL="perf-test@example.com"

    AUTO_CREATE_DEFINITIONS=true
    FAIL_ON_DEFINITION_MISMATCH=false

    WORKFLOW_START_RPS=50
    POLL_RPS=150
    TEST_DURATION="5m"

    FAIL_RATIO=0.10
    RETRY_COUNT=3
    RETRY_DELAY_SECONDS=5

    PRODUCER_PRE_ALLOCATED_VUS=20
    PRODUCER_MAX_VUS=200
    WORKER_PRE_ALLOCATED_VUS=50
    WORKER_MAX_VUS=500

    SLA_API_P95_MS=500
    SLA_SCHEDULE_TO_POLL_P95_MS=1000
    MAX_ERROR_RATE=0.001

    STRICT_LATENCY_THRESHOLD=false

---

## 5. Task Definition Spec

Task definition 需由 ENV 動態產生。

    {
      "name": "perf_task_tc06_retry",
      "description": "TC06 retry storm test task",
      "retryCount": RETRY_COUNT,
      "retryLogic": "FIXED",
      "retryDelaySeconds": RETRY_DELAY_SECONDS,
      "timeoutSeconds": 60,
      "responseTimeoutSeconds": 30,
      "pollTimeoutSeconds": 60,
      "timeoutPolicy": "TIME_OUT_WF",
      "ownerEmail": "perf-test@example.com",
      "inputKeys": [],
      "outputKeys": [],
      "inputTemplate": {}
    }

注意：

    TC06 會改 retryCount 與 retryDelaySeconds。
    如果 definition 已存在且內容不同，建議允許 update 或刪除後重建。
    第一版可以使用 FAIL_ON_DEFINITION_MISMATCH=false，避免每輪調整 retry 參數時 setup fail。

如果 AI agent 支援 update，建議：

    PUT /metadata/taskdefs

或使用 Conductor 支援的 metadata update endpoint 更新 task definition。

---

## 6. Workflow Definition Spec

    {
      "name": "wf_perf_tc06_retry",
      "description": "TC06 retry storm workflow",
      "version": 1,
      "schemaVersion": 2,
      "ownerEmail": "perf-test@example.com",
      "inputParameters": [
        "testRunId",
        "iterationId",
        "createdAtMs",
        "failRatio",
        "payload"
      ],
      "outputParameters": {
        "testRunId": "${workflow.input.testRunId}",
        "iterationId": "${workflow.input.iterationId}"
      },
      "tasks": [
        {
          "name": "perf_task_tc06_retry",
          "taskReferenceName": "perf_task_tc06_retry_ref",
          "type": "SIMPLE",
          "inputParameters": {
            "testRunId": "${workflow.input.testRunId}",
            "iterationId": "${workflow.input.iterationId}",
            "createdAtMs": "${workflow.input.createdAtMs}",
            "failRatio": "${workflow.input.failRatio}",
            "payload": "${workflow.input.payload}"
          }
        }
      ]
    }

---

## 7. setup() 行為

setup() 需要：

    1. build task definition with RETRY_COUNT, RETRY_DELAY_SECONDS
    2. ensureTaskDefinition(TASK_TYPE)
    3. build workflow definition
    4. ensureWorkflowDefinition(WORKFLOW_NAME)

Validation：

    task.name 正確
    task.retryCount 符合 RETRY_COUNT
    task.retryDelaySeconds 符合 RETRY_DELAY_SECONDS
    workflow.tasks.length == 1
    workflow task name == TASK_TYPE
    workflow task type == SIMPLE
    workflow task inputParameters 包含:
      - testRunId
      - iterationId
      - createdAtMs
      - failRatio
      - payload

若 task definition 已存在但 retry 參數不一致：

    如果 FAIL_ON_DEFINITION_MISMATCH=true:
      fail setup

    如果 FAIL_ON_DEFINITION_MISMATCH=false:
      console.warn 並繼續

建議實作 UPDATE_TASK_DEFINITION=true 支援覆蓋更新。

---

## 8. Scenario 設計

TC06 使用 producer / worker 分離。

### 8.1 Producer Scenario

使用 constant-arrival-rate：

    executor: "constant-arrival-rate"
    rate: WORKFLOW_START_RPS
    timeUnit: "1s"
    duration: TEST_DURATION
    preAllocatedVUs: PRODUCER_PRE_ALLOCATED_VUS
    maxVUs: PRODUCER_MAX_VUS
    exec: "producer"

Producer 每次 iteration：

    1. createdAtMs = Date.now()
    2. iterationId = `${testRunId}-vu${vu}-iter${iter}`
    3. POST /workflow/{WORKFLOW_NAME}?version=1&correlationId={iterationId}
    4. body:
       {
         testRunId,
         iterationId,
         createdAtMs,
         failRatio: FAIL_RATIO,
         payload: {
           source: "k6-tc06",
           retryCount: RETRY_COUNT,
           retryDelaySeconds: RETRY_DELAY_SECONDS
         }
       }
    5. workflow_start_latency.add()
    6. workflows_started.add(1)

### 8.2 Worker Scenario

使用 constant-arrival-rate：

    executor: "constant-arrival-rate"
    rate: POLL_RPS
    timeUnit: "1s"
    duration: TEST_DURATION
    preAllocatedVUs: WORKER_PRE_ALLOCATED_VUS
    maxVUs: WORKER_MAX_VUS
    exec: "worker"

Worker 每次 iteration：

    1. GET /tasks/poll/{TASK_TYPE}?workerid={workerId}
    2. 如果 poll miss:
       - poll_miss_latency.add()
       - poll_misses.add(1)
       - 結束 iteration
    3. 如果 poll hit:
       - tasks_polled.add(1)
       - poll_hit_latency.add()
       - 記錄 task_scheduled_to_poll_latency
       - 記錄 workflow_submit_to_poll_latency
       - 判斷是否 fail:
         shouldFail = random() < FAIL_RATIO
       - 如果 shouldFail:
         POST /tasks status=FAILED
         task_failed.add(1)
         task_failed_update_latency.add()
       - 如果 !shouldFail:
         POST /tasks status=COMPLETED
         tasks_completed.add(1)
         task_update_latency.add()
         workflow_submit_to_task_complete_latency.add()

---

## 9. Task Fail Payload

FAILED request body：

    {
      "workflowInstanceId": task.workflowInstanceId,
      "taskId": task.taskId,
      "status": "FAILED",
      "workerId": workerId,
      "reasonForIncompletion": "TC06 injected failure",
      "outputData": {
        "failedAtMs": Date.now(),
        "testRunId": task.inputData.testRunId,
        "iterationId": task.inputData.iterationId,
        "injectedFailure": true
      }
    }

COMPLETED request body：

    {
      "workflowInstanceId": task.workflowInstanceId,
      "taskId": task.taskId,
      "status": "COMPLETED",
      "workerId": workerId,
      "outputData": {
        "completedAtMs": Date.now(),
        "testRunId": task.inputData.testRunId,
        "iterationId": task.inputData.iterationId
      }
    }

---

## 10. Retry / Attempt 辨識

如果 task payload 有 retryCount、retriedTaskId、seq、callbackAfterSeconds、pollCount、retried 等欄位，agent 需要盡量收集。

建議記錄：

    task.retryCount
    task.pollCount
    task.callbackAfterSeconds
    task.status
    task.taskId
    task.workflowInstanceId

如果 Conductor 回傳 task 中沒有 attempt 欄位，則用 counters 估算 retry 放大倍率。

---

## 11. 必要 Metrics

Trend：

    workflow_start_latency
    poll_attempt_latency
    poll_hit_latency
    poll_miss_latency
    task_update_latency
    task_failed_update_latency
    task_scheduled_to_poll_latency
    workflow_submit_to_poll_latency
    workflow_submit_to_task_complete_latency

Counter：

    workflows_started
    tasks_polled
    tasks_completed
    tasks_failed
    poll_misses
    workflow_start_errors
    poll_errors
    complete_errors
    fail_update_errors
    missing_task_scheduled_time
    missing_input_created_at_ms
    errors

Rate：

    workflow_start_success_rate
    task_complete_success_rate
    task_fail_update_success_rate
    injected_fail_rate
    poll_hit_rate

Derived metrics：

    task_attempts = tasks_completed + tasks_failed
    retry_amplification = task_attempts / workflows_started
    completed_to_started_ratio = tasks_completed / workflows_started
    failed_to_attempt_ratio = tasks_failed / task_attempts

---

## 12. Retry Amplification

理論上，在 failRatio = p、retryCount = r 的情況下，單一 workflow 的預期 task attempts 約為：

    E[attempts] = 1 + p + p^2 + ... + p^r

例如：

    p = 0.3
    r = 3

    E[attempts] = 1 + 0.3 + 0.09 + 0.027 = 1.417

所以如果 workflow_start_rps = 100：

    expected_task_attempt_rps ≈ 141.7

TC06 summary 需要輸出：

    observed_retry_amplification =
      (tasks_completed + tasks_failed) / workflows_started

---

## 13. Threshold 建議

初期功能 threshold：

    errors == 0
    workflow_start_success_rate >= 0.999
    task_fail_update_success_rate >= 0.999
    task_complete_success_rate >= 0.99

正式 SLA threshold：

    workflow_start_latency p95 < SLA_API_P95_MS
    task_update_latency p95 < SLA_API_P95_MS
    task_failed_update_latency p95 < SLA_API_P95_MS
    task_scheduled_to_poll_latency p95 < SLA_SCHEDULE_TO_POLL_P95_MS

---

## 14. 建議測試矩陣

固定：

    WORKFLOW_START_RPS=50

測 fail ratio：

    Round 1:
      FAIL_RATIO=0.01
      RETRY_COUNT=3
      RETRY_DELAY_SECONDS=5

    Round 2:
      FAIL_RATIO=0.05
      RETRY_COUNT=3
      RETRY_DELAY_SECONDS=5

    Round 3:
      FAIL_RATIO=0.10
      RETRY_COUNT=3
      RETRY_DELAY_SECONDS=5

    Round 4:
      FAIL_RATIO=0.30
      RETRY_COUNT=3
      RETRY_DELAY_SECONDS=5

    Round 5:
      FAIL_RATIO=0.50
      RETRY_COUNT=3
      RETRY_DELAY_SECONDS=5

測 retry delay：

    Round 6:
      FAIL_RATIO=0.30
      RETRY_COUNT=3
      RETRY_DELAY_SECONDS=30

測 retry count：

    Round 7:
      FAIL_RATIO=0.30
      RETRY_COUNT=1
      RETRY_DELAY_SECONDS=5

    Round 8:
      FAIL_RATIO=0.30
      RETRY_COUNT=5
      RETRY_DELAY_SECONDS=5

---

## 15. Poll RPS 設定

POLL_RPS 需要大於 expected attempt RPS。

計算：

    expected_attempt_rps =
      WORKFLOW_START_RPS * (1 + p + p^2 + ... + p^r)

建議：

    POLL_RPS = expected_attempt_rps * 1.5

如果懶得動態計算，初始可用：

    POLL_RPS = WORKFLOW_START_RPS * 3

---

## 16. 執行方式

    k6 run \
      -e BASE_URL="https://your-conductor-domain" \
      -e API_PREFIX="/api" \
      -e WORKFLOW_NAME="wf_perf_tc06_retry" \
      -e TASK_TYPE="perf_task_tc06_retry" \
      -e WORKFLOW_START_RPS=50 \
      -e POLL_RPS=150 \
      -e FAIL_RATIO=0.10 \
      -e RETRY_COUNT=3 \
      -e RETRY_DELAY_SECONDS=5 \
      -e TEST_DURATION="5m" \
      -e AUTO_CREATE_DEFINITIONS=true \
      -e FAIL_ON_DEFINITION_MISMATCH=false \
      k6/scenarios/tc06_retry_storm.js

---

## 17. 成功標準

某一輪 stable 條件：

    errors = 0
    workflow_start_success_rate >= 99.9%
    task_fail_update_success_rate >= 99.9%
    task_complete_success_rate >= 99.0%
    workflow_start_latency p95 < SLA_API_P95_MS
    task_update_latency p95 < SLA_API_P95_MS
    task_failed_update_latency p95 < SLA_API_P95_MS
    task_scheduled_to_poll_latency p95 < SLA_SCHEDULE_TO_POLL_P95_MS
    observed_retry_amplification 接近 theoretical_retry_amplification
    dropped_iterations = 0

注意：

    TC06 允許部分 workflow 最終 failed。
    因為這是 retry storm 測試，不應以 workflow_success_rate 作為唯一成功條件。

但需要觀察：

    tasks_completed / workflows_started

如果 fail ratio 很高，該值會下降，需記錄為 retry policy 的風險。

---

## 18. Cliff Point 判定

以下任一條件成立即視為超過穩定上限：

    task_scheduled_to_poll_latency p95 超過 SLA
    task_update_latency p95 超過 SLA
    task_failed_update_latency p95 超過 SLA
    observed_retry_amplification 明顯高於預期
    tasks_completed 長時間跟不上 workflows_started
    poll hit rate 異常下降
    errors > 0
    dropped_iterations > 0
    task attempts 持續堆積
    retry 後造成 queue backlog 無法消化

---

## 19. Summary 輸出

handleSummary() 需要輸出：

    tc06_summary.json
    tc06_raw_summary.json

summary 至少包含：

    {
      "testCase": "TC06",
      "workflowName": "wf_perf_tc06_retry",
      "taskType": "perf_task_tc06_retry",
      "workflowStartRps": 50,
      "pollRps": 150,
      "failRatio": 0.10,
      "retryCount": 3,
      "retryDelaySeconds": 5,
      "testDuration": "5m",
      "overall": {
        "workflowsStarted": {},
        "tasksPolled": {},
        "tasksCompleted": {},
        "tasksFailed": {},
        "pollMisses": {},
        "workflowStartLatency": {},
        "taskUpdateLatency": {},
        "taskFailedUpdateLatency": {},
        "taskScheduledToPollLatency": {},
        "workflowSubmitToPollLatency": {},
        "workflowSubmitToTaskCompleteLatency": {},
        "errors": {}
      },
      "derived": {
        "theoreticalRetryAmplification": 1.111,
        "observedRetryAmplification": 1.108,
        "tasksCompletedToWorkflowStartedRatio": 0.998,
        "tasksFailedToAttemptsRatio": 0.097,
        "actualTaskAttemptRps": 55.4,
        "isStable": true
      }
    }

---

## 20. 最終產出

測完後整理：

    tc06_result:
      max_stable_fail_ratio_at_retry_count_3_delay_5s: TBD
      recommended_max_retry_count_without_review: TBD
      recommended_min_retry_delay_seconds: TBD
      observed_retry_amplification_at_10_percent_fail: TBD
      observed_retry_amplification_at_30_percent_fail: TBD
      observed_retry_amplification_at_50_percent_fail: TBD

---

## 21. 對內 SLA / 使用規範轉換

TC06 結果應轉成：

    retry_policy_rules:
      default_retry_count: 1
      max_retry_count_without_review: 3
      min_retry_delay_seconds: TBD
      high_rps_task_requires_retry_review: true
      retry_should_add_jitter: true
      aggressive_retry_not_allowed_for_hot_task: true

    usage_rules:
      - 高 RPS task 不可設定過高 retryCount
      - retryDelaySeconds 不應過短
      - fail ratio 高的 task 應先修 worker 或下游服務，不應只靠 retry
      - retry 會放大 task attempts，容量估算必須使用 effective task rps