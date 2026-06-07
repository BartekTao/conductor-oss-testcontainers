import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import exec from 'k6/execution';
import { Trend, Counter, Rate } from 'k6/metrics';

/**
 * File: tc00_smoke_collect_metrics.js
 *
 * Purpose:
 * 1. Check task definition exists.
 * 2. Create task definition if missing.
 * 3. Check workflow definition exists.
 * 4. Create workflow definition if missing.
 * 5. Start workflow.
 * 6. Poll task.
 * 7. Measure schedule-to-poll latency.
 * 8. Complete task.
 * 9. Wait workflow completed.
 * 10. Output k6 summary metrics.
 *
 * Required ENV:
 *   BASE_URL=https://your-conductor-domain
 *
 * Optional ENV:
 *   API_PREFIX=/api
 *   WORKFLOW_NAME=wf_perf_single_hot
 *   TASK_TYPE=perf_task_hot
 *   WORKFLOW_VERSION=1
 *   OWNER_EMAIL=perf-test@example.com
 *
 *   AUTO_CREATE_DEFINITIONS=true
 *   FAIL_ON_DEFINITION_MISMATCH=true
 *
 *   VUS=1
 *   ITERATIONS=10
 *   MAX_POLL_ATTEMPTS=60
 *   POLL_SLEEP_MS=200
 *   WORKFLOW_WAIT_TIMEOUT_MS=30000
 *
 *   STRICT_WORKFLOW_MATCH=true
 *
 *   SLA_API_P95_MS=500
 *   SLA_WORKFLOW_E2E_P95_MS=3000
 */

// ======================================================
// ENV Config
// ======================================================

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/$/, '');
const API_PREFIX = __ENV.API_PREFIX || '/api';

if (!BASE_URL) {
  throw new Error('Missing required env: BASE_URL');
}

const WORKFLOW_NAME = __ENV.WORKFLOW_NAME || 'wf_perf_single_hot';
const TASK_TYPE = __ENV.TASK_TYPE || 'perf_task_hot';
const WORKFLOW_VERSION = Number(__ENV.WORKFLOW_VERSION || 1);
const OWNER_EMAIL = __ENV.OWNER_EMAIL || 'perf-test@example.com';

const AUTO_CREATE_DEFINITIONS =
  (__ENV.AUTO_CREATE_DEFINITIONS || 'true') === 'true';

const FAIL_ON_DEFINITION_MISMATCH =
  (__ENV.FAIL_ON_DEFINITION_MISMATCH || 'true') === 'true';

const VUS = Number(__ENV.VUS || 1);
const ITERATIONS = Number(__ENV.ITERATIONS || 10);

const MAX_POLL_ATTEMPTS = Number(__ENV.MAX_POLL_ATTEMPTS || 60);
const POLL_SLEEP_MS = Number(__ENV.POLL_SLEEP_MS || 200);
const WORKFLOW_WAIT_TIMEOUT_MS = Number(__ENV.WORKFLOW_WAIT_TIMEOUT_MS || 30000);

const STRICT_WORKFLOW_MATCH = (__ENV.STRICT_WORKFLOW_MATCH || 'true') === 'true';

const TEST_RUN_ID =
  __ENV.TEST_RUN_ID ||
  `tc00-${new Date().toISOString().replace(/[:.]/g, '-')}`;

const WORKER_ID_PREFIX = __ENV.WORKER_ID_PREFIX || 'k6-tc00-worker';

const SLA_API_P95_MS = Number(__ENV.SLA_API_P95_MS || 500);
const SLA_WORKFLOW_E2E_P95_MS = Number(__ENV.SLA_WORKFLOW_E2E_P95_MS || 3000);

// ======================================================
// k6 Options
// ======================================================

