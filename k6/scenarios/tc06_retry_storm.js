import { check, fail } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

import {
  createConductorClient,
  isSuccessfulTaskComplete,
  isSuccessfulWorkflowStart,
} from '../lib/conductor.js';
import {
  compareEqual,
  compareNumber,
  createDefinitionService,
  hasOwn,
} from '../lib/definitions.js';
import { booleanEnv, numberEnv, requireString, stripTrailingSlash } from '../lib/env.js';
import {
  addNonNegativeLatency,
  firstValidNumber,
  getTaskInput,
  parsePollResult,
} from '../lib/task.js';
import { metricCount, metricRate, pickMetrics, ratio } from '../lib/summary.js';

const METRIC_NAMES = [
  'workflow_start_latency',
  'poll_attempt_latency',
  'poll_hit_latency',
  'poll_miss_latency',
  'task_update_latency',
  'task_failed_update_latency',
  'task_scheduled_to_poll_latency',
  'workflow_submit_to_poll_latency',
  'workflow_submit_to_task_complete_latency',
  'workflows_started',
  'tasks_polled',
  'tasks_completed',
  'tasks_failed',
  'poll_misses',
  'workflow_start_errors',
  'poll_errors',
  'complete_errors',
  'fail_update_errors',
  'missing_task_scheduled_time',
  'missing_input_created_at_ms',
  'unexpected_task_type',
  'errors',
  'workflow_start_success_rate',
  'task_complete_success_rate',
  'task_fail_update_success_rate',
  'injected_fail_rate',
  'poll_hit_rate',
  'poll_success_rate',
];

