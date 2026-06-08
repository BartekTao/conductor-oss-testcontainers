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
    timeoutPolicy = RETRY

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
    TASK_TIMEOUT_POLICY=RETRY

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
      "timeoutPolicy": "RETRY",
      "ownerEmail": "perf-test@example.com",
      "inputKeys": [],
      "outputKeys": [],
      "inputTemplate": {}
    }

注意：

    TC07 可能會調整 responseTimeoutSeconds。
    正式 recovery 測試預設使用 TASK_TIMEOUT_POLICY=RETRY，讓 worker crash 後的 task 有機會重新進入 queue。
    TIME_OUT_WF 僅用於對照測試 workflow timeout/fail 行為。
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

    1. build task definition with RETRY_COUNT, RETRY_DELAY_SECONDS, RESPONSE_TIMEOUT_SECONDS, TIMEOUT_SECONDS, TASK_TIMEOUT_POLICY
    2. ensureTaskDefinition(TASK_TYPE)
    3. build workflow definition
    4. ensureWorkflowDefinition(WORKFLOW_NAME)

Validation：

    task.name 正確
    task.retryCount 符合 RETRY_COUNT
    task.responseTimeoutSeconds 符合 RESPONSE_TIMEOUT_SECONDS
    task.timeoutSeconds 符合 TIMEOUT_SECONDS
    task.timeoutPolicy 符合 TASK_TIMEOUT_POLICY
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
      -e TASK_TIMEOUT_POLICY=RETRY \
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

## 18. Implementation Plan

### Phase 1: k6 腳本骨架

建立 `k6/scenarios/tc07_worker_crash_recovery.js`，並重用既有 `k6/lib` helper：

```text
1. ENV parser
2. Conductor HTTP client
3. definition service
4. task parser / task complete helper
5. summary helper
6. producer scenario
7. crash worker scenario
8. recovery worker scenario
9. custom metrics
10. handleSummary()
```

此階段先完成必要 ENV 檢查：

```text
BASE_URL 必填
0 <= CRASH_RATIO <= 1
RETRY_COUNT >= 0
RETRY_DELAY_SECONDS >= 0
RESPONSE_TIMEOUT_SECONDS > 0
TIMEOUT_SECONDS > RESPONSE_TIMEOUT_SECONDS
TASK_TIMEOUT_POLICY in RETRY, TIME_OUT_WF, ALERT_ONLY
WORKFLOW_START_RPS >= 1
CRASH_WORKER_POLL_RPS >= 1
RECOVERY_WORKER_POLL_RPS >= 1
```

TC07 與 TC06 的差異需要在腳本註解或 summary 中清楚保留：

```text
TC06: worker 主動回報 FAILED，測 retry storm。
TC07: worker poll 後完全不回報，測 response timeout recovery。
```

### Phase 2: Response-timeout Definition Setup

setup 階段建立或驗證 task/workflow definitions。

task definition 由 ENV 動態產生：

```text
retryCount = RETRY_COUNT
retryDelaySeconds = RETRY_DELAY_SECONDS
responseTimeoutSeconds = RESPONSE_TIMEOUT_SECONDS
timeoutSeconds = TIMEOUT_SECONDS
timeoutPolicy = TASK_TIMEOUT_POLICY
```

workflow definition 維持單一 SIMPLE task，並驗證：

```text
workflow name
workflow version
workflow.tasks.length == 1
workflow task name == TASK_TYPE
workflow task type == SIMPLE
required inputParameters:
  - testRunId
  - iterationId
  - createdAtMs
  - crashRatio
  - payload
```

definition mismatch 行為：

```text
FAIL_ON_DEFINITION_MISMATCH=true:
  fail setup

FAIL_ON_DEFINITION_MISMATCH=false:
  console.warn 並繼續
```

第一版不做自動 task definition update。調整 response timeout 或 timeout 參數時，建議使用不同 task/workflow name，或用 `FAIL_ON_DEFINITION_MISMATCH=false` 做探索性測試。

### Phase 3: Producer Scenario

Producer 使用 `constant-arrival-rate`：

```text
rate = WORKFLOW_START_RPS
duration = TEST_DURATION
exec = producer
```

每次 iteration：

```text
1. 建立 iterationId
2. 記錄 createdAtMs
3. POST /workflow/{WORKFLOW_NAME}
4. input 帶入 testRunId、iterationId、createdAtMs、crashRatio、payload
5. 成功時計入 workflows_started
6. 失敗時計入 workflow_start_errors 與 errors
```

