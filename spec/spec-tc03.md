# spec-tc03.md

# TC03 - Independent Workflow / Task Pair Horizontal Scaling Test

## 1. 目的

測試在 TC01 測出的單一 workflow/task pair 安全 RPS 下，透過增加多組獨立 workflow + 獨立 SIMPLE task，系統總吞吐是否可以水平擴展。

本測試要回答：

```text
如果單一 workflow + 單一 task type 的 safe zone 是 X RPS，
那我建立 N 組彼此獨立的 workflow/task pair，
每一組都跑 X RPS，
整個 Conductor + MariaDB Queue 可以穩定擴展到幾組？
```

此測試可以檢查：

```text
1 組 workflow/task pair 是否穩定
2 組是否接近 2 倍
4 組是否接近 4 倍
8 組是否還能維持
何時開始出現 DB queue、row lock、API latency、poll latency 或 task update latency cliff
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

每個 task type 都有對應 worker，以固定 RPS poll task，poll 到後立即 complete。

---

## 3. 名詞定義

```yaml
PAIR_COUNT:
  說明: 本次測試啟用幾組 workflow/task pair
  範例: 1, 2, 4, 8, 16

PAIR_WORKFLOW_START_RPS:
  說明: 每一組 workflow 的啟動 RPS
  來源: TC01 測出的 recommended_safe_workflow_start_rps

PAIR_POLL_RPS:
  說明: 每一組 task worker 的 poll RPS
  建議: PAIR_WORKFLOW_START_RPS * 1.5

TOTAL_WORKFLOW_START_RPS:
  公式: PAIR_COUNT * PAIR_WORKFLOW_START_RPS

TOTAL_POLL_RPS:
  公式: PAIR_COUNT * PAIR_POLL_RPS
```

例如 TC01 結果：

```yaml
recommended_safe_workflow_start_rps: 200
recommended_poll_rps: 300
```

TC03 測試：

```yaml
PAIR_COUNT: 4
PAIR_WORKFLOW_START_RPS: 200
PAIR_POLL_RPS: 300

TOTAL_WORKFLOW_START_RPS: 800
TOTAL_POLL_RPS: 1200
```

---

## 4. k6 腳本目標

AI agent 需要建立：

```text
k6/scenarios/tc03_independent_workflow_task_scale.js
```

此腳本需要做到：

1. 啟動前依照 `MAX_PAIR_COUNT` 預先建立 task definitions。
2. 啟動前依照 `MAX_PAIR_COUNT` 預先建立 workflow definitions。
3. 每個 workflow 對應唯一 task type。
4. 根據 `PAIR_COUNT` 啟用前 N 組 workflow/task pair。
5. 每組 workflow 以固定 `PAIR_WORKFLOW_START_RPS` 啟動。
6. 每組 task worker 以固定 `PAIR_POLL_RPS` poll。
7. worker poll hit 後立即 complete。
8. 每組獨立收集 metrics，並加上 tag：

   * `pairId`
   * `workflowName`
   * `taskType`
9. 輸出整體 summary 與 per-pair summary。
10. 計算 scaling efficiency。

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

PAIR_WORKFLOW_START_RPS=200
PAIR_POLL_RPS=300

TEST_DURATION="5m"

SLA_API_P95_MS=500
SLA_SCHEDULE_TO_POLL_P95_MS=1000
MAX_ERROR_RATE=0.001
```

---

## 6. Workflow / Task 命名規則

第 1 組：

```text
workflowName = wf_perf_tc03_001
taskType = perf_task_tc03_001
```

第 2 組：

```text
workflowName = wf_perf_tc03_002
taskType = perf_task_tc03_002
```

第 N 組：

```text
workflowName = wf_perf_tc03_NNN
taskType = perf_task_tc03_NNN
```

其中 `NNN` 是三位數補零。

---

## 7. Task Definition Spec

每一組 task definition 格式相同，只替換 `name`。

