# TC00 Conductor Smoke Test + Metrics Collection k6 Spec

## 1. 目標

建立一支 k6 腳本，用來驗證 Conductor 3.21.22 在單一 workflow、單一 SIMPLE task 情境下，是否能完成完整生命週期，並收集後續 SLA 測試需要的基礎 latency metrics。

本測試不是壓測，而是確認：

1. workflow 可以成功啟動。
2. task 可以被 worker poll 到。
3. task 可以被 complete。
4. workflow 最終可以進入 `COMPLETED`。
5. 可以收集 `schedule -> poll`、`workflow submit -> poll`、`workflow start latency`、`task update latency`、`workflow e2e latency` 等指標。

---

## 2. 測試情境

### 測試名稱

```text
TC00 Smoke Test with Metrics Collection
```

### workflow

```text
wf_perf_single_hot
```

### task type

```text
perf_task_hot
```

### 測試流程

每一次 iteration 執行以下流程：

```text
1. POST /workflow/{workflowName}
2. 持續 GET /tasks/poll/{taskType}，直到 poll 到 task
3. 從 poll response 中計算 schedule-to-poll latency
4. POST /tasks 將 task 標記為 COMPLETED
5. GET /workflow/{workflowId}，等待 workflow 狀態變成 COMPLETED
6. 記錄 workflow end-to-end latency
```

---

## 3. k6 檔案需求

請建立一支 k6 腳本：

```text
tc00_smoke_collect_metrics.js
```

此階段只需要單檔版，不需要拆 lib，不需要整理環境，不需要 DB snapshot。

---

## 4. 必要環境變數

k6 script 必須支援以下環境變數。

| 變數                         | 必填  | 預設值                  | 說明                                                    |
| -------------------------- | --- | -------------------- | ----------------------------------------------------- |
| `BASE_URL`                 | yes | none                 | Conductor base URL，例如 `https://conductor.example.com` |
| `API_PREFIX`               | no  | `/api`               | API prefix                                            |
| `WORKFLOW_NAME`            | no  | `wf_perf_single_hot` | 測試 workflow name                                      |
| `TASK_TYPE`                | no  | `perf_task_hot`      | 測試 task type                                          |
| `WORKFLOW_VERSION`         | no  | `1`                  | workflow version                                      |
| `VUS`                      | no  | `1`                  | k6 VUs                                                |
| `ITERATIONS`               | no  | `10`                 | 總 iteration 數                                         |
| `MAX_POLL_ATTEMPTS`        | no  | `60`                 | 單一 workflow 最多 poll 幾次                                |
| `POLL_SLEEP_MS`            | no  | `200`                | poll miss 後 sleep 毫秒數                                 |
| `WORKFLOW_WAIT_TIMEOUT_MS` | no  | `30000`              | 等待 workflow completed 的 timeout                       |
| `WORKER_ID_PREFIX`         | no  | `k6-tc00-worker`     | worker id prefix                                      |
| `TEST_RUN_ID`              | no  | 自動產生                 | 本次測試識別碼                                               |
| `STRICT_WORKFLOW_MATCH`    | no  | `true`               | poll 到的 task 是否必須屬於本 iteration 啟動的 workflow           |

---

## 5. k6 options

使用 `shared-iterations` executor。

```javascript
export const options = {
  scenarios: {
    tc00_smoke: {
      executor: 'shared-iterations',
      vus: Number(__ENV.VUS || 1),
      iterations: Number(__ENV.ITERATIONS || 10),
      maxDuration: '5m',
    },
  },
  thresholds: {
    workflow_success_rate: ['rate>=0.99'],
    errors: ['count==0'],
  },
};
```

此階段不要設定太多 latency threshold，避免環境尚未穩定時腳本直接失敗。
latency threshold 可以先收數據，後續 TC01 再正式定義。

---

## 6. 需要建立的 custom metrics

### 6.1 Trend metrics

請建立以下 `Trend` metrics，並啟用 time unit。

```javascript
new Trend('workflow_start_latency', true)
new Trend('poll_attempt_latency', true)
new Trend('poll_hit_latency', true)
new Trend('poll_miss_latency', true)
new Trend('task_update_latency', true)
new Trend('workflow_get_latency', true)
new Trend('workflow_e2e_latency', true)
new Trend('task_scheduled_to_poll_latency', true)
new Trend('workflow_submit_to_poll_latency', true)
```

### 6.2 Counter metrics

```javascript
new Counter('workflows_started')
new Counter('tasks_polled')
new Counter('tasks_completed')
new Counter('poll_misses')
new Counter('missing_task_scheduled_time')
new Counter('missing_input_created_at_ms')
new Counter('unexpected_workflow_task')
new Counter('errors')
```

