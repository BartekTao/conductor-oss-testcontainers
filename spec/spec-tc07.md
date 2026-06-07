# spec-tc07.md

# TC07 - Worker Crash / Response Timeout Recovery Test

## 1. 目的

測試 worker poll 到 task 後不回報結果時，Conductor 是否能根據 responseTimeoutSeconds / timeoutSeconds 正確處理 task，並確認系統能否從 worker crash 情境中恢復。

本測試用來回答：

1. worker poll task 後 crash，task 會卡在 IN_PROGRESS 多久。
2. responseTimeoutSeconds 到期後，task 是否能重新被 poll 或 workflow 是否進入 timeout/fail。
3. recovery worker 是否能完成被釋放的 task。
4. 大量 worker crash 是否會造成 queue backlog、lock、latency cliff。
5. 對內 worker 是否必須支援 idempotency、heartbeat、合理 responseTimeout。

---

## 2. 測試模型

建立一個 workflow：

    wf_perf_tc07_worker_crash

workflow 內只有一個 SIMPLE task：

    perf_task_tc07_crash

task definition：

    retryCount = 1
    retryDelaySeconds = 5
    timeoutSeconds = 60
    responseTimeoutSeconds = 15
    pollTimeoutSeconds = 60
    timeoutPolicy = TIME_OUT_WF

測試流程：

    1. Producer 啟動 workflow。
    2. Crash worker poll task。
    3. 根據 CRASH_RATIO 決定是否模擬 crash。
    4. 如果 crash，worker 拿到 task 後不 complete、不 fail。
    5. Recovery worker 持續 poll 同 task type。
    6. 等 responseTimeoutSeconds 後，觀察 task 是否能被 recovery worker 拿到。
    7. Recovery worker complete task。
    8. 記錄 requeue/recovery latency。

---

## 3. k6 腳本目標

AI agent 需要建立：

    k6/scenarios/tc07_worker_crash_recovery.js

此腳本需要：

1. setup() 檢查並建立 task definition。
2. setup() 檢查並建立 workflow definition。
3. Producer 固定 RPS 啟動 workflow。
4. Crash worker 固定 RPS poll task。
5. Crash worker 根據 CRASH_RATIO 決定：
   - complete task
   - 或模擬 crash，不回報 task
6. Recovery worker 固定 RPS poll task。
7. Recovery worker poll 到 task 後 complete。
8. 收集 in-progress task 被重新取得的時間。
9. 收集 recovery latency。
10. 收集 workflow-submit-to-task-complete latency。
11. 輸出 summary JSON。

---

## 4. 必要環境變數

    BASE_URL="https://your-conductor-domain"
    API_PREFIX="/api"

    WORKFLOW_NAME="wf_perf_tc07_worker_crash"
    TASK_TYPE="perf_task_tc07_crash"
    WORKFLOW_VERSION=1
    OWNER_EMAIL="perf-test@example.com"

    AUTO_CREATE_DEFINITIONS=true
    FAIL_ON_DEFINITION_MISMATCH=false

    WORKFLOW_START_RPS=5
    CRASH_WORKER_POLL_RPS=20
    RECOVERY_WORKER_POLL_RPS=20

    CRASH_RATIO=0.50

    RETRY_COUNT=1
    RETRY_DELAY_SECONDS=5
    RESPONSE_TIMEOUT_SECONDS=15
    TIMEOUT_SECONDS=60

    TEST_DURATION="5m"
    RECOVERY_GRACE_DURATION="2m"

    PRODUCER_PRE_ALLOCATED_VUS=10
    PRODUCER_MAX_VUS=100
    CRASH_WORKER_PRE_ALLOCATED_VUS=20
    CRASH_WORKER_MAX_VUS=200
    RECOVERY_WORKER_PRE_ALLOCATED_VUS=20
    RECOVERY_WORKER_MAX_VUS=200

    SLA_API_P95_MS=500
    SLA_RECOVERY_LATENCY_P95_MS=25000
    SLA_SCHEDULE_TO_POLL_P95_MS=1000

    STRICT_LATENCY_THRESHOLD=false

---

## 5. Task Definition Spec

Task definition 由 ENV 動態產生。

    {
      "name": "perf_task_tc07_crash",
      "description": "TC07 worker crash recovery task",
      "retryCount": RETRY_COUNT,
      "retryLogic": "FIXED",
      "retryDelaySeconds": RETRY_DELAY_SECONDS,
      "timeoutSeconds": TIMEOUT_SECONDS,
      "responseTimeoutSeconds": RESPONSE_TIMEOUT_SECONDS,
      "pollTimeoutSeconds": 60,
      "timeoutPolicy": "TIME_OUT_WF",
      "ownerEmail": "perf-test@example.com",
      "inputKeys": [],
      "outputKeys": [],
      "inputTemplate": {}
    }

