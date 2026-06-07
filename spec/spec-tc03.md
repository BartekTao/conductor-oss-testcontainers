# spec-tc03.md

# TC03 - Preloaded Multi-Pair Poll Scaling Test

## 1. 目的

測試在 Conductor 3.21.22 + MariaDB Queue 架構下，透過增加多組獨立 workflow definition + 獨立 SIMPLE task type，worker poll/complete 的總吞吐是否可以水平擴展。

TC03 延續 TC01 的 preload 模型：

```text
setup:
  建立多組 workflow/task pair
  每組 preload 多個 workflow instances

runtime:
  每組 task type 啟動獨立 worker scenario
  worker 只執行 poll -> complete
```

本測試不評估 runtime workflow creation throughput。Workflow start 只發生在初始化 preload 階段，並作為準備 backlog 的手段。

本測試要回答：

```text
如果單一 task type 的 safe poll capacity 是 X RPS，
那我建立 N 組彼此獨立的 workflow/task pair，
每一組都以 X RPS poll task，
整個 Conductor + MariaDB Queue 是否能接近 N 倍擴展？
```

此測試可以檢查：

```text
1 組 task type 是否穩定
2 組是否接近 2 倍
4 組是否接近 4 倍
8 組是否還能維持
何時開始出現 DB queue、row lock、API latency、poll latency、task update latency 或 dropped iterations cliff
```

---

## 2. 測試模型

預先建立 N 組獨立 workflow/task pair。

例如：

```text
wf_perf_tc03_001 -> perf_task_tc03_001
wf_perf_tc03_002 -> perf_task_tc03_002
wf_perf_tc03_003 -> perf_task_tc03_003
...
wf_perf_tc03_N   -> perf_task_tc03_N
```

每個 workflow 只有一個 SIMPLE task。

初始化階段會對每一個 active pair preload 多個 workflow instances，讓每個 task type 都有足夠待 poll 的 task backlog。

正式測試階段只執行 worker：

```text
worker_pair_001:
  固定 PAIR_POLL_RPS poll perf_task_tc03_001
  poll hit 後立即 complete

worker_pair_002:
  固定 PAIR_POLL_RPS poll perf_task_tc03_002
  poll hit 後立即 complete

...
```

---

## 3. 名詞定義

```yaml
MAX_PAIR_COUNT:
  說明: setup 階段最多準備幾組 workflow/task pair definitions
  範例: 16

PAIR_COUNT:
  說明: 本次測試實際啟用前幾組 workflow/task pair
  範例: 1, 2, 4, 8, 16

PAIR_PRELOAD_WORKFLOW_COUNT:
  說明: 每一組 active pair preload 幾個 workflow instances
  建議: PAIR_POLL_RPS * TEST_DURATION_SECONDS * 1.2

PAIR_POLL_RPS:
  說明: 每一組 task worker 的 poll RPS
  來源: TC01 測出的 recommended_safe_poll_rps

TOTAL_PRELOAD_WORKFLOW_COUNT:
  公式: PAIR_COUNT * PAIR_PRELOAD_WORKFLOW_COUNT

TOTAL_POLL_RPS:
  公式: PAIR_COUNT * PAIR_POLL_RPS

TC01_SINGLE_PAIR_STABLE_TASK_COMPLETED_RPS:
  說明: TC01 測出的單一 task type stable completed task RPS
  預設: 未提供時使用 PAIR_POLL_RPS
```

例如 TC01 結果：

```yaml
recommended_safe_poll_rps: 300
task_complete_success_rate: 1.0
```

TC03 測試：

```yaml
PAIR_COUNT: 4
PAIR_PRELOAD_WORKFLOW_COUNT: 108000
PAIR_POLL_RPS: 300
TEST_DURATION: 5m

TOTAL_PRELOAD_WORKFLOW_COUNT: 432000
TOTAL_POLL_RPS: 1200
```

---

## 4. k6 腳本目標