必要 metrics：

```text
workflow_start_latency
workflows_started
workflow_start_success_rate
workflow_start_errors
```

### Phase 4: Crash Worker Scenario

Crash worker 使用 `constant-arrival-rate`：

```text
rate = CRASH_WORKER_POLL_RPS
duration = TEST_DURATION
exec = crashWorker
```

每次 iteration：

```text
1. poll TASK_TYPE
2. poll miss:
   - crash_worker_poll_misses += 1
   - 不算 error
3. poll error:
   - poll_errors += 1
   - errors += 1
4. poll hit:
   - crash_worker_tasks_polled += 1
   - 記錄 task_scheduled_to_poll_latency
   - 記錄 workflow_submit_to_poll_latency
   - shouldCrash = Math.random() < CRASH_RATIO
5. shouldCrash=true:
   - 不呼叫 /tasks update
   - 不 complete
   - 不 fail
   - crashed_tasks += 1
6. shouldCrash=false:
   - POST /tasks status=COMPLETED
   - crash_worker_tasks_completed += 1
```

crash 行為必須是「poll 後完全不回報」。不可用 `FAILED` 模擬 crash，否則會變成 TC06 retry storm。

### Phase 5: Recovery Worker Scenario

Recovery worker 使用 `constant-arrival-rate`：

```text
rate = RECOVERY_WORKER_POLL_RPS
duration = TEST_DURATION + RECOVERY_GRACE_DURATION
exec = recoveryWorker
```

每次 iteration：

```text
1. poll TASK_TYPE
2. poll miss:
   - recovery_worker_poll_misses += 1
   - 不算 error
3. poll error:
   - poll_errors += 1
   - errors += 1
4. poll hit:
   - recovery_worker_tasks_polled += 1
   - 判斷 task age
   - POST /tasks status=COMPLETED
   - recovery_worker_tasks_completed += 1
5. 如果 Date.now() - createdAtMs >= RESPONSE_TIMEOUT_SECONDS * 1000:
   - 視為 recovered task
   - recovered_tasks += 1
   - 記錄 workflow_submit_to_recovery_complete_latency
   - 記錄 estimated_recovery_latency
```

第一版不使用跨 VU taskId map，所以 recovery latency 是近似值：

```text
estimated_recovery_latency =
  recovery complete time - workflow input createdAtMs
```

這不能宣稱是精準的 crash-to-repoll latency。若後續需要精準值，需要外部 sink 或資料庫記錄 crash worker poll hit 時間。

### Phase 6: Metrics / Thresholds / Summary

建立第 10 節定義的 Trend、Counter、Rate metrics。

`handleSummary()` 需要輸出：

```text
tc07_summary.json
tc07_raw_summary.json
```

`tc07_summary.json` 需要包含：

```text
test config
overall metrics
derived ratios
stable/cliff 判斷
```

derived metrics 至少包含：

```text
observedCrashRatio = crashed_tasks / crash_worker_tasks_polled
recoveredToCrashedRatio = recovered_tasks / crashed_tasks
totalCompletedTasks =
  crash_worker_tasks_completed + recovery_worker_tasks_completed
totalCompletedToStartedRatio = totalCompletedTasks / workflows_started
actualCompletedRps = totalCompletedTasks / TEST_DURATION_SECONDS
isStable
```

`isStable` 至少需檢查：

```text
errors == 0
workflow_start_success_rate >= 0.999
task_complete_success_rate >= 0.99
totalCompletedToStartedRatio >= 0.95
recoveredToCrashedRatio >= 0.90 when crashed_tasks > 0
dropped_iterations == 0
latency p95 未超過 SLA threshold
```

### Phase 7: Smoke / Recovery / Capacity Runs

先做低流量 smoke，再逐步擴大。

```text
Smoke:
  WORKFLOW_START_RPS=1
  CRASH_WORKER_POLL_RPS=4
  RECOVERY_WORKER_POLL_RPS=4
  CRASH_RATIO=0.50
  RESPONSE_TIMEOUT_SECONDS=5
  TIMEOUT_SECONDS=30
  TEST_DURATION=30s
  RECOVERY_GRACE_DURATION=20s

Recovery validation:
  CRASH_RATIO=0
  CRASH_RATIO=0.50
  RESPONSE_TIMEOUT_SECONDS=5/15/30

Capacity:
  固定 CRASH_RATIO=0.50
  逐步提高 WORKFLOW_START_RPS

Cliff confirmation:
  在第一個 unstable RPS 或 response timeout 設定附近重跑
```