### 6.3 Rate metrics

```javascript
new Rate('workflow_success_rate')
new Rate('poll_hit_rate')
```

---

## 7. 指標定義

### 7.1 `workflow_start_latency`

量測：

```text
POST /workflow/{workflowName}
```

從 request 發出到 response 完成的時間。

用途：

```text
確認啟動 workflow 的 API latency。
```

---

### 7.2 `poll_attempt_latency`

量測：

```text
GET /tasks/poll/{taskType}
```

每一次 poll request 的 latency，不論有無拿到 task。

用途：

```text
確認 worker poll API 的基本 latency。
```

---

### 7.3 `poll_hit_latency`

只在 poll response 有拿到 task 時記錄。

判斷方式：

```text
HTTP status = 200
body 不為空
body 不為 null
body 可以 parse 成 JSON
body 中存在 taskId
```

用途：

```text
確認有任務時 queue pop / poll hit 的 latency。
```

---

### 7.4 `poll_miss_latency`

只在沒有拿到 task 時記錄。

可接受的 poll miss 條件：

```text
HTTP 204
或 HTTP 200 with empty body
或 HTTP 200 with null body
```

不建議直接把 404 視為正常，除非實際環境已確認 Conductor 會用 404 表示無 task。

用途：

```text
確認沒有任務時空 poll 的 latency。
```

---

### 7.5 `task_update_latency`

量測：

```text
POST /tasks
```

將 task 回報為 `COMPLETED` 的 latency。

用途：

```text
確認 worker complete task 的 API latency。
```

---

### 7.6 `workflow_get_latency`

量測：

```text
GET /workflow/{workflowId}?includeTasks=true
```

用途：

```text
確認查詢 workflow 狀態的 API latency。
```

---

### 7.7 `workflow_e2e_latency`

計算：

```text
workflow completed timestamp - workflow submit timestamp
```

其中：

```text
workflow submit timestamp = k6 發出 POST /workflow 前的 Date.now()
workflow completed timestamp = k6 查到 workflow status = COMPLETED 時的 Date.now()
```

用途：

```text
確認單一 workflow 從啟動到完成的 end-to-end latency。
```

---

### 7.8 `task_scheduled_to_poll_latency`

優先使用 poll response 內 task 的排程時間欄位計算。

優先順序：

```text
task.scheduledTime
task.scheduledTimeMs
task.scheduledTimeInMs
```

計算：

```text
poll received timestamp - task scheduled timestamp
```

注意：

1. 若 task scheduled timestamp 是秒，要轉成毫秒。
2. 若 task scheduled timestamp 是毫秒，直接使用。
3. 若 latency 小於 0，不記錄，並計入 error 或 debug log。
4. 若沒有任何 scheduled time 欄位，增加 `missing_task_scheduled_time` counter。

用途：

```text
這是最接近真正 task schedule -> worker poll 到 task 的 latency。
```

---

### 7.9 `workflow_submit_to_poll_latency`

fallback 指標。

從 task input 中讀取：

```text
task.inputData.createdAtMs
或 task.input.createdAtMs
```

計算：

```text
poll received timestamp - workflow input createdAtMs
```

用途：

```text
當 Conductor task payload 沒有 scheduledTime 時，用來觀察 workflow submit -> task poll 的總延遲。
```

限制：

```text
這不是純 queue latency。
它包含 workflow start、task schedule、DB write、queue wait、poll 等時間。
```

如果找不到 `createdAtMs`，增加：

```text
missing_input_created_at_ms
```

---

## 8. workflow input 規格

每次 start workflow 時，body 必須帶入以下 input：

```json
{
  "testRunId": "tc00-xxxxx",
  "iterationId": "tc00-xxxxx-vu1-iter1",
  "createdAtMs": 1710000000000,
  "payload": {
    "source": "k6-tc00",
    "vu": 1,
    "iteration": 1
  }
}
```

### 欄位說明

| 欄位            | 說明                        |
| ------------- | ------------------------- |
| `testRunId`   | 本次測試識別碼                   |
| `iterationId` | 單次 iteration 識別碼          |
| `createdAtMs` | workflow submit timestamp |
| `payload`     | 測試用 payload，不需要很大         |

---

## 9. workflow definition 要求

workflow 的 SIMPLE task input 必須把 `createdAtMs` 傳進 task。

範例需求：