export const options = {
  scenarios: {
    tc00_smoke: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: ITERATIONS,
      maxDuration: '5m',
    },
  },
  thresholds: {
    workflow_start_latency: [`p(95)<${SLA_API_P95_MS}`],
    poll_attempt_latency: [`p(95)<${SLA_API_P95_MS}`],
    task_update_latency: [`p(95)<${SLA_API_P95_MS}`],
    workflow_get_latency: [`p(95)<${SLA_API_P95_MS}`],
    workflow_e2e_latency: [`p(95)<${SLA_WORKFLOW_E2E_P95_MS}`],
    workflow_success_rate: ['rate>=0.99'],
    errors: ['count==0'],
  },
};

// ======================================================
// Custom Metrics
// ======================================================

const workflowStartLatency = new Trend('workflow_start_latency', true);
const pollAttemptLatency = new Trend('poll_attempt_latency', true);
const pollHitLatency = new Trend('poll_hit_latency', true);
const pollMissLatency = new Trend('poll_miss_latency', true);
const taskUpdateLatency = new Trend('task_update_latency', true);
const workflowGetLatency = new Trend('workflow_get_latency', true);
const workflowE2ELatency = new Trend('workflow_e2e_latency', true);

/**
 * Most important metric:
 *
 * task_scheduled_to_poll_latency
 * = worker receives task time - task.scheduledTime
 *
 * This is the closest approximation of:
 * Conductor scheduled task -> worker successfully polled task
 */
const taskScheduledToPollLatency = new Trend(
  'task_scheduled_to_poll_latency',
  true,
);

/**
 * Fallback metric:
 *
 * workflow_submit_to_poll_latency
 * = worker receives task time - workflow input createdAtMs
 *
 * This includes:
 * workflow start + task scheduling + queue waiting + poll latency
 *
 * It is not pure queue latency.
 */
const workflowSubmitToPollLatency = new Trend(
  'workflow_submit_to_poll_latency',
  true,
);

const workflowsStarted = new Counter('workflows_started');
const tasksPolled = new Counter('tasks_polled');
const tasksCompleted = new Counter('tasks_completed');
const pollMisses = new Counter('poll_misses');
const errors = new Counter('errors');

const workflowSuccessRate = new Rate('workflow_success_rate');
const pollHitRate = new Rate('poll_hit_rate');

const missingTaskScheduledTime = new Counter('missing_task_scheduled_time');
const missingInputCreatedAtMs = new Counter('missing_input_created_at_ms');
const unexpectedWorkflowTask = new Counter('unexpected_workflow_task');

// ======================================================
// Setup: Ensure Definitions
// ======================================================

export function setup() {
  const taskDef = buildTaskDef(TASK_TYPE);
  const workflowDef = buildWorkflowDef(
    WORKFLOW_NAME,
    TASK_TYPE,
    WORKFLOW_VERSION,
  );

  console.log(`[setup] BASE_URL=${BASE_URL}`);
  console.log(`[setup] API_PREFIX=${API_PREFIX}`);
  console.log(`[setup] TEST_RUN_ID=${TEST_RUN_ID}`);

  console.log(`[setup] Checking task definition: ${TASK_TYPE}`);
  const taskResult = ensureTaskDefinition(taskDef);

  console.log(
    `[setup] Checking workflow definition: ${WORKFLOW_NAME}, version=${WORKFLOW_VERSION}`,
  );
  const workflowResult = ensureWorkflowDefinition(workflowDef);

  console.log(
    `[setup] Definition check completed. task=${taskResult.action}, workflow=${workflowResult.action}`,
  );

  return {
    testRunId: TEST_RUN_ID,
    workflowName: WORKFLOW_NAME,
    taskType: TASK_TYPE,
    workflowVersion: WORKFLOW_VERSION,
    taskDefinitionAction: taskResult.action,
    workflowDefinitionAction: workflowResult.action,
  };
}

// ======================================================
// Main Scenario
// ======================================================