AI agent 需要建立：

```text
k6/scenarios/tc03_preloaded_independent_poll_scale.js
```

此腳本需要做到：

1. 啟動前依照 `MAX_PAIR_COUNT` 預先建立 task definitions。
2. 啟動前依照 `MAX_PAIR_COUNT` 預先建立 workflow definitions。
3. 每個 workflow 對應唯一 task type。
4. 根據 `PAIR_COUNT` 啟用前 N 組 workflow/task pair。
5. 初始化階段對每個 active pair preload `PAIR_PRELOAD_WORKFLOW_COUNT` 個 workflow instances。
6. 正式測試階段不建立新的 workflow。
7. 正式測試階段每組 task worker 以固定 `PAIR_POLL_RPS` poll。
8. worker poll hit 後立即 complete。
9. 每組獨立收集 metrics，並加上 tag：

   * `pairId`
   * `workflowName`
   * `taskType`
10. 輸出整體 summary 與 per-pair summary。
11. 計算 scaling efficiency。

---

## 5. 必要環境變數

```bash
BASE_URL="https://your-conductor-domain"
API_PREFIX="/api"

WORKFLOW_PREFIX="wf_perf_tc03"
TASK_PREFIX="perf_task_tc03"
WORKFLOW_VERSION=1
OWNER_EMAIL="perf-test@example.com"

AUTO_CREATE_DEFINITIONS=true
FAIL_ON_DEFINITION_MISMATCH=true

MAX_PAIR_COUNT=16
PAIR_COUNT=4

PAIR_PRELOAD_WORKFLOW_COUNT=108000
PRELOAD_BATCH_SIZE=100
PRELOAD_MAX_IN_FLIGHT_BATCHES=5

PAIR_POLL_RPS=300
TEST_DURATION="5m"

TC01_SINGLE_PAIR_STABLE_TASK_COMPLETED_RPS=300

SLA_POLL_ATTEMPT_P95_MS=500
SLA_POLL_HIT_P95_MS=500
SLA_TASK_UPDATE_P95_MS=500
SLA_SCHEDULE_TO_POLL_P95_MS=300000
MAX_ERROR_RATE=0.001
STRICT_LATENCY_THRESHOLD=false
```

建議：

```text
PAIR_PRELOAD_WORKFLOW_COUNT >= PAIR_POLL_RPS * TEST_DURATION_SECONDS * 1.2
```

目的：

```text
避免正式測試期間某一組 pair 的 backlog 被 drain 完，
導致 poll miss 增加並污染 scaling efficiency 判斷。
```

---

## 6. Workflow / Task 命名規則

第 1 組：

```text
pairId = 001
workflowName = wf_perf_tc03_001
taskType = perf_task_tc03_001
```

第 2 組：

```text
pairId = 002
workflowName = wf_perf_tc03_002
taskType = perf_task_tc03_002
```

第 N 組：

```text
pairId = NNN
workflowName = wf_perf_tc03_NNN
taskType = perf_task_tc03_NNN
```

其中 `NNN` 是三位數補零。

Active pairs：

```text
PAIR_COUNT=4
active pairIds = 001, 002, 003, 004
```

setup 階段可以依 `MAX_PAIR_COUNT` 建立所有 definitions，但 preload 與 runtime 只啟用前 `PAIR_COUNT` 組。

---

## 7. Task Definition Spec

每一組 task definition 格式相同，只替換 `name`。