```json
{
  "name": "perf_task_hot",
  "taskReferenceName": "perf_task_hot_ref",
  "type": "SIMPLE",
  "inputParameters": {
    "testRunId": "${workflow.input.testRunId}",
    "iterationId": "${workflow.input.iterationId}",
    "createdAtMs": "${workflow.input.createdAtMs}",
    "payload": "${workflow.input.payload}"
  }
}
```

AI agent 不需要建立 workflow definition，只需要在 README 或 script comment 中註明此需求。

---

## 10. API 呼叫規格

### 10.1 Start workflow

```text
method: POST
path: {BASE_URL}{API_PREFIX}/workflow/{WORKFLOW_NAME}?version={WORKFLOW_VERSION}&correlationId={iterationId}
content-type: application/json
body: workflow input
```

成功條件：

```text
HTTP 200 或 HTTP 202
response body 可以解析出 workflowId
```

workflowId 解析優先順序：

```text
1. response JSON 是 string
2. response JSON.workflowId
3. response JSON.workflowInstanceId
4. response JSON.id
5. response body raw string 去除雙引號
```

失敗處理：

```text
errors + 1
fail iteration
```

---

### 10.2 Poll task

```text
method: GET
path: {BASE_URL}{API_PREFIX}/tasks/poll/{TASK_TYPE}?workerid={workerId}
```

poll hit 判斷：

```text
HTTP 200
body 不為空
body 不為 null
body 可以 parse 成 JSON
taskId 存在
```

poll miss 判斷：

```text
HTTP 204
或 HTTP 200 + empty body
或 HTTP 200 + null body
```

每次 poll miss 後：

```text
sleep(POLL_SLEEP_MS)
```

最多 poll：

```text
MAX_POLL_ATTEMPTS
```

超過後：

```text
errors + 1
fail iteration
```

---

### 10.3 Workflow match check

如果：

```text
STRICT_WORKFLOW_MATCH=true
```

則 poll 到 task 後要檢查：

```text
task.workflowInstanceId == current workflowId
```

若不相等：

```text
unexpected_workflow_task + 1
errors + 1
fail iteration
```

目的：

```text
避免同一環境中 poll 到其他測試或其他團隊的 task，導致 metrics 污染。
```

---

### 10.4 Complete task

```text
method: POST
path: {BASE_URL}{API_PREFIX}/tasks
content-type: application/json
```

body：

```json
{
  "workflowInstanceId": "{task.workflowInstanceId}",
  "taskId": "{task.taskId}",
  "status": "COMPLETED",
  "workerId": "{workerId}",
  "outputData": {
    "completedAtMs": 1710000000000,
    "testRunId": "{testRunId}",
    "iterationId": "{iterationId}"
  }
}
```

成功條件：

```text
HTTP 200 或 HTTP 204
```

失敗處理：

```text
errors + 1
fail iteration
```

---

### 10.5 Wait workflow completed

```text
method: GET
path: {BASE_URL}{API_PREFIX}/workflow/{workflowId}?includeTasks=true
```

每 200ms 查一次，直到：

```text
status = COMPLETED
```

或遇到 terminal failed status：

```text
FAILED
TIMED_OUT
TERMINATED
```

或超過：

```text
WORKFLOW_WAIT_TIMEOUT_MS
```

成功：

```text
workflow_success_rate add true
record workflow_e2e_latency
```

失敗：

```text
workflow_success_rate add false
errors + 1
fail iteration
```

---

## 11. 單次 iteration 成功條件

單次 iteration 必須完成：

```text
1. workflow started
2. task polled
3. task completed
4. workflow completed
```

缺任一項則該 iteration 視為失敗。

---

## 12. 測試總體成功條件

當使用預設：

```text
VUS=1
ITERATIONS=10
```

成功條件：

```text
workflows_started = 10
tasks_polled = 10
tasks_completed = 10
workflow_success_rate = 1.0
errors = 0
unexpected_workflow_task = 0
```

允許：

```text
poll_misses > 0
missing_task_scheduled_time > 0
```

但如果：

```text
missing_task_scheduled_time > 0
```

則 report 需要明確說明：

```text
task_scheduled_to_poll_latency 無法收集，請改用 workflow_submit_to_poll_latency 作為 fallback。
```

如果：

```text
missing_input_created_at_ms > 0
```

則 report 需要明確說明：

```text
workflow definition 沒有把 createdAtMs 傳到 task input。
```

---

## 13. handleSummary 輸出需求

script 必須實作 `handleSummary(data)`。

輸出三份：

```text
stdout
tc00_summary.json
tc00_raw_summary.json
```

### 13.1 stdout

stdout 輸出精簡 JSON，包含：