---

## 19. TODO Checklist

- [ ] 建立 `k6/scenarios/tc07_worker_crash_recovery.js`。
- [ ] 實作 ENV parser，支援本 spec 第 4 節列出的所有 ENV。
- [ ] 實作 `BASE_URL` 必填檢查與清楚的 fail message。
- [ ] 實作 `CRASH_RATIO` validation：`0 <= CRASH_RATIO <= 1`。
- [ ] 實作 retry / timeout ENV validation。
- [ ] 實作 RPS ENV validation。
- [ ] 實作 task definition payload builder。
- [ ] 實作 workflow definition payload builder。
- [ ] 實作 task definition 查詢、建立與 mismatch validation。
- [ ] 實作 workflow definition 查詢、建立與 mismatch validation。
- [ ] 實作 `AUTO_CREATE_DEFINITIONS` 行為。
- [ ] 實作 `FAIL_ON_DEFINITION_MISMATCH` 行為。
- [ ] 實作 producer scenario options。
- [ ] 實作 producer workflow start payload。
- [ ] 實作 crash worker scenario options。
- [ ] 實作 recovery worker scenario options。
- [ ] 實作 recovery worker duration = `TEST_DURATION + RECOVERY_GRACE_DURATION`。
- [ ] 實作 crash worker poll hit / miss / error parser。
- [ ] 實作 recovery worker poll hit / miss / error parser。
- [ ] 實作 crash injection decision：`Math.random() < CRASH_RATIO`。
- [ ] 實作 crash 行為：不 complete、不 fail、不呼叫 task update。
- [ ] 實作 crash worker non-crash complete request。
- [ ] 實作 recovery worker complete request。
- [ ] 實作 recovered task 近似判斷。
- [ ] 實作 workflow start metrics。
- [ ] 實作 crash worker poll metrics。
- [ ] 實作 recovery worker poll metrics。
- [ ] 實作 task scheduled-to-poll latency。
- [ ] 實作 workflow submit-to-poll latency。
- [ ] 實作 workflow submit-to-task-complete latency。
- [ ] 實作 workflow submit-to-recovery-complete latency。
- [ ] 實作 estimated recovery latency。
- [ ] 實作所有 Counter metrics。
- [ ] 實作所有 Rate metrics。
- [ ] 實作 strict / non-strict thresholds。
- [ ] 實作 `handleSummary()` 輸出 `tc07_summary.json`。
- [ ] 實作 `handleSummary()` 輸出 `tc07_raw_summary.json`。
- [ ] 實作 derived ratios：`observedCrashRatio`、`recoveredToCrashedRatio`、`totalCompletedToStartedRatio`。
- [ ] 實作 `isStable` 與 cliff 判定欄位。
- [ ] 建立低 RPS smoke validation command 範例。
- [ ] 建立 response timeout matrix command 範例。
- [ ] 建立 capacity/SLA run command 範例。
- [ ] 驗證 `CRASH_RATIO=0` 時不產生 crashed/recovered tasks。
- [ ] 驗證 `CRASH_RATIO>0` 時 recovery worker 可取得 timeout 後 task。

---

## 20. Validation Criteria

### 20.1 Spec-level validation

文件本身需要符合：

```text
1. TC07 清楚描述 worker crash / response timeout recovery。
2. TC07 與 TC06 retry storm 的差異清楚。
3. 正式 runtime 包含 producer、crash worker、recovery worker 三個 scenario。
4. crash worker 的 crash 行為是不回報任何 task update。
5. recovery worker duration 明確包含 RECOVERY_GRACE_DURATION。
6. ENV、metrics、summary、成功標準與 cliff 判定彼此命名一致。
7. Summary schema 包含 crash、recovery、latency、derived ratios。
8. 文件明確說明第一版 recovery latency 是近似值。
```

### 20.2 Script-level validation

k6 腳本完成後，需要通過：