```json
{
  "name": "perf_task_tc03_001",
  "description": "TC03 preloaded independent simple task 001",
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

注意：

```text
timeoutSeconds / responseTimeoutSeconds / pollTimeoutSeconds 需要足夠長，
避免 preload 完成後正式測試尚未 poll 到 task，task 就先 timeout。
```

---

## 8. Workflow Definition Spec

每一組 workflow definition 格式相同，只替換：

```text
workflow name
task name
taskReferenceName
description
```

範例第 1 組：

```json
{
  "name": "wf_perf_tc03_001",
  "description": "TC03 preloaded independent workflow 001",
  "version": 1,
  "schemaVersion": 2,
  "ownerEmail": "perf-test@example.com",
  "inputParameters": [
    "testRunId",
    "pairId",
    "preloadIndex",
    "createdAtMs",
    "payload"
  ],
  "outputParameters": {
    "testRunId": "${workflow.input.testRunId}",
    "pairId": "${workflow.input.pairId}",
    "preloadIndex": "${workflow.input.preloadIndex}"
  },
  "tasks": [
    {
      "name": "perf_task_tc03_001",
      "taskReferenceName": "perf_task_tc03_001_ref",
      "type": "SIMPLE",
      "inputParameters": {
        "testRunId": "${workflow.input.testRunId}",
        "pairId": "${workflow.input.pairId}",
        "preloadIndex": "${workflow.input.preloadIndex}",
        "createdAtMs": "${workflow.input.createdAtMs}",
        "payload": "${workflow.input.payload}"
      }
    }
  ]
}
```

---

## 9. setup() 行為

k6 `setup()` 需要先準備 definitions：

```text
for pairId in 1..MAX_PAIR_COUNT:
  1. build taskType
  2. GET /metadata/taskdefs/{taskType}
  3. 不存在則 POST /metadata/taskdefs
  4. 存在則 validate

  5. build workflowName
  6. GET /metadata/workflow/{workflowName}?version=1
  7. 不存在則 POST /metadata/workflow
  8. 存在則 validate
```

Validation 至少檢查：

```text
workflow name 正確
workflow version 正確
workflow 只有 1 個 task
workflow task name 等於對應 taskType
workflow task type = SIMPLE
task inputParameters 包含:
  - testRunId
  - pairId
  - preloadIndex
  - createdAtMs
```

如果不符合且：

```bash
FAIL_ON_DEFINITION_MISMATCH=true
```

則直接 fail。

Definitions 準備完成後，`setup()` 需要對 active pairs preload workflow instances：

```text
for pairId in 1..PAIR_COUNT:
  for preloadIndex in 1..PAIR_PRELOAD_WORKFLOW_COUNT:
    POST /workflow/{workflowName}?version=1&correlationId={testRunId}-{pairId}-{preloadIndex}
```

每個 workflow start request body：

```json
{
  "testRunId": "tc03-20260607-123456",
  "pairId": "001",
  "preloadIndex": 1,
  "createdAtMs": 1780816496000,
  "payload": {
    "source": "tc03-preload"
  }
}
```

preload 階段要求：

```text
1. 使用 PRELOAD_BATCH_SIZE 控制每批建立數量。
2. 使用 PRELOAD_MAX_IN_FLIGHT_BATCHES 控制單輪 batch window。
3. preload request 的 latency 只作為初始化資訊，不列入正式測試 capacity 判斷。
4. 任一 preload request 失敗需要 fail setup。
5. 不要使用 poll 做 ready check，避免消耗正式測試要用的 task。
```

---

## 10. Scenario 設計

TC03 需要根據 `PAIR_COUNT` 動態建立 worker scenarios。

每一組 active pair 需要一個 worker scenario：

```text
worker_pair_001
worker_pair_002
worker_pair_003
...
worker_pair_N
```

每個 worker 使用：

```javascript
worker_pair_001: {
  executor: 'constant-arrival-rate',
  rate: PAIR_POLL_RPS,
  timeUnit: '1s',
  duration: TEST_DURATION,
  preAllocatedVUs: PAIR_WORKER_PRE_ALLOCATED_VUS,
  maxVUs: PAIR_WORKER_MAX_VUS,
  exec: 'worker',
  env: {
    PAIR_ID: '001'
  },
  tags: {
    pairId: '001',
    workflowName: 'wf_perf_tc03_001',
    taskType: 'perf_task_tc03_001'
  }
}
```

Worker 每次 iteration 做：

```text
1. 根據 PAIR_ID 取得 taskType
2. GET /tasks/poll/{taskType}?workerid={workerId}
3. 記錄 poll_attempt_latency，tag pairId
4. 如果 poll miss:
   - 記錄 poll_miss_latency，tag pairId
   - poll_misses + 1，tag pairId
   - 結束 iteration