```json
{
  "name": "perf_task_tc03_001",
  "description": "TC03 independent simple task 001",
  "retryCount": 0,
  "retryLogic": "FIXED",
  "retryDelaySeconds": 0,
  "timeoutSeconds": 60,
  "responseTimeoutSeconds": 30,
  "pollTimeoutSeconds": 60,
  "timeoutPolicy": "TIME_OUT_WF",
  "ownerEmail": "perf-test@example.com",
  "inputKeys": [],
  "outputKeys": [],
  "inputTemplate": {}
}
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
  "description": "TC03 independent workflow 001",
  "version": 1,
  "schemaVersion": 2,
  "ownerEmail": "perf-test@example.com",
  "inputParameters": [
    "testRunId",
    "pairId",
    "iterationId",
    "createdAtMs",
    "payload"
  ],
  "outputParameters": {
    "testRunId": "${workflow.input.testRunId}",
    "pairId": "${workflow.input.pairId}",
    "iterationId": "${workflow.input.iterationId}"
  },
  "tasks": [
    {
      "name": "perf_task_tc03_001",
      "taskReferenceName": "perf_task_tc03_001_ref",
      "type": "SIMPLE",
      "inputParameters": {
        "testRunId": "${workflow.input.testRunId}",
        "pairId": "${workflow.input.pairId}",
        "iterationId": "${workflow.input.iterationId}",
        "createdAtMs": "${workflow.input.createdAtMs}",
        "payload": "${workflow.input.payload}"
      }
    }
  ]
}
```

---

## 9. setup() 行為

k6 `setup()` 需要：

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
  - iterationId
  - createdAtMs
```

如果不符合且：

```bash
FAIL_ON_DEFINITION_MISMATCH=true
```

則直接 fail。

---

## 10. Scenario 設計

TC03 需要根據 `PAIR_COUNT` 動態建立 scenarios。

每一組 pair 需要兩個 scenario：

```text
producer_pair_001
worker_pair_001

producer_pair_002
worker_pair_002

...
producer_pair_N
worker_pair_N
```

### 10.1 Producer Scenario

每個 producer 使用：

```javascript
executor: 'constant-arrival-rate'
rate: PAIR_WORKFLOW_START_RPS
timeUnit: '1s'
duration: TEST_DURATION
exec: 'producer'
env:
  PAIR_ID: "001"
```

Producer 每次 iteration 做：

```text
1. 根據 PAIR_ID 取得 workflowName
2. createdAtMs = Date.now()
3. POST /workflow/{workflowName}?version=1&correlationId={iterationId}
4. body:
   {
     testRunId,
     pairId,
     iterationId,
     createdAtMs,
     payload
   }
5. 記錄 workflow_start_latency，tag pairId
6. workflows_started + 1，tag pairId
```

### 10.2 Worker Scenario

每個 worker 使用：

```javascript
executor: 'constant-arrival-rate'
rate: PAIR_POLL_RPS
timeUnit: '1s'
duration: TEST_DURATION
exec: 'worker'
env:
  PAIR_ID: "001"
```

Worker 每次 iteration 做：

```text
1. 根據 PAIR_ID 取得 taskType
2. GET /tasks/poll/{taskType}?workerid={workerId}
3. 如果 poll miss:
   - 記錄 poll_miss_latency，tag pairId
   - poll_misses + 1，tag pairId
   - 結束 iteration
4. 如果 poll hit:
   - 記錄 poll_hit_latency，tag pairId
   - tasks_polled + 1，tag pairId
   - 計算 task_scheduled_to_poll_latency，tag pairId
   - 計算 workflow_submit_to_poll_latency，tag pairId
   - POST /tasks complete
   - 記錄 task_update_latency，tag pairId
   - tasks_completed + 1，tag pairId