```text
1. 腳本可以被 k6 載入。
2. BASE_URL 缺失時會 fail，且錯誤訊息清楚。
3. CRASH_RATIO 必須介於 0 到 1。
4. RETRY_COUNT >= 0。
5. RETRY_DELAY_SECONDS >= 0。
6. RESPONSE_TIMEOUT_SECONDS > 0。
7. TIMEOUT_SECONDS > RESPONSE_TIMEOUT_SECONDS。
8. WORKFLOW_START_RPS >= 1。
9. CRASH_WORKER_POLL_RPS >= 1。
10. RECOVERY_WORKER_POLL_RPS >= 1。
11. options.scenarios 包含 producer、crashWorker、recoveryWorker。
12. recoveryWorker duration = TEST_DURATION + RECOVERY_GRACE_DURATION。
13. STRICT_LATENCY_THRESHOLD=true 時啟用 latency thresholds。
14. STRICT_LATENCY_THRESHOLD=false 時只保留基礎成功率與 error thresholds。
```

### 20.3 Runtime smoke validation

使用低 RPS 與短 timeout 進行 smoke run：

```bash
k6 run \
  -e BASE_URL="https://your-conductor-domain" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_START_RPS=1 \
  -e CRASH_WORKER_POLL_RPS=4 \
  -e RECOVERY_WORKER_POLL_RPS=4 \
  -e CRASH_RATIO=0.50 \
  -e RESPONSE_TIMEOUT_SECONDS=5 \
  -e TIMEOUT_SECONDS=30 \
  -e TEST_DURATION="30s" \
  -e RECOVERY_GRACE_DURATION="20s" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=false \
  k6/scenarios/tc07_worker_crash_recovery.js
```

Smoke run 需要符合：

```text
1. definitions 可建立或驗證。
2. workflows_started > 0。
3. crash_worker_tasks_polled > 0。
4. crashed_tasks > 0。
5. recovery_worker_tasks_polled > 0。
6. recovered_tasks > 0。
7. workflow_start_errors = 0。
8. poll_errors = 0。
9. complete_errors = 0。
10. tc07_summary.json 產生成功。
11. tc07_raw_summary.json 產生成功。
```

### 20.4 Recovery behavior validation

`CRASH_RATIO=0` 時：

```text
crashed_tasks = 0
recovered_tasks = 0
total_completed_to_started_ratio 接近 1
errors = 0
```

`CRASH_RATIO=0.50` 時：

```text
observedCrashRatio 接近 0.50
recovered_tasks > 0
recoveredToCrashedRatio 在 grace window 內達到門檻
estimated_recovery_latency p95 >= RESPONSE_TIMEOUT_SECONDS * 1000
errors = 0
```

拉長 `RESPONSE_TIMEOUT_SECONDS` 時：

```text
estimated_recovery_latency p95 應跟著上升
recovered task 出現時間不應早於合理 timeout window
```

### 20.5 Capacity-run validation

stable round 必須滿足：

```text
errors = 0
workflow_start_success_rate >= 0.999
task_complete_success_rate >= 0.99
dropped_iterations = 0
total_completed_to_started_ratio >= 0.95
recovered_to_crashed_ratio >= 0.90
estimated_recovery_latency p95 <= SLA_RECOVERY_LATENCY_P95_MS
workflow_start_latency p95 < SLA_API_P95_MS
task_update_latency p95 < SLA_API_P95_MS
```

以下任一條件成立即視為 cliff：

```text
recovered_to_crashed_ratio < 0.90
total_completed_to_started_ratio < 0.95
dropped_iterations > 0
errors > 0
estimated_recovery_latency p95 超過 SLA
recovery worker 長時間 poll miss 且 crashed task 未恢復
task 疑似永久卡在 IN_PROGRESS
```

### 20.6 Output validation

`tc07_summary.json` 必須包含：

```text
test config
overall metrics
derived ratios
isStable
cliff signals
```

`tc07_raw_summary.json` 必須包含所有 k6 原始 metrics。

最終報告需要可推導：

```text
response timeout 建議值
50% crash ratio 下最大穩定 workflow start RPS
recovered-to-crashed ratio
recovery latency p95
short/medium task 的 response timeout 建議
```

---

## 21. TC07 最終產出

測完後整理：

    tc07_result:
      response_timeout_seconds: TBD
      max_stable_workflow_start_rps_under_50_percent_crash: TBD
      recovered_to_crashed_ratio: TBD
      recovery_latency_p95_ms: TBD
      recommended_response_timeout_for_short_task: TBD
      recommended_response_timeout_for_medium_task: TBD

---

## 22. 對內 SLA / Worker 規範轉換

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