export default function (setupData) {
  const iterationId =
    `${setupData.testRunId}` +
    `-vu${exec.vu.idInTest}` +
    `-iter${exec.scenario.iterationInTest}`;

  const workerId = `${WORKER_ID_PREFIX}-${exec.vu.idInTest}`;

  const createdAtMs = Date.now();

  const input = {
    testRunId: setupData.testRunId,
    iterationId,
    createdAtMs,
    payload: {
      source: 'k6-tc00',
      vu: exec.vu.idInTest,
      iteration: exec.scenario.iterationInTest,
    },
  };

  const workflowId = startWorkflow(setupData.workflowName, input, iterationId);

  const task = pollUntilHit(setupData.taskType, workerId, workflowId);

  completeTask(task, workerId);

  const completed = waitWorkflowCompleted(workflowId, createdAtMs);

  workflowSuccessRate.add(completed);

  if (!completed) {
    errors.add(1);
    fail(`Workflow not completed. workflowId=${workflowId}`);
  }
}

// ======================================================
// Definition Builders
// ======================================================

function buildTaskDef(taskType) {
  return {
    name: taskType,
    description: 'K6 TC00 performance smoke test task',
    retryCount: 0,
    retryLogic: 'FIXED',
    retryDelaySeconds: 0,
    timeoutSeconds: 60,
    responseTimeoutSeconds: 30,
    pollTimeoutSeconds: 60,
    timeoutPolicy: 'TIME_OUT_WF',
    ownerEmail: OWNER_EMAIL,
    inputKeys: [],
    outputKeys: [],
    inputTemplate: {},
  };
}

function buildWorkflowDef(workflowName, taskType, version) {
  return {
    name: workflowName,
    description: 'K6 TC00 smoke workflow for Conductor capacity test',
    version,
    schemaVersion: 2,
    ownerEmail: OWNER_EMAIL,
    inputParameters: [
      'testRunId',
      'iterationId',
      'createdAtMs',
      'payload',
    ],
    outputParameters: {
      testRunId: '${workflow.input.testRunId}',
      iterationId: '${workflow.input.iterationId}',
    },
    tasks: [
      {
        name: taskType,
        taskReferenceName: `${taskType}_ref`,
        type: 'SIMPLE',
        inputParameters: {
          testRunId: '${workflow.input.testRunId}',
          iterationId: '${workflow.input.iterationId}',
          createdAtMs: '${workflow.input.createdAtMs}',
          payload: '${workflow.input.payload}',
        },
      },
    ],
  };
}

// ======================================================
// Definition Ensure Functions
// ======================================================

function ensureTaskDefinition(taskDef) {
  const existing = getTaskDefinition(taskDef.name);

  if (existing.exists) {
    validateExistingTaskDefinition(existing.body, taskDef);

    return {
      action: 'exists',
      name: taskDef.name,
    };
  }

  if (!AUTO_CREATE_DEFINITIONS) {
    throw new Error(
      `[setup] Task definition does not exist and AUTO_CREATE_DEFINITIONS=false. taskType=${taskDef.name}`,
    );
  }

  console.log(`[setup] Creating task definition: ${taskDef.name}`);

  const res = http.post(
    api('/metadata/taskdefs'),
    JSON.stringify([taskDef]),
    jsonParams({
      op: 'create_task_definition',
      taskType: taskDef.name,
    }),
  );

  const ok = res.status === 200 || res.status === 201 || res.status === 204;

  if (!ok) {
    throw new Error(
      `[setup] Failed to create task definition. ` +
      `taskType=${taskDef.name}, status=${res.status}, body=${res.body}`,
    );
  }

  const verify = getTaskDefinition(taskDef.name);

  if (!verify.exists) {
    throw new Error(
      `[setup] Task definition create returned success, but verification failed. taskType=${taskDef.name}`,
    );
  }

  return {
    action: 'created',
    name: taskDef.name,
  };
}