5. 如果 poll hit:
   - 記錄 poll_hit_latency，tag pairId
   - tasks_polled + 1，tag pairId
   - 計算 task_scheduled_to_poll_latency，tag pairId
   - POST /tasks complete
   - 記錄 task_update_latency，tag pairId
   - tasks_completed + 1，tag pairId
6. 如果 poll 或 complete 回傳非預期 status:
   - 對應 error counter + 1，tag pairId
   - errors + 1，tag pairId
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

正式測試 metrics 必須加 tag：

```javascript
{
  pairId: "001",
  workflowName: "wf_perf_tc03_001",
  taskType: "perf_task_tc03_001"
}
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

`preloaded_workflows` 與 `preload_errors` 也應加 pair tags，方便檢查每組 preload 結果。

### 11.3 Rate

```javascript
poll_hit_rate
poll_success_rate
task_complete_success_rate
```

---

## 12. Scaling Efficiency 計算

TC03 需要在 summary 裡計算：

```text
expected_total_poll_rps = PAIR_COUNT * PAIR_POLL_RPS
total_preload_workflow_count = PAIR_COUNT * PAIR_PRELOAD_WORKFLOW_COUNT
```

實際完成量：

```text
actual_task_completed_rps = tasks_completed / TEST_DURATION_SECONDS
```

Scaling baseline：

```text
single_pair_baseline_completed_rps =
  TC01_SINGLE_PAIR_STABLE_TASK_COMPLETED_RPS || PAIR_POLL_RPS
```

Scaling efficiency：

```text
scaling_efficiency =
  actual_task_completed_rps /
  (PAIR_COUNT * single_pair_baseline_completed_rps)
```

每組 pair 也需要計算：

```text
pair_actual_task_completed_rps = pair.tasks_completed / TEST_DURATION_SECONDS
pair_scaling_efficiency =
  pair_actual_task_completed_rps / single_pair_baseline_completed_rps
```

---

## 13. 建議判斷標準

```yaml
scaling_efficiency:
  ">= 0.90": excellent
  "0.75 - 0.90": good
  "0.60 - 0.75": acceptable
  "0.40 - 0.60": poor
  "< 0.40": not scalable
```

---

## 14. 測試階段設計

假設 TC01 結果：

```yaml
recommended_safe_poll_rps: 300
task_complete_success_rate: 1.0
```

TC03 應跑：

```text
Round 1:
  PAIR_COUNT=1
  PAIR_PRELOAD_WORKFLOW_COUNT=108000
  PAIR_POLL_RPS=300
  TOTAL_PRELOAD_WORKFLOW_COUNT=108000
  TOTAL_POLL_RPS=300

Round 2:
  PAIR_COUNT=2
  PAIR_PRELOAD_WORKFLOW_COUNT=108000
  PAIR_POLL_RPS=300
  TOTAL_PRELOAD_WORKFLOW_COUNT=216000
  TOTAL_POLL_RPS=600

Round 3:
  PAIR_COUNT=4
  PAIR_PRELOAD_WORKFLOW_COUNT=108000
  PAIR_POLL_RPS=300
  TOTAL_PRELOAD_WORKFLOW_COUNT=432000
  TOTAL_POLL_RPS=1200

Round 4:
  PAIR_COUNT=8
  PAIR_PRELOAD_WORKFLOW_COUNT=108000
  PAIR_POLL_RPS=300
  TOTAL_PRELOAD_WORKFLOW_COUNT=864000
  TOTAL_POLL_RPS=2400

