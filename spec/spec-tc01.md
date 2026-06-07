# spec-tc01.md

# TC01 - Preloaded Workflow Poll Task Capacity Test

## 1. 目的

測試在 Conductor 3.21.22 + MariaDB Queue 架構下，單一 workflow definition + 單一 SIMPLE task type，在已經預先建立大量 workflow instances 的情境中，worker 對該 task type 進行 `poll -> complete` 的最大穩定承受能力。

本測試的重點是調整：

```text
GET /tasks/poll/{TASK_TYPE} 的 RPS
POST /tasks complete 的吞吐與 latency
```

TC01 不再觀察 `POST /workflow` 的 create workflow RPS 或 latency。Workflow 建立成本會在後續獨立測試處理。

本測試要回答：

```text
當 queue 中已經有足夠多待處理 SIMPLE task 時，
單一 task type 的 worker poll RPS 可以穩定推到多少？
在哪個 poll RPS 開始出現 API latency、queue latency、task update latency、error rate 或 dropped iterations cliff？
```

TC01 的輸出會作為後續測試設定 worker poll 上限與 safe poll RPS 的基準值。

---

## 2. 測試模型

TC01 使用 **preload / worker 分離模式**。

初始化階段先建立多個相同 workflow instances：

```text
wf_perf_tc01_single
wf_perf_tc01_single
wf_perf_tc01_single
...
```

每個 workflow instance 都會 schedule 同一個 SIMPLE task：

```text
perf_task_tc01_single
```

正式測試階段只執行 worker：

```text
worker scenario:
  固定 POLL_RPS 呼叫 GET /tasks/poll/perf_task_tc01_single
  如果 poll hit，就 POST /tasks complete
```

測試期間不啟動新的 workflow。這樣可以把 create workflow 的成本從 TC01 中移除，讓測試結果更聚焦在 poll task 與 complete task 的承受能力。

---

## 3. 測試對象

### Workflow Definition

```text
workflow name: wf_perf_tc01_single
version: 1
task: perf_task_tc01_single
```

### Task Definition

```text
task name: perf_task_tc01_single
type: SIMPLE
retryCount: 0
timeoutSeconds: 600
responseTimeoutSeconds: 300
pollTimeoutSeconds: 600
timeoutPolicy: TIME_OUT_WF
```

注意：

```text
timeoutSeconds / responseTimeoutSeconds / pollTimeoutSeconds 需要足夠長，
避免 preload 完成後正式測試尚未 poll 到 task，task 就先 timeout。
```

---

## 4. k6 腳本目標

AI agent 需要建立：

```text
k6/scenarios/tc01_preloaded_workflow_poll_capacity.js
```

此腳本需要做到：

1. 啟動前檢查 task definition。
2. 不存在時自動建立 task definition。
3. 啟動前檢查 workflow definition。
4. 不存在時自動建立 workflow definition。
5. 初始化階段建立 `PRELOAD_WORKFLOW_COUNT` 個相同 workflow instances。
6. 初始化階段等待或確認足夠 task 已可被 poll。
7. 正式測試階段不再建立 workflow。
8. 正式測試階段以固定 `POLL_RPS` poll task。
9. worker poll 到 task 後立即 complete。
10. 收集 poll attempt / poll hit / poll miss latency。
11. 收集 task update latency。
12. 收集 task scheduled-to-poll latency。
13. 收集 backlog drain 與 completion ratio。
14. 輸出 k6 summary JSON。

---

## 5. 必要環境變數

```bash
BASE_URL="https://your-conductor-domain"
API_PREFIX="/api"

WORKFLOW_NAME="wf_perf_tc01_single"
TASK_TYPE="perf_task_tc01_single"
WORKFLOW_VERSION=1
OWNER_EMAIL="perf-test@example.com"

AUTO_CREATE_DEFINITIONS=true
FAIL_ON_DEFINITION_MISMATCH=true

PRELOAD_WORKFLOW_COUNT=100000
PRELOAD_BATCH_SIZE=100
PRELOAD_MAX_IN_FLIGHT_BATCHES=5
PRELOAD_READY_MIN_TASKS=1000
PRELOAD_READY_TIMEOUT_MS=300000

POLL_RPS=1000
TEST_DURATION="5m"

WORKER_PRE_ALLOCATED_VUS=200
WORKER_MAX_VUS=2000
WORKER_ID_PREFIX="k6-tc01-worker"

SLA_POLL_ATTEMPT_P95_MS=500
SLA_POLL_HIT_P95_MS=500
SLA_TASK_UPDATE_P95_MS=500
SLA_SCHEDULE_TO_POLL_P95_MS=300000
MAX_ERROR_RATE=0.001
STRICT_LATENCY_THRESHOLD=false
```

