# spec-tc02.md

# TC02 - Poll Miss Storm Test

## 1. 目的

測試在沒有 task 可拉取的情況下，大量 worker 以固定 RPS poll Conductor 時，系統可以承受多少 poll miss 壓力。

此測試用來建立內部 worker 規範：

```text
worker 不可以 tight loop poll
poll miss 後需要 sleep / backoff / jitter
每個 task type 應有 poll RPS 上限
```

TC02 主要測的是：

```text
GET /tasks/poll/{taskType}
```

在沒有 task 的情況下，對 Conductor API 與 MariaDB Queue 造成的壓力。

---

## 2. 測試對象

### Task

```text
task name: perf_task_tc02_poll_miss
type: SIMPLE
```

### Workflow

TC02 不需要啟動 workflow。

但是為了讓 task type 合法，k6 `setup()` 仍需確認 task definition 存在。Workflow definition 可不建立。

---

## 3. k6 腳本目標

AI agent 需要建立：

```text
k6/scenarios/tc02_poll_miss_storm.js
```

此腳本需要做到：

1. 啟動前檢查 task definition。
2. task definition 不存在時自動建立。
3. 不啟動任何 workflow。
4. 對指定 task type 以固定 RPS poll。
5. 所有 poll 預期為 miss。
6. 收集 poll miss latency。
7. 收集非預期 poll hit。
8. 收集 HTTP error。
9. 輸出 summary JSON。

---

## 4. 必要環境變數

```bash
BASE_URL="https://your-conductor-domain"
API_PREFIX="/api"

TASK_TYPE="perf_task_tc02_poll_miss"
OWNER_EMAIL="perf-test@example.com"

AUTO_CREATE_DEFINITIONS=true
FAIL_ON_DEFINITION_MISMATCH=true

POLL_RPS=500
TEST_DURATION="5m"

SLA_POLL_MISS_P95_MS=500
MAX_ERROR_RATE=0.001
```

---

## 5. Task Definition Spec

```json
{
  "name": "perf_task_tc02_poll_miss",
  "description": "TC02 poll miss storm test task",
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

## 6. Scenario 設計

使用 k6 `constant-arrival-rate` 產生固定 poll RPS。

```javascript
poll_miss_worker: {
  executor: 'constant-arrival-rate',
  rate: POLL_RPS,
  timeUnit: '1s',
  duration: TEST_DURATION,
  preAllocatedVUs: WORKER_PRE_ALLOCATED_VUS,
  maxVUs: WORKER_MAX_VUS,
  exec: 'pollMissWorker',
}
```

每次 iteration 做：

```text
1. GET /tasks/poll/{TASK_TYPE}?workerid={workerId}
2. 如果 status = 204，視為 poll miss
3. 如果 status = 200 但 body empty / null，視為 poll miss
4. 如果 status = 200 且 body 有 taskId，視為 unexpected poll hit
5. 如果 status 非 200 / 204 / 404，視為 error
6. 記錄 latency 與 counters
```

---

## 7. Poll Miss 判斷規則

k6 function 需要支援以下情況。

### Case 1: HTTP 204

```text
status = 204
body empty
result = poll miss
```

### Case 2: HTTP 200 + empty body

```text
status = 200
body = ""
result = poll miss
```

### Case 3: HTTP 200 + null

```text
status = 200
body = "null"
result = poll miss
```

### Case 4: HTTP 200 + valid task

```text
status = 200
body contains taskId
result = unexpected poll hit
```

TC02 預期不應該 poll 到 task。如果發生 poll hit，代表：

```text
測試前環境不乾淨
或有其他 workflow 正在產生相同 task type
或先前測試殘留 task
```

此時應記錄：

```javascript
unexpected_poll_hits.add(1)
errors.add(1)
```

---

## 8. 必要 Metrics

### 8.1 Trend

```javascript
poll_attempt_latency
poll_miss_latency
unexpected_poll_hit_latency
```

### 8.2 Counter

```javascript
poll_attempts
poll_misses
unexpected_poll_hits
poll_errors
errors
```

### 8.3 Rate

```javascript
poll_miss_rate
poll_success_rate
unexpected_poll_hit_rate
```

---

## 9. Threshold 建議

TC02 初始可以只檢查功能：

```javascript
thresholds: {
  errors: ['count==0'],
  unexpected_poll_hits: ['count==0'],
}
```

正式測 poll miss 上限時，加入 latency threshold：

```javascript
thresholds: {
  errors: ['count==0'],
  unexpected_poll_hits: ['count==0'],
  poll_miss_rate: ['rate>=0.999'],
  poll_miss_latency: [`p(95)<${SLA_POLL_MISS_P95_MS}`],
}
```

---

## 10. 執行方式

```bash
k6 run \
  -e BASE_URL="https://your-conductor-domain" \
  -e API_PREFIX="/api" \
  -e TASK_TYPE="perf_task_tc02_poll_miss" \
  -e POLL_RPS=500 \
  -e TEST_DURATION="5m" \
  -e AUTO_CREATE_DEFINITIONS=true \
  -e FAIL_ON_DEFINITION_MISMATCH=true \
  k6/scenarios/tc02_poll_miss_storm.js