```

---

## 11. 必要 Metrics

### 11.1 Trend

```javascript
workflow_start_latency
poll_attempt_latency
poll_hit_latency
poll_miss_latency
task_update_latency
task_scheduled_to_poll_latency
workflow_submit_to_poll_latency
workflow_submit_to_task_complete_latency
```

所有 metrics 必須加 tag：

```javascript
{
  pairId: "001",
  workflowName: "wf_perf_tc03_001",
  taskType: "perf_task_tc03_001"
}
```

### 11.2 Counter

```javascript
workflows_started
tasks_polled
tasks_completed
poll_misses
workflow_start_errors
poll_errors
complete_errors
missing_task_scheduled_time
missing_input_created_at_ms
errors
```

同樣需要加 tag。

### 11.3 Rate

```javascript
workflow_start_success_rate
task_complete_success_rate
poll_hit_rate
```

---

## 12. Scaling Efficiency 計算

TC03 需要在 summary 裡計算：

```text
expected_total_workflow_rps = PAIR_COUNT * PAIR_WORKFLOW_START_RPS
expected_total_poll_rps = PAIR_COUNT * PAIR_POLL_RPS
```

實際完成量：

```text
actual_task_completed_rps = tasks_completed / TEST_DURATION_SECONDS
actual_workflow_started_rps = workflows_started / TEST_DURATION_SECONDS
```

Scaling efficiency：

```text
scaling_efficiency =
  actual_task_completed_rps /
  (PAIR_COUNT * TC01_SINGLE_PAIR_STABLE_TASK_COMPLETED_RPS)
```

如果沒有提供 `TC01_SINGLE_PAIR_STABLE_TASK_COMPLETED_RPS`，則用：

```text
PAIR_WORKFLOW_START_RPS
```

作為分母基準。

```text
scaling_efficiency =
  actual_task_completed_rps /
  (PAIR_COUNT * PAIR_WORKFLOW_START_RPS)
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
recommended_safe_workflow_start_rps: 200
recommended_poll_rps: 300
```

TC03 應跑：

```text
Round 1:
  PAIR_COUNT=1
  PAIR_WORKFLOW_START_RPS=200
  PAIR_POLL_RPS=300
  TOTAL_WORKFLOW_START_RPS=200
  TOTAL_POLL_RPS=300

Round 2:
  PAIR_COUNT=2
  PAIR_WORKFLOW_START_RPS=200
  PAIR_POLL_RPS=300
  TOTAL_WORKFLOW_START_RPS=400
  TOTAL_POLL_RPS=600

Round 3:
  PAIR_COUNT=4
  PAIR_WORKFLOW_START_RPS=200
  PAIR_POLL_RPS=300
  TOTAL_WORKFLOW_START_RPS=800
  TOTAL_POLL_RPS=1200

Round 4:
  PAIR_COUNT=8
  PAIR_WORKFLOW_START_RPS=200
  PAIR_POLL_RPS=300
  TOTAL_WORKFLOW_START_RPS=1600
  TOTAL_POLL_RPS=2400

Round 5:
  PAIR_COUNT=16
  PAIR_WORKFLOW_START_RPS=200
  PAIR_POLL_RPS=300
  TOTAL_WORKFLOW_START_RPS=3200
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
  -e PAIR_WORKFLOW_START_RPS=200 \
  -e PAIR_POLL_RPS=300 \
  -e TEST_DURATION="5m" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=true \
  k6/scenarios/tc03_independent_workflow_task_scale.js