建議：

```text
PRELOAD_WORKFLOW_COUNT >= POLL_RPS * TEST_DURATION_SECONDS * 1.2
```

目的：

```text
避免測試還沒結束 queue 就被 drain 完，導致 poll miss 增加並污染 poll capacity 判斷。
```

---

## 6. Workflow Definition Spec

k6 `setup()` 需要確認以下 workflow definition 存在，不存在就建立。

```json
{
  "name": "wf_perf_tc01_single",
  "description": "TC01 preloaded workflow poll task capacity test",
  "version": 1,
  "schemaVersion": 2,
  "ownerEmail": "perf-test@example.com",
  "inputParameters": [
    "testRunId",
    "preloadIndex",
    "createdAtMs",
    "payload"
  ],
  "outputParameters": {
    "testRunId": "${workflow.input.testRunId}",
    "preloadIndex": "${workflow.input.preloadIndex}"
  },
  "tasks": [
    {
      "name": "perf_task_tc01_single",
      "taskReferenceName": "perf_task_tc01_single_ref",
      "type": "SIMPLE",
      "inputParameters": {
        "testRunId": "${workflow.input.testRunId}",
        "preloadIndex": "${workflow.input.preloadIndex}",
        "createdAtMs": "${workflow.input.createdAtMs}",
        "payload": "${workflow.input.payload}"
      }
    }
  ]
}
```

---

## 7. Task Definition Spec

```json
{
  "name": "perf_task_tc01_single",
  "description": "TC01 preloaded single simple task",
  "retryCount": 0,
  "retryLogic": "FIXED",
  "retryDelaySeconds": 0,
  "timeoutSeconds": 600,
  "responseTimeoutSeconds": 300,
  "pollTimeoutSeconds": 600,
  "timeoutPolicy": "TIME_OUT_WF",
  "ownerEmail": "perf-test@example.com",
  "inputKeys": [],
  "outputKeys": [],
  "inputTemplate": {}
}
```

---

## 8. 初始化設計

### 8.1 Definition Setup

`setup()` 先做 definition 檢查：

```text
1. GET task definition
2. 不存在且 AUTO_CREATE_DEFINITIONS=true 時建立
3. 存在但內容不符且 FAIL_ON_DEFINITION_MISMATCH=true 時 fail
4. GET workflow definition
5. 不存在且 AUTO_CREATE_DEFINITIONS=true 時建立
6. 存在但內容不符且 FAIL_ON_DEFINITION_MISMATCH=true 時 fail
```

### 8.2 Workflow Preload

definition 準備完成後，`setup()` 建立 `PRELOAD_WORKFLOW_COUNT` 個 workflow instances。

每個 workflow start request body：

```json
{
  "testRunId": "tc01-20260607-123456",
  "preloadIndex": 1,
  "createdAtMs": 1780816496000,
  "payload": {
    "source": "tc01-preload"
  }
}
```

preload 階段要求：

```text
1. 使用 PRELOAD_BATCH_SIZE 控制每批建立數量。
2. 可用 http.batch 控制同批 request。
3. preload create workflow 的 latency 不納入 TC01 正式 metrics。
4. preload create workflow 失敗需要 fail setup，避免正式測試 queue 數量不足。
5. 每個 workflow 使用唯一 correlationId，例如 {testRunId}-{preloadIndex}。
```

### 8.3 Ready Check

preload 完成後，需要確認 queue 中有足夠 task 可供正式測試使用。

最低要求：

```text
待 poll task 數量 >= PRELOAD_READY_MIN_TASKS
```

實作優先順序：

```text
1. 如果環境有可用 queue depth / task queue inspection API，使用該 API。
2. 否則只確認 preload workflow start 全部成功。
3. 不要使用 poll 做 ready check，避免消耗正式測試要用的 task。
```

---

## 9. Scenario 設計

正式測試只需要一個 worker scenario，使用 k6 `constant-arrival-rate` 產生固定 poll RPS。

```javascript
worker: {
  executor: 'constant-arrival-rate',
  rate: POLL_RPS,
  timeUnit: '1s',
  duration: TEST_DURATION,
  preAllocatedVUs: WORKER_PRE_ALLOCATED_VUS,
  maxVUs: WORKER_MAX_VUS,
  exec: 'worker',
}
```

Worker 每次 iteration 做：