function ensureWorkflowDefinition(workflowDef) {
  const existing = getWorkflowDefinition(workflowDef.name, workflowDef.version);

  if (existing.exists) {
    validateExistingWorkflowDefinition(existing.body, workflowDef);

    return {
      action: 'exists',
      name: workflowDef.name,
      version: workflowDef.version,
    };
  }

  if (!AUTO_CREATE_DEFINITIONS) {
    throw new Error(
      `[setup] Workflow definition does not exist and AUTO_CREATE_DEFINITIONS=false. ` +
      `workflow=${workflowDef.name}, version=${workflowDef.version}`,
    );
  }

  console.log(
    `[setup] Creating workflow definition: ${workflowDef.name}, version=${workflowDef.version}`,
  );

  const res = http.post(
    api('/metadata/workflow'),
    JSON.stringify(workflowDef),
    jsonParams({
      op: 'create_workflow_definition',
      workflow: workflowDef.name,
    }),
  );

  const ok = res.status === 200 || res.status === 201 || res.status === 204;

  if (!ok) {
    throw new Error(
      `[setup] Failed to create workflow definition. ` +
      `workflow=${workflowDef.name}, version=${workflowDef.version}, ` +
      `status=${res.status}, body=${res.body}`,
    );
  }

  const verify = getWorkflowDefinition(workflowDef.name, workflowDef.version);

  if (!verify.exists) {
    throw new Error(
      `[setup] Workflow definition create returned success, but verification failed. ` +
      `workflow=${workflowDef.name}, version=${workflowDef.version}`,
    );
  }

  return {
    action: 'created',
    name: workflowDef.name,
    version: workflowDef.version,
  };
}

// ======================================================
// Definition Get Functions
// ======================================================

function getTaskDefinition(taskType) {
  const res = http.get(
    api(`/metadata/taskdefs/${encodeURIComponent(taskType)}`),
    jsonParams({
      op: 'get_task_definition',
      taskType,
    }),
  );

  if (res.status === 200) {
    return {
      exists: true,
      body: safeJson(res),
      status: res.status,
    };
  }

  if (res.status === 404) {
    return {
      exists: false,
      body: null,
      status: res.status,
    };
  }

  throw new Error(
    `[setup] Failed to check task definition. ` +
    `taskType=${taskType}, status=${res.status}, body=${res.body}`,
  );
}

function getWorkflowDefinition(workflowName, version) {
  const res = http.get(
    api(
      `/metadata/workflow/${encodeURIComponent(workflowName)}` +
      `?version=${encodeURIComponent(version)}`,
    ),
    jsonParams({
      op: 'get_workflow_definition',
      workflow: workflowName,
    }),
  );

  if (res.status === 200) {
    return {
      exists: true,
      body: safeJson(res),
      status: res.status,
    };
  }

  if (res.status === 404) {
    return {
      exists: false,
      body: null,
      status: res.status,
    };
  }

  throw new Error(
    `[setup] Failed to check workflow definition. ` +
    `workflow=${workflowName}, version=${version}, status=${res.status}, body=${res.body}`,
  );
}

// ======================================================
// Definition Validation
// ======================================================

function validateExistingTaskDefinition(existing, expected) {
  if (!existing) {
    throw new Error(
      `[setup] Existing task definition response is empty. taskType=${expected.name}`,
    );
  }

  const mismatches = [];

  if (existing.name !== expected.name) {
    mismatches.push(`name expected=${expected.name}, actual=${existing.name}`);
  }

  if (Number(existing.timeoutSeconds) !== Number(expected.timeoutSeconds)) {
    mismatches.push(
      `timeoutSeconds expected=${expected.timeoutSeconds}, actual=${existing.timeoutSeconds}`,
    );
  }

  if (
    Number(existing.responseTimeoutSeconds) !==
    Number(expected.responseTimeoutSeconds)
  ) {
    mismatches.push(
      `responseTimeoutSeconds expected=${expected.responseTimeoutSeconds}, actual=${existing.responseTimeoutSeconds}`,
    );
  }

  if (Number(existing.retryCount) !== Number(expected.retryCount)) {
    mismatches.push(
      `retryCount expected=${expected.retryCount}, actual=${existing.retryCount}`,
    );
  }

  if (mismatches.length > 0) {
    const msg =
      `[setup] Task definition exists but differs from TC00 expected definition. ` +
      `taskType=${expected.name}, mismatches=${mismatches.join('; ')}`;

    if (FAIL_ON_DEFINITION_MISMATCH) {
      throw new Error(msg);
    }

    console.warn(msg);
  }
}