注意：

    TC07 可能會調整 responseTimeoutSeconds。
    如果 task definition 已存在但 timeout 設定不同，建議允許 update 或用 FAIL_ON_DEFINITION_MISMATCH=false。

---

## 6. Workflow Definition Spec

    {
      "name": "wf_perf_tc07_worker_crash",
      "description": "TC07 worker crash recovery workflow",
      "version": 1,
      "schemaVersion": 2,
      "ownerEmail": "perf-test@example.com",
      "inputParameters": [
        "testRunId",
        "iterationId",
        "createdAtMs",
        "crashRatio",
        "payload"
      ],
      "outputParameters": {
        "testRunId": "${workflow.input.testRunId}",
        "iterationId": "${workflow.input.iterationId}"
      },
      "tasks": [
        {
          "name": "perf_task_tc07_crash",
          "taskReferenceName": "perf_task_tc07_crash_ref",
          "type": "SIMPLE",
          "inputParameters": {
            "testRunId": "${workflow.input.testRunId}",
            "iterationId": "${workflow.input.iterationId}",
            "createdAtMs": "${workflow.input.createdAtMs}",
            "crashRatio": "${workflow.input.crashRatio}",
            "payload": "${workflow.input.payload}"
          }
        }
      ]
    }

---

## 7. setup() 行為

setup() 需要：

    1. build task definition with RETRY_COUNT, RETRY_DELAY_SECONDS, RESPONSE_TIMEOUT_SECONDS, TIMEOUT_SECONDS
    2. ensureTaskDefinition(TASK_TYPE)
    3. build workflow definition
    4. ensureWorkflowDefinition(WORKFLOW_NAME)

Validation：

    task.name 正確
    task.retryCount 符合 RETRY_COUNT
    task.responseTimeoutSeconds 符合 RESPONSE_TIMEOUT_SECONDS
    task.timeoutSeconds 符合 TIMEOUT_SECONDS
    workflow.tasks.length == 1
    workflow task name == TASK_TYPE
    workflow task type == SIMPLE
    workflow task inputParameters 包含:
      - testRunId
      - iterationId
      - createdAtMs
      - crashRatio
      - payload

---

## 8. Scenario 設計

TC07 建議使用三個 scenario：

    producer
    crashWorker
    recoveryWorker

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
         crashRatio: CRASH_RATIO,
         payload: {
           source: "k6-tc07",
           responseTimeoutSeconds: RESPONSE_TIMEOUT_SECONDS
         }
       }
    5. workflows_started.add(1)
    6. workflow_start_latency.add()

### 8.2 Crash Worker Scenario

使用 constant-arrival-rate：

    executor: "constant-arrival-rate"
    rate: CRASH_WORKER_POLL_RPS
    timeUnit: "1s"
    duration: TEST_DURATION
    preAllocatedVUs: CRASH_WORKER_PRE_ALLOCATED_VUS
    maxVUs: CRASH_WORKER_MAX_VUS
    exec: "crashWorker"

Crash worker 每次 iteration：

    1. GET /tasks/poll/{TASK_TYPE}?workerid={crashWorkerId}
    2. 如果 poll miss:
       - crash_worker_poll_misses.add(1)
       - poll_miss_latency.add()
       - 結束 iteration
    3. 如果 poll hit:
       - crash_worker_tasks_polled.add(1)
       - 記錄 task_scheduled_to_poll_latency
       - 記錄 workflow_submit_to_poll_latency
       - shouldCrash = random() < CRASH_RATIO
       - 如果 shouldCrash:
         - 不呼叫 POST /tasks
         - crashed_tasks.add(1)
         - 記錄 crashStartedAtMs = Date.now()
         - 盡可能把 workflowInstanceId/taskId/iterationId 記錄在 local summary 統計
         - 結束 iteration
       - 如果 !shouldCrash:
         - POST /tasks COMPLETED
         - crash_worker_tasks_completed.add(1)

注意：

    k6 VU 之間不適合共享完整 taskId map。
    第一版 recovery latency 可以用 task.inputData.createdAtMs 估算。
    若要精準追蹤 task crash 時間，需要外部資料庫或 k6 output sink。

### 8.3 Recovery Worker Scenario

使用 constant-arrival-rate：

    executor: "constant-arrival-rate"
    rate: RECOVERY_WORKER_POLL_RPS
    timeUnit: "1s"
    duration: TEST_DURATION + RECOVERY_GRACE_DURATION
    preAllocatedVUs: RECOVERY_WORKER_PRE_ALLOCATED_VUS
    maxVUs: RECOVERY_WORKER_MAX_VUS
    exec: "recoveryWorker"