```

---

## 11. 建議測試階段

手動跑多輪，每輪增加 `POLL_RPS`。

```text
Round 1:
  POLL_RPS=100
  TEST_DURATION=5m

Round 2:
  POLL_RPS=300
  TEST_DURATION=5m

Round 3:
  POLL_RPS=500
  TEST_DURATION=5m

Round 4:
  POLL_RPS=800
  TEST_DURATION=5m

Round 5:
  POLL_RPS=1000
  TEST_DURATION=5m

Round 6:
  POLL_RPS=1500
  TEST_DURATION=5m

Round 7:
  POLL_RPS=2000
  TEST_DURATION=5m
```

---

## 12. 成功標準

某一輪視為 stable，需要符合：

```text
errors = 0
unexpected_poll_hits = 0
poll_miss_rate >= 99.9%
poll_miss_latency p95 < SLA_POLL_MISS_P95_MS
k6 dropped_iterations = 0
```

如果有觀察 DB / Pod 指標，額外建議判斷：

```text
Conductor CPU 沒有打滿
Hikari pending threads 接近 0
MariaDB Threads_running 沒有持續上升
MariaDB lock wait 沒有明顯增加
```

---

## 13. Cliff Point 判定

如果出現以下任一條件，該 `POLL_RPS` 視為超過穩定上限：

```text
poll_miss_latency p95 超過 SLA
poll_miss_latency p99 明顯跳升
errors > 0
unexpected_poll_hits > 0
k6 dropped_iterations > 0
poll_success_rate 下降
Conductor CPU 滿載
DB connection pool pending
```

---

## 14. 輸出 Summary 格式

`handleSummary()` 需要輸出：

```text
tc02_summary.json
tc02_raw_summary.json
```

`tc02_summary.json` 至少包含：

```json
{
  "testCase": "TC02",
  "taskType": "perf_task_tc02_poll_miss",
  "pollRps": 500,
  "testDuration": "5m",
  "metrics": {
    "pollAttempts": {},
    "pollMisses": {},
    "unexpectedPollHits": {},
    "pollErrors": {},
    "pollAttemptLatency": {},
    "pollMissLatency": {},
    "pollMissRate": {},
    "errors": {}
  },
  "derived": {
    "isStable": true
  }
}
```

---

## 15. TC02 最終產出

TC02 完成後，需要整理出：

```yaml
tc02_result:
  max_stable_poll_miss_rps_per_task_type: TBD
  recommended_safe_poll_miss_rps_per_task_type: TBD
  poll_miss_p95_ms: TBD
  poll_miss_p99_ms: TBD
```

建議 safe zone：

```text
recommended_safe_poll_miss_rps_per_task_type =
  max_stable_poll_miss_rps_per_task_type * 0.7
```

---

## 16. 對內規範輸出

TC02 結果應轉成 worker 寫法規範：

```yaml
worker_poll_rules:
  no_tight_loop_poll: true
  poll_miss_should_sleep: true
  poll_miss_should_add_jitter: true
  max_poll_miss_rps_per_task_type: TBD
  max_poll_miss_rps_per_service: TBD
```

建議文件中明確寫：

```text
如果 worker poll miss 後立即再次 poll，會產生無效 DB 查詢壓力。
所有 worker 必須在 poll miss 後 sleep，並建議加入 jitter，避免大量 worker 同步打 poll。
```