function validateExistingWorkflowDefinition(existing, expected) {
  if (!existing) {
    throw new Error(
      `[setup] Existing workflow definition response is empty. workflow=${expected.name}`,
    );
  }

  const mismatches = [];

  if (existing.name !== expected.name) {
    mismatches.push(`name expected=${expected.name}, actual=${existing.name}`);
  }

  if (Number(existing.version) !== Number(expected.version)) {
    mismatches.push(
      `version expected=${expected.version}, actual=${existing.version}`,
    );
  }

  if (!Array.isArray(existing.tasks) || existing.tasks.length !== 1) {
    mismatches.push(
      `tasks.length expected=1, actual=${
        existing.tasks ? existing.tasks.length : 'null'
      }`,
    );
  } else {
    const task = existing.tasks[0];
    const expectedTask = expected.tasks[0];

    if (task.name !== expectedTask.name) {
      mismatches.push(
        `task.name expected=${expectedTask.name}, actual=${task.name}`,
      );
    }

    if (task.type !== 'SIMPLE') {
      mismatches.push(`task.type expected=SIMPLE, actual=${task.type}`);
    }

    if (task.taskReferenceName !== expectedTask.taskReferenceName) {
      mismatches.push(
        `taskReferenceName expected=${expectedTask.taskReferenceName}, actual=${task.taskReferenceName}`,
      );
    }

    const inputParameters = task.inputParameters || {};

    for (const key of ['testRunId', 'iterationId', 'createdAtMs']) {
      if (!Object.prototype.hasOwnProperty.call(inputParameters, key)) {
        mismatches.push(`task.inputParameters missing key=${key}`);
      }
    }
  }

  if (mismatches.length > 0) {
    const msg =
      `[setup] Workflow definition exists but differs from TC00 expected definition. ` +
      `workflow=${expected.name}, version=${expected.version}, mismatches=${mismatches.join('; ')}`;

    if (FAIL_ON_DEFINITION_MISMATCH) {
      throw new Error(msg);
    }

    console.warn(msg);
  }
}

// ======================================================
// Conductor API Functions
// ======================================================

function startWorkflow(workflowName, input, correlationId) {
  const endpoint =
    `/workflow/${encodeURIComponent(workflowName)}` +
    `?version=${WORKFLOW_VERSION}` +
    `&correlationId=${encodeURIComponent(correlationId)}`;

  const res = http.post(
    api(endpoint),
    JSON.stringify(input),
    jsonParams({
      op: 'start_workflow',
      workflow: workflowName,
    }),
  );

  workflowStartLatency.add(res.timings.duration);
  workflowsStarted.add(1);

  const ok = check(res, {
    'start workflow status is 200/202': (r) =>
      r.status === 200 || r.status === 202,
    'start workflow has body': (r) => !!r.body && r.body.length > 0,
  });

  if (!ok) {
    errors.add(1);
    fail(
      `Failed to start workflow. status=${res.status}, body=${res.body}`,
    );
  }

  const workflowId = parseWorkflowId(res);

  if (!workflowId) {
    errors.add(1);
    fail(
      `Cannot parse workflowId. status=${res.status}, body=${res.body}`,
    );
  }

  return workflowId;
}