Recovery worker 每次 iteration：

    1. GET /tasks/poll/{TASK_TYPE}?workerid={recoveryWorkerId}
    2. 如果 poll miss:
       - recovery_worker_poll_misses.add(1)
       - 結束 iteration
    3. 如果 poll hit:
       - recovery_worker_tasks_polled.add(1)
       - 記錄 task_scheduled_to_poll_latency
       - 記錄 workflow_submit_to_poll_latency
       - 判斷是否疑似 recovery task:
         如果 task.inputData.createdAtMs 距現在 > RESPONSE_TIMEOUT_SECONDS * 1000
         則視為 recovered task
       - POST /tasks COMPLETED
       - recovery_worker_tasks_completed.add(1)
       - 如果是 recovered task:
         recovered_tasks.add(1)
         recovery_latency.add(Date.now() - createdAtMs)

---

## 9. Recovery Latency 定義

第一版可用近似值：

    recovery_latency =
      recovery worker complete time - workflow createdAtMs

這不是純粹「crash 到 recovery」時間，但能反映使用者感受到的恢復時間。

如果要更精準，需要記錄 crash worker poll hit 時間：

    crash_to_recovery_latency =
      recovery worker poll time - crash worker poll time

但 k6 scenario 之間無法穩定共享 taskId 狀態，除非接外部儲存。因此第一版先用：

    workflow_submit_to_recovery_complete_latency

並額外輸出：

    expected_min_recovery_latency ≈ RESPONSE_TIMEOUT_SECONDS * 1000

---

## 10. 必要 Metrics

Trend：

    workflow_start_latency
    crash_worker_poll_attempt_latency
    recovery_worker_poll_attempt_latency
    poll_hit_latency
    poll_miss_latency
    task_update_latency
    task_scheduled_to_poll_latency
    workflow_submit_to_poll_latency
    workflow_submit_to_task_complete_latency
    workflow_submit_to_recovery_complete_latency
    estimated_recovery_latency

Counter：

    workflows_started
    crash_worker_tasks_polled
    crash_worker_tasks_completed
    crashed_tasks
    recovery_worker_tasks_polled
    recovery_worker_tasks_completed
    recovered_tasks
    crash_worker_poll_misses
    recovery_worker_poll_misses
    workflow_start_errors
    poll_errors
    complete_errors
    errors
    missing_task_scheduled_time
    missing_input_created_at_ms

Rate：

    workflow_start_success_rate
    task_complete_success_rate
    crash_injection_rate
    recovery_success_observed_rate
    poll_hit_rate

Derived：

    crash_ratio_observed = crashed_tasks / crash_worker_tasks_polled
    recovered_to_crashed_ratio = recovered_tasks / crashed_tasks
    total_completed_tasks = crash_worker_tasks_completed + recovery_worker_tasks_completed
    total_completed_to_started_ratio = total_completed_tasks / workflows_started

---

## 11. Task Complete Payload

Recovery worker 與 non-crash worker complete payload：

    {
      "workflowInstanceId": task.workflowInstanceId,
      "taskId": task.taskId,
      "status": "COMPLETED",
      "workerId": workerId,
      "outputData": {
        "completedAtMs": Date.now(),
        "testRunId": task.inputData.testRunId,
        "iterationId": task.inputData.iterationId,
        "completedBy": "crashWorker" or "recoveryWorker"
      }
    }

---

## 12. 測試矩陣

### 12.1 基準測試

    Round 1:
      WORKFLOW_START_RPS=1
      CRASH_RATIO=0.1
      RESPONSE_TIMEOUT_SECONDS=15

    Round 2:
      WORKFLOW_START_RPS=5
      CRASH_RATIO=0.3
      RESPONSE_TIMEOUT_SECONDS=15

    Round 3:
      WORKFLOW_START_RPS=10
      CRASH_RATIO=0.5
      RESPONSE_TIMEOUT_SECONDS=15

    Round 4:
      WORKFLOW_START_RPS=20
      CRASH_RATIO=0.5
      RESPONSE_TIMEOUT_SECONDS=15

### 12.2 response timeout 測試

    Round 5:
      WORKFLOW_START_RPS=5
      CRASH_RATIO=0.5
      RESPONSE_TIMEOUT_SECONDS=30

    Round 6:
      WORKFLOW_START_RPS=5
      CRASH_RATIO=0.5
      RESPONSE_TIMEOUT_SECONDS=60

---

## 13. Poll RPS 設定

Crash worker poll RPS：

    CRASH_WORKER_POLL_RPS = WORKFLOW_START_RPS * 2

Recovery worker poll RPS：

    RECOVERY_WORKER_POLL_RPS = WORKFLOW_START_RPS * CRASH_RATIO * 2

為了簡化，第一版可以固定：

    CRASH_WORKER_POLL_RPS = WORKFLOW_START_RPS * 4
    RECOVERY_WORKER_POLL_RPS = WORKFLOW_START_RPS * 4

---

