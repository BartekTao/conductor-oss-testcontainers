# spec-tc05.md

# TC05 - Sequential Workflow Performance Test

## 1. 目的

測試一個 workflow 內包含多個連續 SIMPLE tasks 時，Conductor 的 workflow evaluator、task scheduling、task update、MariaDB persistence 與 MariaDB queue 是否能穩定處理。

TC01 只測：

    1 workflow -> 1 task

TC05 測：

    1 workflow -> task_01 -> task_02 -> ... -> task_10 -> completed

此測試用來回答：

1. 多 step workflow 的 workflow/s 是否明顯低於 single-task workflow。
2. 每完成一個 task 後，下一個 task 被 schedule 並被 worker poll 到的延遲是多少。
3. task chaining 是否造成 workflow evaluator 或 DB update 壓力。
4. 對內 SLA 是否應同時限制 workflow/s 與 task/s。

---

## 2. 測試模型

建立一個 workflow：

    workflow name: wf_perf_tc05_seq_10
    version: 1

workflow 內含 10 個 sequential SIMPLE tasks：

    step_01: perf_task_tc05_seq
    step_02: perf_task_tc05_seq
    step_03: perf_task_tc05_seq
    ...
    step_10: perf_task_tc05_seq

所有 step 使用相同 task type：

    perf_task_tc05_seq

此設計刻意製造同 task type queue 壓力，目的是觀察 sequential workflow 在同一個 queue 下的穩定性。

---

## 3. k6 腳本目標

AI agent 需要建立：

    k6/scenarios/tc05_sequential_workflow.js

此腳本需要：

1. setup() 檢查並建立 task definition。
2. setup() 檢查並建立 workflow definition。
3. Producer 固定 RPS 啟動 workflow。
4. Worker 固定 RPS poll task。
5. Worker poll 到 task 後立即 complete。
6. 每個 workflow 會依序完成 10 個 tasks。
7. 收集 step transition latency。
8. 收集 workflow-submit-to-task-complete latency。
9. 收集 schedule-to-poll latency。
10. 收集 task update latency。
11. 收集 per-step 指標。
12. handleSummary() 輸出整體與 per-step summary。

---

## 4. 必要環境變數

    BASE_URL="https://your-conductor-domain"
    API_PREFIX="/api"

    WORKFLOW_NAME="wf_perf_tc05_seq_10"
    TASK_TYPE="perf_task_tc05_seq"
    WORKFLOW_VERSION=1
    OWNER_EMAIL="perf-test@example.com"

    AUTO_CREATE_DEFINITIONS=true
    FAIL_ON_DEFINITION_MISMATCH=true

    WORKFLOW_START_RPS=20
    POLL_RPS=300
    STEP_COUNT=10

    TEST_DURATION="5m"

    PRODUCER_PRE_ALLOCATED_VUS=20
    PRODUCER_MAX_VUS=200
    WORKER_PRE_ALLOCATED_VUS=50
    WORKER_MAX_VUS=500

    SLA_API_P95_MS=500
    SLA_SCHEDULE_TO_POLL_P95_MS=1000
    SLA_STEP_TRANSITION_P95_MS=1000
    MAX_ERROR_RATE=0.001

    STRICT_LATENCY_THRESHOLD=false

---