function pollUntilHit(taskType, workerId, expectedWorkflowId) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const endpoint =
      `/tasks/poll/${encodeURIComponent(taskType)}` +
      `?workerid=${encodeURIComponent(workerId)}`;

    const res = http.get(
      api(endpoint),
      jsonParams({
        op: 'poll_task',
        taskType,
      }),
    );

    pollAttemptLatency.add(res.timings.duration);

    const body = (res.body || '').trim();

    if (res.status === 200 && body !== '' && body !== 'null') {
      pollHitLatency.add(res.timings.duration);
      pollHitRate.add(true);

      const task = safeJson(res);

      if (!task || !task.taskId) {
        errors.add(1);
        fail(
          `Poll hit but task body is invalid. status=${res.status}, body=${res.body}`,
        );
      }

      tasksPolled.add(1);

      if (
        STRICT_WORKFLOW_MATCH &&
        task.workflowInstanceId &&
        task.workflowInstanceId !== expectedWorkflowId
      ) {
        unexpectedWorkflowTask.add(1);
        errors.add(1);

        fail(
          `Polled task belongs to another workflow. ` +
          `expected=${expectedWorkflowId}, actual=${task.workflowInstanceId}`,
        );
      }

      recordScheduleToPollMetrics(task);

      return task;
    }

    pollMissLatency.add(res.timings.duration);
    pollMisses.add(1);
    pollHitRate.add(false);

    check(res, {
      'poll miss status is acceptable': (r) =>
        r.status === 200 || r.status === 204 || r.status === 404,
    });

    sleep(POLL_SLEEP_MS / 1000);
  }

  errors.add(1);

  fail(
    `Poll timeout. taskType=${taskType}, maxAttempts=${MAX_POLL_ATTEMPTS}`,
  );
}

function completeTask(task, workerId) {
  const workflowInstanceId = task.workflowInstanceId || task.workflowId;

  if (!workflowInstanceId || !task.taskId) {
    errors.add(1);
    fail(
      `Cannot complete task because taskId or workflowInstanceId is missing: ${JSON.stringify(
        task,
      )}`,
    );
  }

  const payload = {
    workflowInstanceId,
    taskId: task.taskId,
    status: 'COMPLETED',
    workerId,
    outputData: {
      completedAtMs: Date.now(),
      testRunId: getTaskInput(task, 'testRunId'),
      iterationId: getTaskInput(task, 'iterationId'),
    },
  };

  const res = http.post(
    api('/tasks'),
    JSON.stringify(payload),
    jsonParams({
      op: 'complete_task',
      taskType: task.taskDefName || TASK_TYPE,
    }),
  );

  taskUpdateLatency.add(res.timings.duration);

  const ok = check(res, {
    'complete task status is 200/204': (r) =>
      r.status === 200 || r.status === 204,
  });

  if (!ok) {
    errors.add(1);
    fail(
      `Failed to complete task. status=${res.status}, body=${res.body}`,
    );
  }

  tasksCompleted.add(1);
}

function waitWorkflowCompleted(workflowId, createdAtMs) {
  const deadline = Date.now() + WORKFLOW_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = http.get(
      api(`/workflow/${encodeURIComponent(workflowId)}?includeTasks=true`),
      jsonParams({
        op: 'get_workflow',
      }),
    );

    workflowGetLatency.add(res.timings.duration);

    if (res.status === 200) {
      const workflow = safeJson(res);
      const status = workflow && workflow.status;

      if (status === 'COMPLETED') {
        workflowE2ELatency.add(Date.now() - createdAtMs);
        return true;
      }

      if (
        status === 'FAILED' ||
        status === 'TIMED_OUT' ||
        status === 'TERMINATED'
      ) {
        console.error(
          `Workflow reached non-success terminal status. workflowId=${workflowId}, status=${status}`,
        );
        return false;
      }
    }

    sleep(0.2);
  }

  console.error(`Workflow wait timeout. workflowId=${workflowId}`);

  return false;
}

// ======================================================
// Metric Helpers
// ======================================================