Round 5:
  PAIR_COUNT=16
  PAIR_PRELOAD_WORKFLOW_COUNT=108000
  PAIR_POLL_RPS=300
  TOTAL_PRELOAD_WORKFLOW_COUNT=1728000
  TOTAL_POLL_RPS=4800
```

每輪至少跑：

```text
TEST_DURATION=5m
```

如果要更接近 SLA，建議 stable 的最大輪再跑：

```text
TEST_DURATION=30m
```

---

## 15. 執行方式

```bash
k6 run \
  -e BASE_URL="https://your-conductor-domain" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_PREFIX="wf_perf_tc03" \
  -e TASK_PREFIX="perf_task_tc03" \
  -e MAX_PAIR_COUNT=16 \
  -e PAIR_COUNT=4 \
  -e PAIR_PRELOAD_WORKFLOW_COUNT=108000 \
  -e PRELOAD_BATCH_SIZE=100 \
  -e PRELOAD_MAX_IN_FLIGHT_BATCHES=5 \
  -e PAIR_POLL_RPS=300 \
  -e TEST_DURATION="5m" \
  -e TC01_SINGLE_PAIR_STABLE_TASK_COMPLETED_RPS=300 \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=true \
  k6/scenarios/tc03_preloaded_independent_poll_scale.js