## 5. Task Definition Spec

    {
      "name": "perf_task_tc05_seq",
      "description": "TC05 sequential workflow simple task",
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

---

## 6. Workflow Definition Spec

需要建立 10 個 sequential tasks。

完整結構：

    {
      "name": "wf_perf_tc05_seq_10",
      "description": "TC05 sequential workflow with 10 SIMPLE tasks",
      "version": 1,
      "schemaVersion": 2,
      "ownerEmail": "perf-test@example.com",
      "inputParameters": [
        "testRunId",
        "iterationId",
        "createdAtMs",
        "payload"
      ],
      "outputParameters": {
        "testRunId": "${workflow.input.testRunId}",
        "iterationId": "${workflow.input.iterationId}"
      },
      "tasks": [
        {
          "name": "perf_task_tc05_seq",
          "taskReferenceName": "step_01",
          "type": "SIMPLE",
          "inputParameters": {
            "testRunId": "${workflow.input.testRunId}",
            "iterationId": "${workflow.input.iterationId}",
            "createdAtMs": "${workflow.input.createdAtMs}",
            "stepNo": 1,
            "payload": "${workflow.input.payload}"
          }
        },
        {
          "name": "perf_task_tc05_seq",
          "taskReferenceName": "step_02",
          "type": "SIMPLE",
          "inputParameters": {
            "testRunId": "${workflow.input.testRunId}",
            "iterationId": "${workflow.input.iterationId}",
            "createdAtMs": "${workflow.input.createdAtMs}",
            "stepNo": 2,
            "previousCompletedAtMs": "${step_01.output.completedAtMs}",
            "payload": "${workflow.input.payload}"
          }
        }
      ]
    }

AI agent 需要補齊 step_03 到 step_10。

每個 step_N 的 inputParameters 需要包含：

    testRunId
    iterationId
    createdAtMs
    stepNo
    previousCompletedAtMs
    payload

step_01 沒有 previousCompletedAtMs。

step_02 使用：

    "${step_01.output.completedAtMs}"

step_03 使用：

    "${step_02.output.completedAtMs}"

依此類推。

---

## 7. setup() 行為

setup() 需要：

    1. ensureTaskDefinition(TASK_TYPE)
    2. ensureWorkflowDefinition(WORKFLOW_NAME, TASK_TYPE, STEP_COUNT)

workflow validation 至少檢查：

    name 正確
    version 正確
    tasks.length == STEP_COUNT
    每個 task type == SIMPLE
    每個 task name == TASK_TYPE
    每個 taskReferenceName == step_XX
    每個 task inputParameters 包含:
      - testRunId
      - iterationId
      - createdAtMs
      - stepNo
      - payload

如果 FAIL_ON_DEFINITION_MISMATCH=true，mismatch 直接 fail。

---

## 8. Scenario 設計

TC05 使用 producer / worker 分離。

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
         payload: {
           source: "k6-tc05",
           stepCount: STEP_COUNT
         }
       }
    5. 記錄 workflow_start_latency
    6. workflows_started + 1

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
       - 解析 task.inputData.stepNo
       - poll_hit_latency.add()
       - tasks_polled.add(1)
       - 記錄 task_scheduled_to_poll_latency
       - 記錄 workflow_submit_to_poll_latency
       - 如果 previousCompletedAtMs 存在:
         step_transition_latency = Date.now() - previousCompletedAtMs
       - POST /tasks complete
       - outputData:
         {
           completedAtMs: Date.now(),
           stepNo,
           testRunId,
           iterationId
         }
       - task_update_latency.add()
       - tasks_completed.add(1)
       - 如果 stepNo == STEP_COUNT:
         terminal_step_completed.add(1)
         workflow_submit_to_last_task_complete_latency.add(Date.now() - createdAtMs)

---

## 9. 必要 Metrics

Trend：

    workflow_start_latency
    poll_attempt_latency
    poll_hit_latency
    poll_miss_latency
    task_update_latency
    task_scheduled_to_poll_latency
    workflow_submit_to_poll_latency
    step_transition_latency
    workflow_submit_to_last_task_complete_latency

Counter：

    workflows_started
    tasks_polled
    tasks_completed
    terminal_step_completed
    poll_misses
    workflow_start_errors
    poll_errors
    complete_errors
    missing_task_scheduled_time
    missing_input_created_at_ms
    missing_previous_completed_at_ms
    errors

Rate：

    workflow_start_success_rate
    task_complete_success_rate
    poll_hit_rate

Metrics 需要加 tags：

    {
      stepNo,
      workflowName,
      taskType
    }

其中 workflow-level metrics 可以不加 stepNo。

---

## 10. Step Transition Latency

step transition latency 定義：

    step_N-1 complete 成功時間
      -> step_N 被 worker poll 到的時間

計算方式：

    previousCompletedAtMs = Number(task.inputData.previousCompletedAtMs)
    pollReceivedAtMs = Date.now()
    stepTransitionLatency = pollReceivedAtMs - previousCompletedAtMs

只有 step_02 到 step_10 才有 step_transition_latency。

如果 stepNo > 1 但 previousCompletedAtMs 不存在：

    missing_previous_completed_at_ms += 1

---

## 11. Workflow 完成判斷

TC05 不一定要每次都 GET workflow 查 completed，因為這會增加額外 API 壓力。

建議用 terminal step complete 作為主要近似：

    terminal_step_completed / workflows_started >= 0.99

如果要做抽樣確認，可新增 monitor scenario：

    每秒抽樣查詢最近部分 workflowId
    GET /workflow/{workflowId}?includeTasks=false

但第一版 k6 腳本可不做 workflow get，避免干擾壓測主體。

---

## 12. Threshold 建議

初期只用功能 threshold：

    errors == 0
    workflow_start_success_rate >= 0.999
    task_complete_success_rate >= 0.999

正式 SLA 測試再加入：

    workflow_start_latency p95 < SLA_API_P95_MS
    task_update_latency p95 < SLA_API_P95_MS
    task_scheduled_to_poll_latency p95 < SLA_SCHEDULE_TO_POLL_P95_MS
    step_transition_latency p95 < SLA_STEP_TRANSITION_P95_MS

---

## 13. 建議測試階段

因為每個 workflow 會產生 10 個 tasks：

    expected_task_completed_rps = WORKFLOW_START_RPS * STEP_COUNT

測試輪次：

    Round 1:
      WORKFLOW_START_RPS=10
      POLL_RPS=150
      expected_task_completed_rps=100

    Round 2:
      WORKFLOW_START_RPS=20
      POLL_RPS=300
      expected_task_completed_rps=200

    Round 3:
      WORKFLOW_START_RPS=30
      POLL_RPS=450
      expected_task_completed_rps=300

    Round 4:
      WORKFLOW_START_RPS=50
      POLL_RPS=750
      expected_task_completed_rps=500

    Round 5:
      WORKFLOW_START_RPS=80
      POLL_RPS=1200
      expected_task_completed_rps=800