```

---

## 16. 成功標準

某一輪視為 stable，需要符合：

```text
errors = 0
workflow_start_success_rate >= 99.9%
task_complete_success_rate >= 99.9%
actual_task_completed_rps / expected_total_workflow_rps >= 0.99
workflow_start_latency p95 < SLA_API_P95_MS
task_update_latency p95 < SLA_API_P95_MS
task_scheduled_to_poll_latency p95 < SLA_SCHEDULE_TO_POLL_P95_MS
scaling_efficiency >= 0.75
k6 dropped_iterations = 0
```

每一組 pair 也需要符合：

```text
pair.tasks_completed / pair.workflows_started >= 0.99
pair.task_scheduled_to_poll_latency p95 < SLA
pair.task_update_latency p95 < SLA
```

如果總體看起來 stable，但某一個 pair 明顯落後，仍視為不穩定。

---

## 17. Cliff Point 判定

如果出現以下任一條件，該 `PAIR_COUNT` 視為超過穩定上限：

```text
scaling_efficiency < 0.75
actual_task_completed_rps / expected_total_workflow_rps < 0.99
任一 pair 的 tasks_completed / workflows_started < 0.99
任一 pair 的 schedule-to-poll p95 超過 SLA
workflow_start_latency p95 超過 SLA
task_update_latency p95 超過 SLA
errors > 0
k6 dropped_iterations > 0
poll hit rate 急遽下降
poll miss 過高且 tasks_completed 跟不上 workflows_started
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
  "pairWorkflowStartRps": 200,
  "pairPollRps": 300,
  "expectedTotalWorkflowStartRps": 800,
  "expectedTotalPollRps": 1200,
  "testDuration": "5m",
  "overall": {
    "workflowsStarted": {},
    "tasksPolled": {},
    "tasksCompleted": {},
    "pollMisses": {},
    "workflowStartLatency": {},
    "taskUpdateLatency": {},
    "taskScheduledToPollLatency": {},
    "workflowSubmitToPollLatency": {},
    "workflowSubmitToTaskCompleteLatency": {},
    "errors": {}
  },
  "derived": {
    "actualWorkflowStartedRps": 798.5,
    "actualTaskCompletedRps": 796.2,
    "taskCompletedToWorkflowStartedRatio": 0.997,
    "scalingEfficiency": 0.995,
    "isStable": true
  },
  "perPair": [
    {
      "pairId": "001",
      "workflowName": "wf_perf_tc03_001",
      "taskType": "perf_task_tc03_001",
      "workflowsStarted": 60000,
      "tasksCompleted": 59980,
      "taskCompletedToWorkflowStartedRatio": 0.9996,
      "scheduleToPollP95Ms": 300,
      "taskUpdateP95Ms": 200,
      "isStable": true
    }
  ]
}
```

---

## 19. TC03 最終產出

TC03 完成後，需要整理：

```yaml
tc03_result:
  tc01_safe_pair_workflow_start_rps: TBD
  tc01_safe_pair_poll_rps: TBD

  max_stable_pair_count: TBD
  max_stable_total_workflow_start_rps: TBD
  max_stable_total_task_completed_rps: TBD

  scaling_efficiency_at_1_pair: TBD
  scaling_efficiency_at_2_pairs: TBD
  scaling_efficiency_at_4_pairs: TBD
  scaling_efficiency_at_8_pairs: TBD
  scaling_efficiency_at_16_pairs: TBD

  recommended_max_pair_count: TBD
  recommended_total_safe_workflow_start_rps: TBD
```

建議：

```text
recommended_max_pair_count = max_stable_pair_count * 0.7
```

如果 `max_stable_pair_count` 是離散值，例如 8 組 stable、16 組不 stable，則建議：

```text
recommended_max_pair_count = 8
```

不要再乘 0.7，因為 pair count 是離散容量。

---

## 20. 解讀方式

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
目前瓶頸可能還沒到 MariaDB queue。
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
可能是 task queue skew、特定 worker 不足、k6 scenario 配置不足、或該 task type 有殘留 backlog。
```

---

## 21. 對內 SLA 轉換

TC03 結果應轉成以下內部規範：

```yaml
conductor_platform_capacity:
  single_pair_safe_workflow_rps: TBD
  single_pair_safe_poll_rps: TBD
  max_independent_workflow_task_pairs: TBD
  max_total_workflow_start_rps: TBD
  max_total_task_completed_rps: TBD

usage_rules:
  - 高流量 workflow 應使用獨立 task type
  - 不建議多個高流量 workflow 共用同一個 task type
  - 每個 task type 的 worker poll RPS 應限制
  - 每個團隊應申請 workflow/task pair quota
  - 超過 quota 需重新壓測或獨立 cluster
```