```

---

## 16. 成功標準

某一輪視為 stable，需要符合：

```text
errors = 0
poll_success_rate >= 99.9%
task_complete_success_rate >= 99.9%
actual_task_completed_rps / expected_total_poll_rps >= 0.90
task_update_latency p95 < SLA_TASK_UPDATE_P95_MS
poll_attempt_latency p95 < SLA_POLL_ATTEMPT_P95_MS
poll_hit_latency p95 < SLA_POLL_HIT_P95_MS
task_scheduled_to_poll_latency p95 < SLA_SCHEDULE_TO_POLL_P95_MS
scaling_efficiency >= 0.75
k6 dropped_iterations = 0
```

每一組 pair 也需要符合：

```text
pair.tasks_completed / pair.poll_attempts 不應因非預期 poll miss 明顯下降
pair.tasks_completed / pair.tasks_polled >= 0.999
pair.poll_success_rate >= 99.9%
pair.task_complete_success_rate >= 99.9%
pair.task_scheduled_to_poll_latency p95 < SLA
pair.task_update_latency p95 < SLA
```

如果總體看起來 stable，但某一個 pair 明顯落後，仍視為不穩定。

---

## 17. Cliff Point 判定

如果出現以下任一條件，該 `PAIR_COUNT` 視為超過穩定上限：

```text
scaling_efficiency < 0.75
actual_task_completed_rps / expected_total_poll_rps < 0.90
任一 pair 的 tasks_completed / tasks_polled < 0.999
任一 pair 的 poll_success_rate < 99.9%
任一 pair 的 task_complete_success_rate < 99.9%
任一 pair 的 schedule-to-poll p95 超過 SLA
poll_attempt_latency p95 超過 SLA
poll_hit_latency p95 超過 SLA
task_update_latency p95 超過 SLA
errors > 0
poll_errors > 0
complete_errors > 0
k6 dropped_iterations > 0
poll hit rate 在 backlog 足夠時仍急遽下降
poll miss 過高且 tasks_completed 跟不上 expected_total_poll_rps
```

---

## 18. 輸出 Summary 格式

`handleSummary()` 需要輸出：

```text
tc03_summary.json
tc03_raw_summary.json
```

`tc03_summary.json` 至少包含：

```json
{
  "testCase": "TC03",
  "pairCount": 4,
  "maxPairCount": 16,
  "pairPreloadWorkflowCount": 108000,
  "totalPreloadWorkflowCount": 432000,
  "pairPollRps": 300,
  "expectedTotalPollRps": 1200,
  "testDuration": "5m",
  "singlePairBaselineCompletedRps": 300,
  "overall": {
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
    "actualTaskCompletedRps": 1194.2,
    "taskCompletedToPollAttemptRatio": 0.995,
    "taskCompletedToTaskPolledRatio": 0.999,
    "pollMissRatio": 0.005,
    "scalingEfficiency": 0.995,
    "isStable": true
  },
  "perPair": [
    {
      "pairId": "001",
      "workflowName": "wf_perf_tc03_001",
      "taskType": "perf_task_tc03_001",
      "preloadedWorkflows": 108000,
      "tasksPolled": 90000,
      "tasksCompleted": 89980,
      "pollMisses": 20,
      "actualTaskCompletedRps": 299.9,
      "taskCompletedToTaskPolledRatio": 0.9997,
      "scheduleToPollP95Ms": 300,
      "taskUpdateP95Ms": 200,
      "scalingEfficiency": 0.999,
      "isStable": true
    }
  ]
}
```

---

## 19. Implementation Plan

### Phase 1: k6 腳本骨架

建立 `k6/scenarios/tc03_preloaded_independent_poll_scale.js`，並使用既有 `k6/lib` helper：

```text
1. ENV parser
2. pair model builder
3. options builder
4. custom metrics definitions
5. setup()
6. worker()
7. handleSummary()
8. summary helper
```

此階段需先處理必要 ENV 檢查：

```text
BASE_URL 必填
PAIR_COUNT <= MAX_PAIR_COUNT
PAIR_COUNT >= 1
PAIR_POLL_RPS >= 1
PAIR_PRELOAD_WORKFLOW_COUNT >= 1
```

### Phase 2: Pair Model 與 Definition Setup

建立 pair model：

```text
pairId: 001
workflowName: {WORKFLOW_PREFIX}_001
taskType: {TASK_PREFIX}_001
```

setup 階段依 `MAX_PAIR_COUNT` 建立或驗證 definitions。Validation 只需比對影響測試行為的欄位：

```text
workflow name
workflow version
workflow 單一 SIMPLE task
task name / taskReferenceName
required inputParameters
task timeout / retry policy
```

### Phase 3: Active Pair Preload

對前 `PAIR_COUNT` 組 active pairs preload workflow instances。

```text
1. 每個 pair preload PAIR_PRELOAD_WORKFLOW_COUNT 個 workflow instances
2. 使用 PRELOAD_BATCH_SIZE 切 batch
3. 使用 PRELOAD_MAX_IN_FLIGHT_BATCHES 控制 batch window
4. 任一 preload request 失敗即 fail setup
5. setup 回傳 active pair metadata 與 preload 結果
```

### Phase 4: Worker-only Runtime

根據 `PAIR_COUNT` 動態建立 worker scenarios：

```text
worker_pair_001
worker_pair_002
...
worker_pair_N
```

每個 worker scenario：

```text
executor = constant-arrival-rate
rate = PAIR_POLL_RPS
duration = TEST_DURATION
env.PAIR_ID = pairId
tags.pairId = pairId
tags.workflowName = workflowName
tags.taskType = taskType
```

### Phase 5: Metrics 與 Summary

所有正式 runtime metrics 都要加 per-pair tags。

`handleSummary()` 需要輸出：

```text
tc03_summary.json
tc03_raw_summary.json
```

`tc03_summary.json` 需要包含：

```text
overall
derived
perPair
```

### Phase 6: Smoke 與 Scaling Runs

先用低 RPS 與小 preload 數量驗證腳本流程，再執行正式 scaling rounds。

```text
Smoke:
  PAIR_COUNT=1
  PAIR_PRELOAD_WORKFLOW_COUNT=10
  PAIR_POLL_RPS=1
  TEST_DURATION=10s

Capacity:
  PAIR_COUNT=1, 2, 4, 8, 16

Cliff confirmation:
  在第一個 unstable PAIR_COUNT 附近重跑確認