```json
{
  "testRunId": "tc00-xxx",
  "workflowName": "wf_perf_single_hot",
  "taskType": "perf_task_hot",
  "vus": 1,
  "iterations": 10,
  "metrics": {
    "workflow_start_latency": {},
    "poll_attempt_latency": {},
    "poll_hit_latency": {},
    "poll_miss_latency": {},
    "task_update_latency": {},
    "workflow_get_latency": {},
    "workflow_e2e_latency": {},
    "task_scheduled_to_poll_latency": {},
    "workflow_submit_to_poll_latency": {},
    "workflows_started": {},
    "tasks_polled": {},
    "tasks_completed": {},
    "poll_misses": {},
    "workflow_success_rate": {},
    "poll_hit_rate": {},
    "missing_task_scheduled_time": {},
    "missing_input_created_at_ms": {},
    "unexpected_workflow_task": {},
    "errors": {}
  }
}
```

### 13.2 tc00_summary.json

輸出與 stdout 相同內容。

### 13.3 tc00_raw_summary.json

輸出完整 k6 summary data，方便後續 debug。

---

## 14. 執行指令範例

```bash
k6 run \
  -e BASE_URL="https://your-conductor-domain" \
  -e API_PREFIX="/api" \
  -e WORKFLOW_NAME="wf_perf_single_hot" \
  -e TASK_TYPE="perf_task_hot" \
  -e VUS=1 \
  -e ITERATIONS=10 \
  tc00_smoke_collect_metrics.js
```

---

## 15. 預期輸出重點

測試完成後，AI agent 需要確認以下 metrics 有值：

```text
workflow_start_latency
poll_attempt_latency
poll_hit_latency
task_update_latency
workflow_get_latency
workflow_e2e_latency
workflow_submit_to_poll_latency
```

若 Conductor poll response 有 scheduled time，則也應該有：

```text
task_scheduled_to_poll_latency
```

---

## 16. 判讀規則

### Case 1：完全正常

```text
errors = 0
workflow_success_rate = 1
workflows_started = ITERATIONS
tasks_polled = ITERATIONS
tasks_completed = ITERATIONS
task_scheduled_to_poll_latency 有值
workflow_submit_to_poll_latency 有值
```

代表：

```text
TC00 通過，可以進入 TC01 closed-loop throughput test。
```

---

### Case 2：沒有 `task_scheduled_to_poll_latency`

```text
missing_task_scheduled_time > 0
workflow_submit_to_poll_latency 有值
```

代表：

```text
Conductor poll response 沒有 scheduledTime 欄位，或欄位名稱不同。
目前先使用 workflow_submit_to_poll_latency 作為 fallback。
後續若要精準 queue latency，需要確認 Conductor task payload 欄位。
```

---

### Case 3：沒有 `workflow_submit_to_poll_latency`

```text
missing_input_created_at_ms > 0
```

代表：

```text
workflow definition 沒有把 workflow.input.createdAtMs 傳入 SIMPLE task input。
需要修改 workflow definition。
```

---

### Case 4：poll 到別人的 task

```text
unexpected_workflow_task > 0
```

代表：

```text
測試環境不乾淨，或同一 task type 被其他 worker / workflow 共用。
TC00 結果不可用。
需要使用獨立 task type，或停止其他 worker。
```

---

### Case 5：workflow 沒有完成

```text
workflow_success_rate < 1
errors > 0
```

代表可能有以下問題：

```text
1. task complete payload 格式錯誤
2. workflow definition 有問題
3. task type 不存在
4. worker poll 到錯誤 task
5. Conductor API prefix 錯誤
6. workflow terminal state 查詢邏輯錯誤
```

---

## 17. 此階段不需要實作的項目

TC00 階段不要實作以下內容：

```text
1. DB snapshot
2. MariaDB lock metric collection
3. Prometheus metric collection
4. Pod CPU / memory collection
5. 多 task type 測試
6. retry storm
7. worker crash recovery
8. ramping arrival rate
9. constant arrival rate
10. 壓測報表
```

這一階段只需要確認：

```text
完整 workflow lifecycle 可以跑通
核心 latency metrics 可以被 k6 收集
```

---

## 18. 最終交付標準

AI agent 最終只需要交付：

```text
tc00_smoke_collect_metrics.js
```

此檔案必須可以透過以下指令直接執行：

```bash
k6 run \
  -e BASE_URL="http://localhost:8080" \
  tc00_smoke_collect_metrics.js
```

並且在執行後產生：

```text
tc00_summary.json
tc00_raw_summary.json
```

測試通過時，stdout 需可看出：

```text
errors = 0
workflow_success_rate = 1
workflows_started = ITERATIONS
tasks_polled = ITERATIONS
tasks_completed = ITERATIONS
```