## 14. 執行方式

    k6 run \
      -e BASE_URL="https://your-conductor-domain" \
      -e API_PREFIX="/api" \
      -e WORKFLOW_NAME="wf_perf_tc07_worker_crash" \
      -e TASK_TYPE="perf_task_tc07_crash" \
      -e WORKFLOW_START_RPS=5 \
      -e CRASH_WORKER_POLL_RPS=20 \
      -e RECOVERY_WORKER_POLL_RPS=20 \
      -e CRASH_RATIO=0.50 \
      -e RESPONSE_TIMEOUT_SECONDS=15 \
      -e RETRY_COUNT=1 \
      -e RETRY_DELAY_SECONDS=5 \
      -e TIMEOUT_SECONDS=60 \
      -e TEST_DURATION="5m" \
      -e RECOVERY_GRACE_DURATION="2m" \
      -e AUTO_CREATE_DEFINITIONS=true \
      -e FAIL_ON_DEFINITION_MISMATCH=false \
      k6/scenarios/tc07_worker_crash_recovery.js

---

## 15. 成功標準

某一輪 stable 條件：

    errors = 0
    workflow_start_success_rate >= 99.9%
    task_complete_success_rate >= 99.0%
    total_completed_tasks / workflows_started >= 0.95
    recovered_tasks / crashed_tasks >= 0.90
    estimated_recovery_latency p95 <= SLA_RECOVERY_LATENCY_P95_MS
    workflow_start_latency p95 < SLA_API_P95_MS
    task_update_latency p95 < SLA_API_P95_MS
    dropped_iterations = 0

注意：

    TC07 是 failure recovery 測試，不應要求所有 workflow 立即完成。
    需要給 RECOVERY_GRACE_DURATION，讓 response timeout 後的 task 有時間被 recovery worker 消化。

---

## 16. Cliff Point 判定

以下任一條件成立即視為超過穩定上限：

    recovered_tasks / crashed_tasks < 0.90
    total_completed_tasks / workflows_started < 0.95
    estimated_recovery_latency p95 超過 SLA
    task_update_latency p95 超過 SLA
    workflow_start_latency p95 超過 SLA
    recovery worker poll 長時間拿不到 timeout 後的 task
    crashed task 疑似永久卡住
    errors > 0
    dropped_iterations > 0

---

## 17. Summary 輸出

handleSummary() 需要輸出：

    tc07_summary.json
    tc07_raw_summary.json

summary 至少包含：

    {
      "testCase": "TC07",
      "workflowName": "wf_perf_tc07_worker_crash",
      "taskType": "perf_task_tc07_crash",
      "workflowStartRps": 5,
      "crashWorkerPollRps": 20,
      "recoveryWorkerPollRps": 20,
      "crashRatio": 0.5,
      "responseTimeoutSeconds": 15,
      "retryCount": 1,
      "retryDelaySeconds": 5,
      "timeoutSeconds": 60,
      "testDuration": "5m",
      "recoveryGraceDuration": "2m",
      "overall": {
        "workflowsStarted": {},
        "crashWorkerTasksPolled": {},
        "crashWorkerTasksCompleted": {},
        "crashedTasks": {},
        "recoveryWorkerTasksPolled": {},
        "recoveryWorkerTasksCompleted": {},
        "recoveredTasks": {},
        "workflowStartLatency": {},
        "taskUpdateLatency": {},
        "workflowSubmitToRecoveryCompleteLatency": {},
        "estimatedRecoveryLatency": {},
        "errors": {}
      },
      "derived": {
        "observedCrashRatio": 0.49,
        "recoveredToCrashedRatio": 0.95,
        "totalCompletedToStartedRatio": 0.97,
        "actualCompletedRps": 4.85,
        "isStable": true
      }
    }

---

## 18. 最終產出

測完後整理：

    tc07_result:
      response_timeout_seconds: TBD
      max_stable_workflow_start_rps_under_50_percent_crash: TBD
      recovered_to_crashed_ratio: TBD
      recovery_latency_p95_ms: TBD
      recommended_response_timeout_for_short_task: TBD
      recommended_response_timeout_for_medium_task: TBD

---

## 19. 對內 SLA / Worker 規範轉換

TC07 結果應轉成：

    worker_reliability_rules:
      worker_must_be_idempotent: true
      long_task_must_heartbeat_or_update_progress: true
      response_timeout_seconds_should_match_task_execution_time: true
      task_timeout_seconds_must_be_greater_than_response_timeout: true
      worker_crash_recovery_sla_ms: TBD

    usage_rules:
      - worker poll 到 task 後可能 crash，因此 task handler 必須可重試
      - task side effect 必須具備 idempotency
      - responseTimeoutSeconds 不可設定過短，避免長任務被重複派發
      - responseTimeoutSeconds 不可設定過長，避免 worker crash 後 task 卡太久
      - 長任務應設計 heartbeat、分段 task 或外部狀態回報