```

---

## 20. TODO Checklist

- [ ] Update TC03 spec title/model to preload-only poll scaling.
- [ ] Rename target script path to `k6/scenarios/tc03_preloaded_independent_poll_scale.js`.
- [ ] Replace producer+worker runtime description with worker-only runtime.
- [ ] Define `PAIR_PRELOAD_WORKFLOW_COUNT` and total preload formula.
- [ ] Remove `PAIR_WORKFLOW_START_RPS` from main runtime variables.
- [ ] Update workflow input spec to use `preloadIndex` instead of `iterationId` for preload-created instances.
- [ ] Define per-pair naming rules and active pair selection.
- [ ] Define setup behavior for `MAX_PAIR_COUNT` definitions.
- [ ] Define preload behavior for active `PAIR_COUNT` pairs.
- [ ] Define worker scenario generation for active pairs.
- [ ] Define poll hit / miss / error handling.
- [ ] Define task complete handling.
- [ ] Define required Trend / Counter / Rate metrics with tags.
- [ ] Define scaling efficiency formula based on TC01 poll capacity baseline.
- [ ] Update recommended test rounds.
- [ ] Update execution command.
- [ ] Update success criteria.
- [ ] Update cliff point criteria.
- [ ] Update `tc03_summary.json` schema.
- [ ] Add Implementation Plan section.
- [ ] Add TODO Checklist section.
- [ ] Add Validation Criteria section.
- [ ] Move final output section to `## 22`.
- [ ] Update interpretation section for preload-only scaling.

---

## 21. Validation Criteria

### 21.1 Spec-level validation

文件本身需要符合：

```text
1. TC03 清楚描述 preloaded multi-pair poll/complete scaling。
2. 正式 runtime 不存在 producer scenario。
3. TC03 使用 TC01 poll capacity 作為 baseline，而不是 workflow start RPS。
4. ENV、metrics、summary、成功標準與 cliff 判定彼此命名一致。
5. Summary schema 包含 overall、derived、perPair。
```

### 21.2 Script-level validation

k6 腳本完成後，需要通過：

```text
1. 腳本可以被 k6 載入。
2. BASE_URL 缺失時會 fail，且錯誤訊息清楚。
3. PAIR_COUNT <= MAX_PAIR_COUNT。
4. PAIR_COUNT >= 1。
5. 動態 scenarios 只包含 active pair worker scenarios。
6. 每個 worker scenario 有正確 PAIR_ID env 與 pair tags。
7. STRICT_LATENCY_THRESHOLD=true 時啟用 latency thresholds。
8. STRICT_LATENCY_THRESHOLD=false 時只保留基礎成功率與 error thresholds。
```

### 21.3 Runtime smoke validation

使用低 RPS 進行 smoke run，例如：

```bash
k6 run \
  -e BASE_URL="https://your-conductor-domain" \
  -e API_PREFIX="/api" \
  -e PAIR_COUNT=1 \
  -e MAX_PAIR_COUNT=1 \
  -e PAIR_PRELOAD_WORKFLOW_COUNT=10 \
  -e PRELOAD_BATCH_SIZE=5 \
  -e PRELOAD_MAX_IN_FLIGHT_BATCHES=1 \
  -e PAIR_POLL_RPS=1 \
  -e TEST_DURATION="10s" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=true \
  -e STRICT_LATENCY_THRESHOLD=false \
  k6/scenarios/tc03_preloaded_independent_poll_scale.js
```

Smoke run 需符合：

```text
preloaded_workflows = PAIR_PRELOAD_WORKFLOW_COUNT
preload_errors = 0
poll_attempts > 0
tasks_polled > 0
tasks_completed > 0
complete_errors = 0
poll_errors = 0
errors = 0
tc03_summary.json 產生成功
tc03_raw_summary.json 產生成功
perPair.length = PAIR_COUNT
```

### 21.4 Capacity-run validation

正式 capacity run 每一輪需檢查：