```text
1. GET /tasks/poll/{TASK_TYPE}?workerid={workerId}
2. 記錄 poll_attempt_latency
3. 如果 poll miss:
   - 記錄 poll_miss_latency
   - poll_misses + 1
   - 結束 iteration
4. 如果 poll hit:
   - 記錄 poll_hit_latency
   - tasks_polled + 1
   - 從 task.scheduledTime 計算 task_scheduled_to_poll_latency
   - POST /tasks complete
   - 記錄 task_update_latency
   - tasks_completed + 1
5. 如果 poll 或 complete 回傳非預期 status:
   - 對應 error counter + 1
   - errors + 1
```

---

## 10. Poll Hit / Poll Miss 判斷規則

### Poll Hit

```text
HTTP status = 200
body 可以 parse 成 JSON
body.taskId 存在
body.taskType = TASK_TYPE
```

### Poll Miss

```text
HTTP status = 204
或 HTTP status = 200 且 body empty
或 HTTP status = 200 且 body = "null"
```

### Poll Error

```text
HTTP status 不是 200 / 204
或 body 無法 parse
或 body.taskType 不是 TASK_TYPE
```

---

## 11. 必要 Metrics

### 11.1 Trend

```javascript
poll_attempt_latency
poll_hit_latency
poll_miss_latency
task_update_latency
task_scheduled_to_poll_latency
```

### 11.2 Counter

```javascript
preloaded_workflows
preload_errors
poll_attempts
tasks_polled
tasks_completed
poll_misses
poll_errors
complete_errors
missing_task_scheduled_time
unexpected_task_type
errors
```

### 11.3 Rate

```javascript
poll_hit_rate
task_complete_success_rate
poll_success_rate
```

注意：

```text
preloaded_workflows 與 preload_errors 只用於描述初始化結果，
不應拿來判斷正式測試期間的 create workflow capacity。
```

---

## 12. 指標定義

### 12.1 `poll_attempt_latency`

量測：

```text
GET /tasks/poll/{TASK_TYPE}
```

每一次 poll request 的 latency，不論 hit 或 miss。

### 12.2 `poll_hit_latency`

只在 poll response 有拿到 task 時記錄。

用途：

```text
確認 queue 中有任務時，poll API 從 queue 取出 task 的 latency。
```

### 12.3 `poll_miss_latency`

只在沒有拿到 task 時記錄。

用途：

```text
確認 queue 被 drain 完或 worker poll 過快時，poll miss 的 API latency。
```

TC01 正常測試期間 poll miss 不應大量出現。大量 poll miss 通常代表：

```text
PRELOAD_WORKFLOW_COUNT 不足
或 POLL_RPS 已高於 task 可供應 / complete 能力
或測試時間過長導致 backlog 被 drain 完
```

### 12.4 `task_update_latency`

量測：

```text
POST /tasks
```

將 task 標記為 `COMPLETED` 的 latency。

### 12.5 `task_scheduled_to_poll_latency`

計算：

```javascript
const pollReceivedAtMs = Date.now();
const scheduledAtMs = normalizeEpochMs(task.scheduledTime);
taskScheduledToPollLatency.add(pollReceivedAtMs - scheduledAtMs);
```

用途：

```text
觀察預先建立的 task 在 queue 中等待多久才被 worker poll 到。
```

注意：

```text
因為 workflow 是 preload 建立，這個值會包含 preload 完成後 task 在 queue 裡等待的時間。
它不是 create workflow latency，也不是 workflow submit latency。
```

---

## 13. Threshold 建議

TC01 是容量測試，latency threshold 建議可透過 ENV 控制。

嚴格模式：

```javascript
thresholds: {
  task_complete_success_rate: ['rate>=0.999'],
  poll_success_rate: ['rate>=0.999'],
  errors: ['count==0'],
  poll_attempt_latency: [`p(95)<${SLA_POLL_ATTEMPT_P95_MS}`],
  poll_hit_latency: [`p(95)<${SLA_POLL_HIT_P95_MS}`],
  task_update_latency: [`p(95)<${SLA_TASK_UPDATE_P95_MS}`],
  task_scheduled_to_poll_latency: [`p(95)<${SLA_SCHEDULE_TO_POLL_P95_MS}`],
}
```

初次收集數據可使用：

```bash
STRICT_LATENCY_THRESHOLD=false
```

此時只檢查：

```javascript
errors: ['count==0']
poll_success_rate: ['rate>=0.99']
task_complete_success_rate: ['rate>=0.99']
```

---

## 14. 執行方式