function recordScheduleToPollMetrics(task) {
  const pollReceivedAtMs = Date.now();

  const scheduledTimeRaw = firstValidNumber(
    task.scheduledTime,
    task.scheduledTimeMs,
    task.scheduledTimeInMs,
  );

  if (scheduledTimeRaw !== null) {
    const scheduledAtMs = normalizeEpochMs(scheduledTimeRaw);
    const latency = pollReceivedAtMs - scheduledAtMs;

    if (latency >= 0) {
      taskScheduledToPollLatency.add(latency);
    }
  } else {
    missingTaskScheduledTime.add(1);
  }

  const createdAtMsRaw = firstValidNumber(
    getTaskInput(task, 'createdAtMs'),
    getTaskInput(task, 'workflowCreatedAtMs'),
  );

  if (createdAtMsRaw !== null) {
    const createdAtMs = normalizeEpochMs(createdAtMsRaw);
    const latency = pollReceivedAtMs - createdAtMs;

    if (latency >= 0) {
      workflowSubmitToPollLatency.add(latency);
    }
  } else {
    missingInputCreatedAtMs.add(1);
  }
}

// ======================================================
// Utility Functions
// ======================================================

function api(path) {
  return `${BASE_URL}${API_PREFIX}${path}`;
}

function jsonParams(tags) {
  return {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    tags: tags || {},
  };
}

function safeJson(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

function parseWorkflowId(res) {
  const json = safeJson(res);

  if (typeof json === 'string') {
    return json;
  }

  if (json && typeof json === 'object') {
    return (
      json.workflowId ||
      json.workflowInstanceId ||
      json.id ||
      json.executionId ||
      null
    );
  }

  if (res.body) {
    return res.body.replace(/^"|"$/g, '').trim();
  }

  return null;
}

function getTaskInput(task, key) {
  if (!task) return undefined;

  if (
    task.inputData &&
    Object.prototype.hasOwnProperty.call(task.inputData, key)
  ) {
    return task.inputData[key];
  }

  if (
    task.input &&
    Object.prototype.hasOwnProperty.call(task.input, key)
  ) {
    return task.input[key];
  }

  return undefined;
}

function firstValidNumber() {
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i];

    if (value === undefined || value === null || value === '') {
      continue;
    }

    const n = Number(value);

    if (Number.isFinite(n)) {
      return n;
    }
  }

  return null;
}

function normalizeEpochMs(value) {
  const n = Number(value);

  // Milliseconds epoch, e.g. 1710000000000
  if (n > 1000000000000) {
    return n;
  }

  // Seconds epoch, e.g. 1710000000
  if (n > 1000000000) {
    return n * 1000;
  }

  return n;
}

// ======================================================
// Summary Output
// ======================================================

export function handleSummary(data) {
  const selected = {
    testRunId: TEST_RUN_ID,
    baseUrl: BASE_URL,
    apiPrefix: API_PREFIX,
    workflowName: WORKFLOW_NAME,
    taskType: TASK_TYPE,
    workflowVersion: WORKFLOW_VERSION,
    vus: VUS,
    iterations: ITERATIONS,
    strictWorkflowMatch: STRICT_WORKFLOW_MATCH,
    autoCreateDefinitions: AUTO_CREATE_DEFINITIONS,
    failOnDefinitionMismatch: FAIL_ON_DEFINITION_MISMATCH,
    metrics: pickMetrics(data.metrics, [
      'workflow_start_latency',
      'poll_attempt_latency',
      'poll_hit_latency',
      'poll_miss_latency',
      'task_update_latency',
      'workflow_get_latency',
      'workflow_e2e_latency',
      'task_scheduled_to_poll_latency',
      'workflow_submit_to_poll_latency',
      'workflows_started',
      'tasks_polled',
      'tasks_completed',
      'poll_misses',
      'workflow_success_rate',
      'poll_hit_rate',
      'missing_task_scheduled_time',
      'missing_input_created_at_ms',
      'unexpected_workflow_task',
      'errors',
    ]),
  };

  return {
    stdout: JSON.stringify(selected, null, 2) + '\n',
    'tc00_summary.json': JSON.stringify(selected, null, 2),
    'tc00_raw_summary.json': JSON.stringify(data, null, 2),
  };
}

function pickMetrics(metrics, names) {
  const result = {};

  for (const name of names) {
    if (metrics[name]) {
      result[name] = metrics[name];
    }
  }

  return result;
}