```text
PAIR_COUNT
PAIR_PRELOAD_WORKFLOW_COUNT
TOTAL_PRELOAD_WORKFLOW_COUNT
PAIR_POLL_RPS
expected_total_poll_rps
actual_task_completed_rps
scaling_efficiency
dropped_iterations
per-pair taskCompletedToTaskPolledRatio
per-pair taskUpdateP95Ms
per-pair scheduleToPollP95Ms
```

Stable round 必須整體與每個 active pair 都通過成功標準。

Cliff round 必須可從 `tc03_summary.json` 直接判讀，不需要人工重建 metrics。

### 21.5 Output validation

`tc03_raw_summary.json` 需要包含所有必要 metrics：

```text
poll_attempt_latency
poll_hit_latency
poll_miss_latency
task_update_latency
task_scheduled_to_poll_latency
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
poll_hit_rate
poll_success_rate
task_complete_success_rate
```

`tc03_summary.json` 需要包含：

```text
testCase
pairCount
maxPairCount
pairPreloadWorkflowCount
totalPreloadWorkflowCount
pairPollRps
expectedTotalPollRps
testDuration
singlePairBaselineCompletedRps
overall
derived.actualTaskCompletedRps
derived.taskCompletedToPollAttemptRatio
derived.taskCompletedToTaskPolledRatio
derived.pollMissRatio
derived.scalingEfficiency
derived.isStable
perPair
```

---

## 22. TC03 最終產出

TC03 完成後，需要整理：

```yaml
tc03_result:
  tc01_safe_pair_poll_rps: TBD
  tc01_single_pair_stable_task_completed_rps: TBD

  max_stable_pair_count: TBD
  max_stable_total_poll_rps: TBD
  max_stable_total_task_completed_rps: TBD

  scaling_efficiency_at_1_pair: TBD
  scaling_efficiency_at_2_pairs: TBD
  scaling_efficiency_at_4_pairs: TBD
  scaling_efficiency_at_8_pairs: TBD
  scaling_efficiency_at_16_pairs: TBD

  recommended_max_pair_count: TBD
  recommended_total_safe_poll_rps: TBD
```

建議：

```text
recommended_total_safe_poll_rps =
  recommended_max_pair_count * tc01_safe_pair_poll_rps
```

如果 `max_stable_pair_count` 是離散值，例如 8 組 stable、16 組不 stable，則建議：

```text
recommended_max_pair_count = 8
```

不要再乘 0.7，因為 pair count 是離散容量。

---

## 23. 解讀方式

### Case A: 接近線性擴展

```text
PAIR_COUNT=1 stable
PAIR_COUNT=2 stable
PAIR_COUNT=4 stable
PAIR_COUNT=8 stable
scaling_efficiency >= 0.9
```

代表：

```text
不同 workflow + 不同 task type 可以有效分散 queue 壓力。
目前瓶頸可能還沒到 MariaDB queue 或 Conductor worker API 層。
```

### Case B: 2 或 4 組後開始下降

```text
PAIR_COUNT=1 stable
PAIR_COUNT=2 stable
PAIR_COUNT=4 scaling_efficiency < 0.75
PAIR_COUNT=8 failed
```

代表：

```text
雖然 task type 分散，但整體 MariaDB / Conductor evaluator / Hikari / Tomcat 已經成為 shared bottleneck。
```

### Case C: 每組都慢，但沒有單一 pair 特別慢

代表：

```text
shared resource bottleneck
可能是 Conductor pod、DB CPU、DB IO、connection pool、thread pool。
```

### Case D: 某一組 pair 特別慢

代表：

```text
可能是 task queue skew、特定 worker scenario VU 不足、k6 scenario 配置不足、或該 task type 有殘留 backlog。
```

### Case E: poll miss 明顯上升但 complete latency 正常

代表：

```text
可能是 preload 數量不足、測試時間過長、或該 pair backlog 已被 drain 完。
此情況不應直接視為系統 scaling cliff，需要先提高 PAIR_PRELOAD_WORKFLOW_COUNT 後重跑。
```

---