```bash
k6 run \
  -e BASE_URL="https://your-conductor-domain" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_tc01_single" \
  -e TASK_TYPE="perf_task_tc01_single" \
  -e PRELOAD_WORKFLOW_COUNT=100000 \
  -e POLL_RPS=1000 \
  -e TEST_DURATION="5m" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=true \
  k6/scenarios/tc01_preloaded_workflow_poll_capacity.js
```

---

## 15. 建議測試階段

手動跑多輪，每輪只調整 `POLL_RPS`。

```text
Round 1:
  PRELOAD_WORKFLOW_COUNT=30000
  POLL_RPS=100

Round 2:
  PRELOAD_WORKFLOW_COUNT=60000
  POLL_RPS=200

Round 3:
  PRELOAD_WORKFLOW_COUNT=120000
  POLL_RPS=400

Round 4:
  PRELOAD_WORKFLOW_COUNT=180000
  POLL_RPS=600

Round 5:
  PRELOAD_WORKFLOW_COUNT=240000
  POLL_RPS=800

Round 6:
  PRELOAD_WORKFLOW_COUNT=300000
  POLL_RPS=1000
```

計算方式：

```text
PRELOAD_WORKFLOW_COUNT = POLL_RPS * TEST_DURATION_SECONDS * 1.2
```

如果想確認 cliff point，可以在接近上限後改用較小級距：

```text
POLL_RPS: 1000 -> 1100 -> 1200 -> 1300
```

---

## 16. 成功標準

某一輪視為 stable，需要符合：

```text
task_complete_success_rate >= 99.9%
poll_success_rate >= 99.9%
errors = 0
poll_attempt_latency p95 < SLA_POLL_ATTEMPT_P95_MS
poll_hit_latency p95 < SLA_POLL_HIT_P95_MS
task_update_latency p95 < SLA_TASK_UPDATE_P95_MS
poll_hit_rate 不應因 queue 不足而明顯下降
k6 dropped_iterations = 0
```

補充判斷：

```text
tasks_completed / poll_attempts 應接近 poll_hit_rate
tasks_completed / tasks_polled >= 0.999
poll_misses 應只在 queue 被 drain 完時出現
```

---

## 17. Cliff Point 判定

如果出現以下任一條件，該 `POLL_RPS` 視為超過穩定上限：

```text
poll_attempt_latency p95 超過 SLA
poll_hit_latency p95 超過 SLA
task_update_latency p95 超過 SLA
task_complete_success_rate < 99.9%
poll_success_rate < 99.9%
errors > 0
complete_errors > 0
poll_errors > 0
k6 dropped_iterations > 0
poll hit rate 在 backlog 足夠時仍急遽下降
```

---

## 18. 輸出 Summary 格式

`handleSummary()` 需要輸出：

```text
tc01_summary.json
tc01_raw_summary.json
```

`tc01_summary.json` 至少包含：

```json
{
  "testCase": "TC01",
  "workflowName": "wf_perf_tc01_single",
  "taskType": "perf_task_tc01_single",
  "preloadWorkflowCount": 100000,
  "pollRps": 1000,
  "testDuration": "5m",
  "metrics": {
    "preloadedWorkflows": {},
    "preloadErrors": {},
    "pollAttempts": {},
    "tasksPolled": {},
    "tasksCompleted": {},
    "pollMisses": {},
    "pollAttemptLatency": {},
    "pollHitLatency": {},
    "pollMissLatency": {},
    "taskUpdateLatency": {},
    "taskScheduledToPollLatency": {},
    "pollHitRate": {},
    "pollSuccessRate": {},
    "taskCompleteSuccessRate": {},
    "errors": {}
  },
  "derived": {
    "taskCompletedToPollAttemptRatio": 0.99,
    "taskCompletedToTaskPolledRatio": 0.999,
    "pollMissRatio": 0.01,
    "isStable": true
  }
}
```

---

## 19. TC01 最終產出

TC01 完成後，需要人工或 script 整理出：

```yaml
tc01_result:
  max_stable_poll_rps: TBD
  recommended_safe_poll_rps: TBD
  poll_attempt_p95_ms: TBD
  poll_hit_p95_ms: TBD
  task_update_p95_ms: TBD
  task_scheduled_to_poll_p95_ms: TBD
  task_complete_success_rate: TBD
  poll_success_rate: TBD
```

其中建議：

```text
recommended_safe_poll_rps = max_stable_poll_rps * 0.7
```

此值會作為後續 worker 設定與 task poll capacity 測試的基準。