function loadConfig(env) {
  const baseUrl = requireString(stripTrailingSlash(env.BASE_URL || ''), 'BASE_URL');
  const failRatio = numberEnv(env.FAIL_RATIO, 0.1);
  const retryCount = numberEnv(env.RETRY_COUNT, 3);
  const retryDelaySeconds = numberEnv(env.RETRY_DELAY_SECONDS, 5);
  const workflowStartRps = numberEnv(env.WORKFLOW_START_RPS, 50);
  const pollRps = numberEnv(env.POLL_RPS, 150);

  if (failRatio < 0 || failRatio > 1) {
    throw new Error(`FAIL_RATIO must be between 0 and 1. FAIL_RATIO=${failRatio}`);
  }

  if (retryCount < 0) {
    throw new Error(`RETRY_COUNT must be >= 0. RETRY_COUNT=${retryCount}`);
  }

  if (retryDelaySeconds < 0) {
    throw new Error(
      `RETRY_DELAY_SECONDS must be >= 0. ` +
        `RETRY_DELAY_SECONDS=${retryDelaySeconds}`,
    );
  }

  if (workflowStartRps < 1) {
    throw new Error(
      `WORKFLOW_START_RPS must be >= 1. ` +
        `WORKFLOW_START_RPS=${workflowStartRps}`,
    );
  }

  if (pollRps < 1) {
    throw new Error(`POLL_RPS must be >= 1. POLL_RPS=${pollRps}`);
  }

  const testDuration = env.TEST_DURATION || '5m';

  return {
    baseUrl,
    apiPrefix: env.API_PREFIX === undefined ? '/api' : env.API_PREFIX,
    workflowName: env.WORKFLOW_NAME || 'wf_perf_tc06_retry',
    taskType: env.TASK_TYPE || 'perf_task_tc06_retry',
    workflowVersion: numberEnv(env.WORKFLOW_VERSION, 1),
    ownerEmail: env.OWNER_EMAIL || 'perf-test@example.com',
    autoCreateDefinitions: booleanEnv(env.AUTO_CREATE_DEFINITIONS, true),
    failOnDefinitionMismatch: booleanEnv(env.FAIL_ON_DEFINITION_MISMATCH, false),
    workflowStartRps,
    pollRps,
    testDuration,
    failRatio,
    retryCount,
    retryDelaySeconds,
    producerPreAllocatedVUs: numberEnv(env.PRODUCER_PRE_ALLOCATED_VUS, 20),
    producerMaxVUs: numberEnv(env.PRODUCER_MAX_VUS, 200),
    workerPreAllocatedVUs: numberEnv(env.WORKER_PRE_ALLOCATED_VUS, 50),
    workerMaxVUs: numberEnv(env.WORKER_MAX_VUS, 500),
    workerIdPrefix: env.WORKER_ID_PREFIX || 'k6-tc06-worker',
    slaApiP95Ms: numberEnv(env.SLA_API_P95_MS, 500),
    slaScheduleToPollP95Ms: numberEnv(env.SLA_SCHEDULE_TO_POLL_P95_MS, 1000),
    maxErrorRate: numberEnv(env.MAX_ERROR_RATE, 0.001),
    strictLatencyThreshold: booleanEnv(env.STRICT_LATENCY_THRESHOLD, false),
    testRunId:
      env.TEST_RUN_ID ||
      `tc06-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    testDurationSeconds: parseDurationSeconds(testDuration),
  };
}

function buildOptions(config) {
  const thresholds = {
    workflow_start_success_rate: ['rate>=0.999'],
    task_complete_success_rate: ['rate>=0.99'],
    errors: ['count==0'],
  };

  if (config.failRatio > 0) {
    thresholds.task_fail_update_success_rate = ['rate>=0.999'];
  }

  if (config.strictLatencyThreshold) {
    thresholds.workflow_start_latency = [`p(95)<${config.slaApiP95Ms}`];
    thresholds.task_update_latency = [`p(95)<${config.slaApiP95Ms}`];
    thresholds.task_failed_update_latency = [`p(95)<${config.slaApiP95Ms}`];
    thresholds.task_scheduled_to_poll_latency = [
      `p(95)<${config.slaScheduleToPollP95Ms}`,
    ];
  }

  return {
    scenarios: {
      setup_metrics: {
        executor: 'shared-iterations',
        vus: 1,
        iterations: 1,
        maxDuration: '30s',
        exec: 'recordSetupMetrics',
      },
      producer: {
        executor: 'constant-arrival-rate',
        rate: config.workflowStartRps,
        timeUnit: '1s',
        duration: config.testDuration,
        preAllocatedVUs: config.producerPreAllocatedVUs,
        maxVUs: config.producerMaxVUs,
        exec: 'producer',
      },
      worker: {
        executor: 'constant-arrival-rate',
        rate: config.pollRps,
        timeUnit: '1s',
        duration: config.testDuration,
        preAllocatedVUs: config.workerPreAllocatedVUs,
        maxVUs: config.workerMaxVUs,
        startTime: '1s',
        exec: 'worker',
      },
    },
    thresholds,
  };
}

function createTc06DefinitionFactory(config) {
  return {
    buildTaskDefinition(taskType) {
      return {
        name: taskType,
        description: 'TC06 retry storm test task',
        retryCount: config.retryCount,
        retryLogic: 'FIXED',
        retryDelaySeconds: config.retryDelaySeconds,
        timeoutSeconds: 60,
        responseTimeoutSeconds: 30,
        pollTimeoutSeconds: 60,
        timeoutPolicy: 'TIME_OUT_WF',
        ownerEmail: config.ownerEmail,
        inputKeys: [],
        outputKeys: [],
        inputTemplate: {},
      };
    },

    buildWorkflowDefinition(workflowName, taskType, version) {
      return {
        name: workflowName,
        description: 'TC06 retry storm workflow',
        version,
        schemaVersion: 2,
        ownerEmail: config.ownerEmail,
        inputParameters: [
          'testRunId',
          'iterationId',
          'createdAtMs',
          'failRatio',
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
              failRatio: '${workflow.input.failRatio}',
              payload: '${workflow.input.payload}',
            },
          },
        ],
      };
    },
  };
}

function createTc06DefinitionValidator() {
  return {
    validateTaskDefinition(existing, expected) {
      const mismatches = [];

      if (!existing) {
        return ['Existing task definition response is empty'];
      }

      compareEqual(mismatches, 'name', expected.name, existing.name);
      compareNumber(mismatches, 'retryCount', expected.retryCount, existing.retryCount);
      compareNumber(
        mismatches,
        'retryDelaySeconds',
        expected.retryDelaySeconds,
        existing.retryDelaySeconds,
      );
      compareNumber(mismatches, 'timeoutSeconds', expected.timeoutSeconds, existing.timeoutSeconds);
      compareNumber(
        mismatches,
        'responseTimeoutSeconds',
        expected.responseTimeoutSeconds,
        existing.responseTimeoutSeconds,
      );
      compareNumber(
        mismatches,
        'pollTimeoutSeconds',
        expected.pollTimeoutSeconds,
        existing.pollTimeoutSeconds,
      );
      compareEqual(mismatches, 'timeoutPolicy', expected.timeoutPolicy, existing.timeoutPolicy);

      return mismatches;
    },

    validateWorkflowDefinition(existing, expected) {
      const mismatches = [];

      if (!existing) {
        return ['Existing workflow definition response is empty'];
      }

      compareEqual(mismatches, 'name', expected.name, existing.name);
      compareNumber(mismatches, 'version', expected.version, existing.version);

      if (!Array.isArray(existing.tasks) || existing.tasks.length !== 1) {
        mismatches.push(
          `tasks.length expected=1, actual=${
            existing.tasks ? existing.tasks.length : 'null'
          }`,
        );
        return mismatches;
      }

      const actualTask = existing.tasks[0];
      const expectedTask = expected.tasks[0];
      compareEqual(mismatches, 'task.name', expectedTask.name, actualTask.name);
      compareEqual(mismatches, 'task.type', 'SIMPLE', actualTask.type);
      compareEqual(
        mismatches,
        'task.taskReferenceName',
        expectedTask.taskReferenceName,
        actualTask.taskReferenceName,
      );

      const inputParameters = actualTask.inputParameters || {};
      for (const key of ['testRunId', 'iterationId', 'createdAtMs', 'failRatio', 'payload']) {
        if (!hasOwn(inputParameters, key)) {
          mismatches.push(`task.inputParameters missing key=${key}`);
        }
      }

      return mismatches;
    },
  };
}

function createMetrics() {
  const workflowStartLatency = new Trend('workflow_start_latency', true);
  const pollAttemptLatency = new Trend('poll_attempt_latency', true);
  const pollHitLatency = new Trend('poll_hit_latency', true);
  const pollMissLatency = new Trend('poll_miss_latency', true);
  const taskUpdateLatency = new Trend('task_update_latency', true);
  const taskFailedUpdateLatency = new Trend('task_failed_update_latency', true);
  const taskScheduledToPollLatency = new Trend('task_scheduled_to_poll_latency', true);
  const workflowSubmitToPollLatency = new Trend('workflow_submit_to_poll_latency', true);
  const workflowSubmitToTaskCompleteLatency = new Trend(
    'workflow_submit_to_task_complete_latency',
    true,
  );

  const workflowsStarted = new Counter('workflows_started');
  const tasksPolled = new Counter('tasks_polled');
  const tasksCompleted = new Counter('tasks_completed');
  const tasksFailed = new Counter('tasks_failed');
  const pollMisses = new Counter('poll_misses');
  const workflowStartErrors = new Counter('workflow_start_errors');
  const pollErrors = new Counter('poll_errors');
  const completeErrors = new Counter('complete_errors');
  const failUpdateErrors = new Counter('fail_update_errors');
  const missingTaskScheduledTime = new Counter('missing_task_scheduled_time');
  const missingInputCreatedAtMs = new Counter('missing_input_created_at_ms');
  const unexpectedTaskType = new Counter('unexpected_task_type');
  const errors = new Counter('errors');

  const workflowStartSuccessRate = new Rate('workflow_start_success_rate');
  const taskCompleteSuccessRate = new Rate('task_complete_success_rate');
  const taskFailUpdateSuccessRate = new Rate('task_fail_update_success_rate');
  const injectedFailRate = new Rate('injected_fail_rate');
  const pollHitRate = new Rate('poll_hit_rate');
  const pollSuccessRate = new Rate('poll_success_rate');

  return {
    addSetupMetrics() {
      workflowsStarted.add(0);
      tasksPolled.add(0);
      tasksCompleted.add(0);
      tasksFailed.add(0);
      pollMisses.add(0);
      workflowStartErrors.add(0);
      pollErrors.add(0);
      completeErrors.add(0);
      failUpdateErrors.add(0);
      missingTaskScheduledTime.add(0);
      missingInputCreatedAtMs.add(0);
      unexpectedTaskType.add(0);
      errors.add(0);
    },

    addWorkflowStart(durationMs) {
      workflowStartLatency.add(durationMs);
      workflowsStarted.add(1);
      workflowStartSuccessRate.add(true);
    },

    addWorkflowStartError(durationMs) {
      workflowStartLatency.add(durationMs);
      workflowStartErrors.add(1);
      workflowStartSuccessRate.add(false);
      errors.add(1);
    },

    addPollAttempt(durationMs) {
      pollAttemptLatency.add(durationMs);
    },

    addPollHit(durationMs) {
      pollHitLatency.add(durationMs);
      pollHitRate.add(true);
      pollSuccessRate.add(true);
      tasksPolled.add(1);
    },

    addPollMiss(durationMs) {
      pollMissLatency.add(durationMs);
      pollHitRate.add(false);
      pollSuccessRate.add(true);
      pollMisses.add(1);
    },

    addPollError() {
      pollSuccessRate.add(false);
      pollErrors.add(1);
      errors.add(1);
    },

    addUnexpectedTaskType() {
      unexpectedTaskType.add(1);
      this.addPollError();
    },

    addTaskCompleteSuccess(durationMs, task) {
      taskUpdateLatency.add(durationMs);
      taskCompleteSuccessRate.add(true);
      injectedFailRate.add(false);
      tasksCompleted.add(1);
      this.recordWorkflowSubmitToTaskCompleteLatency(task);
    },

    addTaskCompleteFailure(durationMs) {
      taskUpdateLatency.add(durationMs);
      taskCompleteSuccessRate.add(false);
      completeErrors.add(1);
      errors.add(1);
    },

    addTaskFailUpdateSuccess(durationMs) {
      taskFailedUpdateLatency.add(durationMs);
      taskFailUpdateSuccessRate.add(true);
      injectedFailRate.add(true);
      tasksFailed.add(1);
    },

    addTaskFailUpdateFailure(durationMs) {
      taskFailedUpdateLatency.add(durationMs);
      taskFailUpdateSuccessRate.add(false);
      failUpdateErrors.add(1);
      errors.add(1);
    },

    recordPollLatencies(task) {
      const pollReceivedAtMs = Date.now();
      const scheduledAtRaw = firstValidNumber(
        task.scheduledTime,
        task.scheduledTimeMs,
        task.scheduledTimeInMs,
      );

      if (scheduledAtRaw !== null) {
        addNonNegativeLatency(
          taskScheduledToPollLatency,
          pollReceivedAtMs,
          scheduledAtRaw,
        );
      } else {
        missingTaskScheduledTime.add(1);
      }

      const createdAtRaw = firstValidNumber(getTaskInput(task, 'createdAtMs'));

      if (createdAtRaw !== null) {
        addNonNegativeLatency(
          workflowSubmitToPollLatency,
          pollReceivedAtMs,
          createdAtRaw,
        );
      } else {
        missingInputCreatedAtMs.add(1);
      }
    },

    recordWorkflowSubmitToTaskCompleteLatency(task) {
      const createdAtRaw = firstValidNumber(getTaskInput(task, 'createdAtMs'));

      if (createdAtRaw !== null) {
        addNonNegativeLatency(
          workflowSubmitToTaskCompleteLatency,
          Date.now(),
          createdAtRaw,
        );
      }
    },
  };
}

function createProducerScenario(config, client, metrics) {
  return {
    run(setupData) {
      const iterationId =
        `${setupData.testRunId}` +
        `-producer-vu${exec.vu.idInTest}` +
        `-iter${exec.scenario.iterationInTest}`;
      const createdAtMs = Date.now();
      const input = {
        testRunId: setupData.testRunId,
        iterationId,
        createdAtMs,
        failRatio: config.failRatio,
        payload: {
          source: 'k6-tc06',
          retryCount: config.retryCount,
          retryDelaySeconds: config.retryDelaySeconds,
          vu: exec.vu.idInTest,
          iteration: exec.scenario.iterationInTest,
        },
      };

      const res = client.startWorkflow(
        setupData.workflowName,
        setupData.workflowVersion,
        input,
        iterationId,
      );

      if (isSuccessfulWorkflowStart(res)) {
        metrics.addWorkflowStart(res.timings.duration);
        return;
      }

      metrics.addWorkflowStartError(res.timings.duration);
      fail(`Failed to start workflow. status=${res.status}, body=${res.body}`);
    },
  };
}

function createWorkerScenario(config, client, metrics) {
  return {
    run(setupData) {
      const workerId = `${config.workerIdPrefix}-${exec.vu.idInTest}`;
      const pollRes = client.pollTask(setupData.taskType, workerId);
      metrics.addPollAttempt(pollRes.timings.duration);

      const pollResult = parsePollResult(pollRes, setupData.taskType);

      if (pollResult.kind === 'miss') {
        metrics.addPollMiss(pollRes.timings.duration);
        return;
      }

      if (pollResult.kind === 'unexpected_task_type') {
        metrics.addUnexpectedTaskType();
        fail(pollResult.error);
      }

      if (pollResult.kind === 'error') {
        metrics.addPollError();
        fail(pollResult.error);
      }

      const task = pollResult.task;
      metrics.addPollHit(pollRes.timings.duration);
      metrics.recordPollLatencies(task);

      if (Math.random() < config.failRatio) {
        this.failTask(task, workerId);
        return;
      }

      this.completeTask(task, workerId);
    },

    completeTask(task, workerId) {
      const payload = this.buildTaskUpdatePayload(task, workerId, 'COMPLETED');
      const taskType = task.taskType || task.taskDefName || config.taskType;
      const res = client.completeTask(taskType, payload);
      const ok = check(res, {
        'complete task status is 200/204': (r) => isSuccessfulTaskComplete(r),
      });

      if (!ok) {
        metrics.addTaskCompleteFailure(res.timings.duration);
        fail(`Failed to complete task. status=${res.status}, body=${res.body}`);
      }

      metrics.addTaskCompleteSuccess(res.timings.duration, task);
    },

    failTask(task, workerId) {
      const payload = this.buildTaskUpdatePayload(task, workerId, 'FAILED');
      const taskType = task.taskType || task.taskDefName || config.taskType;
      const res = client.completeTask(taskType, payload);
      const ok = check(res, {
        'fail task status is 200/204': (r) => isSuccessfulTaskComplete(r),
      });

      if (!ok) {
        metrics.addTaskFailUpdateFailure(res.timings.duration);
        fail(`Failed to update task as FAILED. status=${res.status}, body=${res.body}`);
      }

      metrics.addTaskFailUpdateSuccess(res.timings.duration);
    },

    buildTaskUpdatePayload(task, workerId, status) {
      const workflowInstanceId = task.workflowInstanceId || task.workflowId;

      if (!workflowInstanceId || !task.taskId) {
        if (status === 'FAILED') {
          metrics.addTaskFailUpdateFailure(0);
        } else {
          metrics.addTaskCompleteFailure(0);
        }
        fail(`Cannot update task. Missing workflowInstanceId or taskId.`);
      }

      const nowMs = Date.now();
      const outputData = {
        testRunId: getTaskInput(task, 'testRunId'),
        iterationId: getTaskInput(task, 'iterationId'),
      };

      if (status === 'FAILED') {
        outputData.failedAtMs = nowMs;
        outputData.injectedFailure = true;
      } else {
        outputData.completedAtMs = nowMs;
      }

      return {
        workflowInstanceId,
        taskId: task.taskId,
        status,
        workerId,
        reasonForIncompletion:
          status === 'FAILED' ? 'TC06 injected failure' : undefined,
        outputData,
      };
    },
  };
}

function buildSummary(config, data) {
  const setupData = data.setup_data || {};
  const metrics = data.metrics || {};
  const workflowsStarted = metricCount(metrics, 'workflows_started');
  const tasksCompleted = metricCount(metrics, 'tasks_completed');
  const tasksFailed = metricCount(metrics, 'tasks_failed');
  const taskAttempts = tasksCompleted + tasksFailed;
  const workflowStartErrors = metricCount(metrics, 'workflow_start_errors');
  const pollErrors = metricCount(metrics, 'poll_errors');
  const completeErrors = metricCount(metrics, 'complete_errors');
  const failUpdateErrors = metricCount(metrics, 'fail_update_errors');
  const errors = metricCount(metrics, 'errors');
  const theoreticalRetryAmplification = computeTheoreticalRetryAmplification(
    config.failRatio,
    config.retryCount,
  );
  const observedRetryAmplification = ratio(taskAttempts, workflowsStarted);
  const actualTaskAttemptRps = ratio(taskAttempts, config.testDurationSeconds);

  const derived = {
    taskAttempts,
    theoreticalRetryAmplification,
    observedRetryAmplification,
    retryAmplificationDelta:
      observedRetryAmplification - theoreticalRetryAmplification,
    tasksCompletedToWorkflowStartedRatio: ratio(tasksCompleted, workflowsStarted),
    tasksFailedToAttemptsRatio: ratio(tasksFailed, taskAttempts),
    actualTaskAttemptRps,
    expectedTaskAttemptRps:
      config.workflowStartRps * theoreticalRetryAmplification,
    isStable:
      errors === 0 &&
      workflowStartErrors === 0 &&
      pollErrors === 0 &&
      completeErrors === 0 &&
      failUpdateErrors === 0 &&
      metricRate(metrics, 'workflow_start_success_rate') >= 0.999 &&
      metricRate(metrics, 'task_complete_success_rate') >= 0.99 &&
      (tasksFailed === 0 ||
        metricRate(metrics, 'task_fail_update_success_rate') >= 0.999),
  };

  return {
    testCase: 'TC06',
    testRunId: setupData.testRunId || config.testRunId,
    baseUrl: config.baseUrl,
    apiPrefix: config.apiPrefix,
    workflowName: setupData.workflowName || config.workflowName,
    taskType: setupData.taskType || config.taskType,
    workflowVersion: setupData.workflowVersion || config.workflowVersion,
    workflowStartRps: config.workflowStartRps,
    pollRps: config.pollRps,
    failRatio: config.failRatio,
    retryCount: config.retryCount,
    retryDelaySeconds: config.retryDelaySeconds,
    testDuration: config.testDuration,
    strictLatencyThreshold: config.strictLatencyThreshold,
    definitionActions: {
      task: setupData.taskDefinitionAction,
      workflow: setupData.workflowDefinitionAction,
    },
    overall: pickMetrics(metrics, METRIC_NAMES),
    derived,
  };
}

function computeTheoreticalRetryAmplification(failRatio, retryCount) {
  let total = 0;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    total += Math.pow(failRatio, attempt);
  }

  return total;
}

function parseDurationSeconds(value) {
  const text = String(value || '');
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);

  if (!match) {
    return 0;
  }

  const amount = Number(match[1]);
  const unit = match[2] || 's';

  if (unit === 'ms') {
    return amount / 1000;
  }

  if (unit === 'm') {
    return amount * 60;
  }

  if (unit === 'h') {
    return amount * 3600;
  }

  return amount;
}

const config = loadConfig(__ENV);
const metrics = createMetrics();
const client = createConductorClient(config);
const definitions = createDefinitionService(
  config,
  client,
  createTc06DefinitionFactory(config),
  createTc06DefinitionValidator(),
);
const producerScenario = createProducerScenario(config, client, metrics);
const workerScenario = createWorkerScenario(config, client, metrics);

export const options = buildOptions(config);

export function setup() {
  const definitionData = definitions.ensureDefinitions();

  return {
    testRunId: config.testRunId,
    workflowName: config.workflowName,
    taskType: config.taskType,
    workflowVersion: config.workflowVersion,
    taskDefinitionAction: definitionData.taskDefinitionAction,
    workflowDefinitionAction: definitionData.workflowDefinitionAction,
  };
}

export function producer(setupData) {
  producerScenario.run(setupData);
}

export function recordSetupMetrics() {
  metrics.addSetupMetrics();
}

export function worker(setupData) {
  workerScenario.run(setupData);
}

export function handleSummary(data) {
  const selected = buildSummary(config, data);

  return {
    stdout: JSON.stringify(selected, null, 2) + '\n',
    'tc06_summary.json': JSON.stringify(selected, null, 2),
    'tc06_raw_summary.json': JSON.stringify(data, null, 2),
  };
}
