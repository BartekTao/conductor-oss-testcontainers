import { check, fail } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

import { createConductorClient, isSuccessfulTaskComplete, isSuccessfulWorkflowStart } from '../lib/conductor.js';
import { createDefinitionService, compareEqual, compareNumber, hasOwn } from '../lib/definitions.js';
import { booleanEnv, numberEnv, requireString, stripTrailingSlash } from '../lib/env.js';
import {
  addNonNegativeLatency,
  buildCompleteTaskPayload,
  firstValidNumber,
  parsePollResult,
} from '../lib/task.js';
import { metricCount, metricRate, pickMetrics, ratio } from '../lib/summary.js';

const METRIC_NAMES = [
  'poll_attempt_latency',
  'poll_hit_latency',
  'poll_miss_latency',
  'task_update_latency',
  'task_scheduled_to_poll_latency',
  'preloaded_workflows',
  'preload_errors',
  'poll_attempts',
  'tasks_polled',
  'tasks_completed',
  'poll_misses',
  'poll_errors',
  'complete_errors',
  'missing_task_scheduled_time',
  'unexpected_task_type',
  'errors',
  'poll_hit_rate',
  'task_complete_success_rate',
  'poll_success_rate',
];

function loadConfig(env) {
  const baseUrl = requireString(stripTrailingSlash(env.BASE_URL || ''), 'BASE_URL');

  return {
    baseUrl,
    apiPrefix: env.API_PREFIX === undefined ? '/api' : env.API_PREFIX,
    workflowName: env.WORKFLOW_NAME || 'wf_perf_tc01_single',
    taskType: env.TASK_TYPE || 'perf_task_tc01_single',
    workflowVersion: numberEnv(env.WORKFLOW_VERSION, 1),
    ownerEmail: env.OWNER_EMAIL || 'perf-test@example.com',
    autoCreateDefinitions: booleanEnv(env.AUTO_CREATE_DEFINITIONS, true),
    failOnDefinitionMismatch: booleanEnv(env.FAIL_ON_DEFINITION_MISMATCH, true),
    preloadWorkflowCount: numberEnv(env.PRELOAD_WORKFLOW_COUNT, 100000),
    preloadBatchSize: numberEnv(env.PRELOAD_BATCH_SIZE, 100),
    preloadMaxInFlightBatches: numberEnv(env.PRELOAD_MAX_IN_FLIGHT_BATCHES, 5),
    preloadReadyMinTasks: numberEnv(env.PRELOAD_READY_MIN_TASKS, 1000),
    preloadReadyTimeoutMs: numberEnv(env.PRELOAD_READY_TIMEOUT_MS, 300000),
    pollRps: numberEnv(env.POLL_RPS, 1000),
    testDuration: env.TEST_DURATION || '5m',
    workerPreAllocatedVUs: numberEnv(env.WORKER_PRE_ALLOCATED_VUS, 200),
    workerMaxVUs: numberEnv(env.WORKER_MAX_VUS, 2000),
    workerIdPrefix: env.WORKER_ID_PREFIX || 'k6-tc01-worker',
    slaPollAttemptP95Ms: numberEnv(env.SLA_POLL_ATTEMPT_P95_MS, 500),
    slaPollHitP95Ms: numberEnv(env.SLA_POLL_HIT_P95_MS, 500),
    slaTaskUpdateP95Ms: numberEnv(env.SLA_TASK_UPDATE_P95_MS, 500),
    slaScheduleToPollP95Ms: numberEnv(env.SLA_SCHEDULE_TO_POLL_P95_MS, 300000),
    maxErrorRate: numberEnv(env.MAX_ERROR_RATE, 0.001),
    strictLatencyThreshold: booleanEnv(env.STRICT_LATENCY_THRESHOLD, false),
    testRunId:
      env.TEST_RUN_ID ||
      `tc01-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  };
}

function buildOptions(config) {
  const thresholds = {
    poll_success_rate: ['rate>=0.99'],
    task_complete_success_rate: ['rate>=0.99'],
    errors: ['count==0'],
  };

  if (config.strictLatencyThreshold) {
    thresholds.poll_success_rate = ['rate>=0.999'];
    thresholds.task_complete_success_rate = ['rate>=0.999'];
    thresholds.poll_attempt_latency = [
      `p(95)<${config.slaPollAttemptP95Ms}`,
    ];
    thresholds.poll_hit_latency = [`p(95)<${config.slaPollHitP95Ms}`];
    thresholds.task_update_latency = [`p(95)<${config.slaTaskUpdateP95Ms}`];
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

function createTc01DefinitionFactory(config) {
  return {
    buildTaskDefinition(taskType) {
      return {
        name: taskType,
        description: 'TC01 preloaded single simple task',
        retryCount: 0,
        retryLogic: 'FIXED',
        retryDelaySeconds: 0,
        timeoutSeconds: 600,
        responseTimeoutSeconds: 300,
        pollTimeoutSeconds: 600,
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
        description: 'TC01 preloaded workflow poll task capacity test',
        version,
        schemaVersion: 2,
        ownerEmail: config.ownerEmail,
        inputParameters: ['testRunId', 'preloadIndex', 'createdAtMs', 'payload'],
        outputParameters: {
          testRunId: '${workflow.input.testRunId}',
          preloadIndex: '${workflow.input.preloadIndex}',
        },
        tasks: [
          {
            name: taskType,
            taskReferenceName: `${taskType}_ref`,
            type: 'SIMPLE',
            inputParameters: {
              testRunId: '${workflow.input.testRunId}',
              preloadIndex: '${workflow.input.preloadIndex}',
              createdAtMs: '${workflow.input.createdAtMs}',
              payload: '${workflow.input.payload}',
            },
          },
        ],
      };
    },
  };
}

function createTc01DefinitionValidator() {
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
        'timeoutSeconds',
        expected.timeoutSeconds,
        existing.timeoutSeconds,
      );
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
      compareEqual(
        mismatches,
        'timeoutPolicy',
        expected.timeoutPolicy,
        existing.timeoutPolicy,
      );

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
      for (const key of ['testRunId', 'preloadIndex', 'createdAtMs']) {
        if (!hasOwn(inputParameters, key)) {
          mismatches.push(`task.inputParameters missing key=${key}`);
        }
      }

      return mismatches;
    },
  };
}

function createMetrics() {
  const pollAttemptLatency = new Trend('poll_attempt_latency', true);
  const pollHitLatency = new Trend('poll_hit_latency', true);
  const pollMissLatency = new Trend('poll_miss_latency', true);
  const taskUpdateLatency = new Trend('task_update_latency', true);
  const taskScheduledToPollLatency = new Trend('task_scheduled_to_poll_latency', true);

  const preloadedWorkflows = new Counter('preloaded_workflows');
  const preloadErrors = new Counter('preload_errors');
  const pollAttempts = new Counter('poll_attempts');
  const tasksPolled = new Counter('tasks_polled');
  const tasksCompleted = new Counter('tasks_completed');
  const pollMisses = new Counter('poll_misses');
  const pollErrors = new Counter('poll_errors');
  const completeErrors = new Counter('complete_errors');
  const missingTaskScheduledTime = new Counter('missing_task_scheduled_time');
  const unexpectedTaskType = new Counter('unexpected_task_type');
  const errors = new Counter('errors');

  const pollHitRate = new Rate('poll_hit_rate');
  const taskCompleteSuccessRate = new Rate('task_complete_success_rate');
  const pollSuccessRate = new Rate('poll_success_rate');

  return {
    addSetupMetrics(preloadedCount, preloadErrorCount) {
      preloadedWorkflows.add(preloadedCount);
      preloadErrors.add(preloadErrorCount);
      pollErrors.add(0);
      completeErrors.add(0);
      missingTaskScheduledTime.add(0);
      unexpectedTaskType.add(0);
      errors.add(preloadErrorCount);
    },

    addPollAttempt(durationMs) {
      pollAttemptLatency.add(durationMs);
      pollAttempts.add(1);
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

    addTaskCompleteSuccess(durationMs) {
      taskUpdateLatency.add(durationMs);
      taskCompleteSuccessRate.add(true);
      tasksCompleted.add(1);
    },

    addTaskCompleteFailure(durationMs) {
      taskUpdateLatency.add(durationMs);
      taskCompleteSuccessRate.add(false);
      completeErrors.add(1);
      errors.add(1);
    },

    recordScheduledToPollLatency(task) {
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
    },
  };
}

function createPreloadService(config, client) {
  return {
    preloadWorkflows() {
      const windowSize = Math.max(
        1,
        config.preloadBatchSize * Math.max(1, config.preloadMaxInFlightBatches),
      );
      let preloaded = 0;
      let preloadErrors = 0;

      console.log(
        `[setup] Preloading workflows. count=${config.preloadWorkflowCount}, ` +
          `batchSize=${config.preloadBatchSize}, ` +
          `maxInFlightBatches=${config.preloadMaxInFlightBatches}`,
      );

      for (
        let startIndex = 1;
        startIndex <= config.preloadWorkflowCount;
        startIndex += windowSize
      ) {
        const endIndex = Math.min(
          config.preloadWorkflowCount,
          startIndex + windowSize - 1,
        );
        const requests = [];

        for (let preloadIndex = startIndex; preloadIndex <= endIndex; preloadIndex++) {
          requests.push(this.buildRequest(preloadIndex));
        }

        const responses = client.batchStartWorkflows(requests);

        for (let i = 0; i < responses.length; i++) {
          const res = responses[i];
          if (isSuccessfulWorkflowStart(res)) {
            preloaded += 1;
          } else {
            preloadErrors += 1;
            throw new Error(
              `[setup] Failed to preload workflow. ` +
                `preloadIndex=${startIndex + i}, status=${res.status}, ` +
                `body=${res.body}`,
            );
          }
        }

        console.log(`[setup] Preloaded ${preloaded}/${config.preloadWorkflowCount}`);
      }

      return {
        preloadedWorkflows: preloaded,
        preloadErrors,
        readyCheck: this.buildReadyCheck(preloaded, preloadErrors),
      };
    },

    buildRequest(preloadIndex) {
      const createdAtMs = Date.now();
      const correlationId = `${config.testRunId}-${preloadIndex}`;
      const input = {
        testRunId: config.testRunId,
        preloadIndex,
        createdAtMs,
        payload: {
          source: 'tc01-preload',
        },
      };

      return client.buildStartWorkflowRequest(
        config.workflowName,
        config.workflowVersion,
        input,
        correlationId,
      );
    },

    buildReadyCheck(preloaded, preloadErrors) {
      return {
        mode: 'preload_success',
        ready: preloaded === config.preloadWorkflowCount && preloadErrors === 0,
        expectedMinTasks: config.preloadReadyMinTasks,
        timeoutMs: config.preloadReadyTimeoutMs,
      };
    },
  };
}

function createWorkerScenario(config, client, metrics) {
  return {
    run() {
      const workerId = this.workerId();
      const pollRes = client.pollTask(config.taskType, workerId);
      metrics.addPollAttempt(pollRes.timings.duration);

      const pollResult = parsePollResult(pollRes, config.taskType);

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
      metrics.recordScheduledToPollLatency(task);
      this.completeTask(task, workerId);
    },

    completeTask(task, workerId) {
      const payload = buildCompleteTaskPayload(task, workerId);

      if (!payload.workflowInstanceId || !payload.taskId) {
        metrics.addTaskCompleteFailure(0);
        fail(`Cannot complete task. Missing workflowInstanceId or taskId.`);
      }

      const taskType = task.taskType || task.taskDefName || config.taskType;
      const res = client.completeTask(taskType, payload);
      const ok = check(res, {
        'complete task status is 200/204': (r) => isSuccessfulTaskComplete(r),
      });

      if (!ok) {
        metrics.addTaskCompleteFailure(res.timings.duration);
        fail(`Failed to complete task. status=${res.status}, body=${res.body}`);
      }

      metrics.addTaskCompleteSuccess(res.timings.duration);
    },

    workerId() {
      return `${config.workerIdPrefix}-${exec.vu.idInTest}`;
    },
  };
}

function buildSummary(config, data) {
  const setupData = data.setup_data || {};
  const metrics = data.metrics || {};
  const pollAttempts = metricCount(metrics, 'poll_attempts');
  const tasksPolled = metricCount(metrics, 'tasks_polled');
  const tasksCompleted = metricCount(metrics, 'tasks_completed');
  const pollMisses = metricCount(metrics, 'poll_misses');
  const errors = metricCount(metrics, 'errors');
  const pollErrors = metricCount(metrics, 'poll_errors');
  const completeErrors = metricCount(metrics, 'complete_errors');

  const derived = {
    taskCompletedToPollAttemptRatio: ratio(tasksCompleted, pollAttempts),
    taskCompletedToTaskPolledRatio: ratio(tasksCompleted, tasksPolled),
    pollMissRatio: ratio(pollMisses, pollAttempts),
    isStable:
      errors === 0 &&
      pollErrors === 0 &&
      completeErrors === 0 &&
      metricRate(metrics, 'poll_success_rate') >= 0.99 &&
      metricRate(metrics, 'task_complete_success_rate') >= 0.99,
  };

  return {
    testCase: 'TC01',
    testRunId: setupData.testRunId || config.testRunId,
    baseUrl: config.baseUrl,
    apiPrefix: config.apiPrefix,
    workflowName: setupData.workflowName || config.workflowName,
    taskType: setupData.taskType || config.taskType,
    workflowVersion: setupData.workflowVersion || config.workflowVersion,
    preloadWorkflowCount:
      setupData.preloadWorkflowCount || config.preloadWorkflowCount,
    pollRps: config.pollRps,
    testDuration: config.testDuration,
    strictLatencyThreshold: config.strictLatencyThreshold,
    readyCheck: setupData.readyCheck || null,
    metrics: pickMetrics(metrics, METRIC_NAMES),
    derived,
  };
}

const config = loadConfig(__ENV);
const metrics = createMetrics();
const client = createConductorClient(config);
const definitions = createDefinitionService(
  config,
  client,
  createTc01DefinitionFactory(config),
  createTc01DefinitionValidator(),
);
const preload = createPreloadService(config, client);
const workerScenario = createWorkerScenario(config, client, metrics);

export const options = buildOptions(config);

export function setup() {
  const definitionData = definitions.ensureDefinitions();
  const preloadData = preload.preloadWorkflows();

  return {
    testRunId: config.testRunId,
    workflowName: config.workflowName,
    taskType: config.taskType,
    workflowVersion: config.workflowVersion,
    preloadWorkflowCount: config.preloadWorkflowCount,
    taskDefinitionAction: definitionData.taskDefinitionAction,
    workflowDefinitionAction: definitionData.workflowDefinitionAction,
    preloadedWorkflows: preloadData.preloadedWorkflows,
    preloadErrors: preloadData.preloadErrors,
    readyCheck: preloadData.readyCheck,
  };
}

export function recordSetupMetrics(setupData) {
  metrics.addSetupMetrics(
    Number(setupData.preloadedWorkflows || 0),
    Number(setupData.preloadErrors || 0),
  );
}

export function worker() {
  workerScenario.run();
}

export function handleSummary(data) {
  const selected = buildSummary(config, data);

  return {
    stdout: JSON.stringify(selected, null, 2) + '\n',
    'tc01_summary.json': JSON.stringify(selected, null, 2),
    'tc01_raw_summary.json': JSON.stringify(data, null, 2),
  };
}