POLL_RPS 建議：

    POLL_RPS = WORKFLOW_START_RPS * STEP_COUNT * 1.5

---

## 14. 執行方式

    k6 run \
      -e BASE_URL="https://your-conductor-domain" \
      -e API_PREFIX="/api" \
      -e WORKFLOW_NAME="wf_perf_tc05_seq_10" \
      -e TASK_TYPE="perf_task_tc05_seq" \
      -e STEP_COUNT=10 \
      -e WORKFLOW_START_RPS=20 \
      -e POLL_RPS=300 \
      -e TEST_DURATION="5m" \
      -e AUTO_CREATE_DEFINITIONS=true \
      -e FAIL_ON_DEFINITION_MISMATCH=true \
      k6/scenarios/tc05_sequential_workflow.js

---

## 15. 成功標準

某一輪 stable 條件：

    errors = 0
    workflow_start_success_rate >= 99.9%
    task_complete_success_rate >= 99.9%
    tasks_completed / (workflows_started * STEP_COUNT) >= 0.99
    terminal_step_completed / workflows_started >= 0.99
    workflow_start_latency p95 < SLA_API_P95_MS
    task_update_latency p95 < SLA_API_P95_MS
    task_scheduled_to_poll_latency p95 < SLA_SCHEDULE_TO_POLL_P95_MS
    step_transition_latency p95 < SLA_STEP_TRANSITION_P95_MS
    missing_input_created_at_ms = 0
    k6 dropped_iterations = 0

---

## 16. Cliff Point 判定

以下任一條件成立即視為超過穩定上限：

    tasks_completed / (workflows_started * STEP_COUNT) < 0.99
    terminal_step_completed / workflows_started < 0.99
    step_transition_latency p95 超過 SLA
    task_scheduled_to_poll_latency p95 超過 SLA
    task_update_latency p95 超過 SLA
    workflow_start_latency p95 超過 SLA
    errors > 0
    dropped_iterations > 0
    poll hit rate 下降且 task completion 跟不上
    terminal step 明顯延遲累積

---

## 17. Summary 輸出

handleSummary() 需要輸出：

    tc05_summary.json
    tc05_raw_summary.json

summary 至少包含：

    {
      "testCase": "TC05",
      "workflowName": "wf_perf_tc05_seq_10",
      "taskType": "perf_task_tc05_seq",
      "stepCount": 10,
      "workflowStartRps": 20,
      "pollRps": 300,
      "expectedTaskCompletedRps": 200,
      "testDuration": "5m",
      "overall": {
        "workflowsStarted": {},
        "tasksPolled": {},
        "tasksCompleted": {},
        "terminalStepCompleted": {},
        "pollMisses": {},
        "workflowStartLatency": {},
        "taskUpdateLatency": {},
        "taskScheduledToPollLatency": {},
        "stepTransitionLatency": {},
        "workflowSubmitToLastTaskCompleteLatency": {},
        "errors": {}
      },
      "derived": {
        "taskCompletedToExpectedRatio": 0.995,
        "terminalStepCompletedToWorkflowStartedRatio": 0.993,
        "actualTaskCompletedRps": 199,
        "isStable": true
      },
      "perStep": [
        {
          "stepNo": 1,
          "tasksCompleted": 6000,
          "scheduleToPollP95Ms": 300,
          "taskUpdateP95Ms": 200
        },
        {
          "stepNo": 2,
          "tasksCompleted": 5990,
          "stepTransitionP95Ms": 350,
          "scheduleToPollP95Ms": 320,
          "taskUpdateP95Ms": 210
        }
      ]
    }

---

## 18. 最終產出

測完後整理：

    tc05_result:
      max_stable_seq10_workflow_start_rps: TBD
      max_stable_task_completed_rps: TBD
      recommended_safe_seq10_workflow_start_rps: TBD
      recommended_safe_task_completed_rps: TBD
      step_transition_p95_ms: TBD
      workflow_submit_to_last_task_complete_p95_ms: TBD

建議：

    recommended_safe_seq10_workflow_start_rps =
      max_stable_seq10_workflow_start_rps * 0.7

---

## 19. 對內 SLA 轉換

TC05 結果應轉成：

    workflow_complexity_rules:
      single_task_workflow_safe_rps: from TC01
      seq10_workflow_safe_rps: from TC05
      max_recommended_sequential_steps_without_review: TBD

    usage_rules:
      - 多 step workflow 不可直接套用 single-task workflow 的 RPS 上限
      - SLA 應同時限制 workflow/s 與 task/s
      - workflow step 數量增加時，需要重新評估 task scheduling 與 evaluator 壓力
      - sequential steps 超過 10 建議進入平台 review