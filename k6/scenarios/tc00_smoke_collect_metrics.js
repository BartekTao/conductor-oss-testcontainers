import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

import {
  createConductorClient,
  isSuccessfulTaskComplete,
  parseWorkflowId,
  safeJson,
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
} from '../lib/task.js';
import { pickMetrics } from '../lib/summary.js';

const METRIC_NAMES = [
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
];

const TERMINAL_FAILURE_STATUSES = ['FAILED', 'TIMED_OUT', 'TERMINATED'];

function loadConfig(env) {
  const baseUrl = requireString(stripTrailingSlash(env.BASE_URL || ''), 'BASE_URL');

  return {
    baseUrl,
    apiPrefix: env.API_PREFIX === undefined ? '/api' : env.API_PREFIX,
    workflowName: env.WORKFLOW_NAME || 'wf_perf_single_hot',
    taskType: env.TASK_TYPE || 'perf_task_hot',
    workflowVersion: numberEnv(env.WORKFLOW_VERSION, 1),
    ownerEmail: env.OWNER_EMAIL || 'perf-test@example.com',
    autoCreateDefinitions: booleanEnv(env.AUTO_CREATE_DEFINITIONS, true),
    failOnDefinitionMismatch: booleanEnv(env.FAIL_ON_DEFINITION_MISMATCH, true),
    vus: numberEnv(env.VUS, 1),
    iterations: numberEnv(env.ITERATIONS, 10),
    maxPollAttempts: numberEnv(env.MAX_POLL_ATTEMPTS, 60),
    pollSleepMs: numberEnv(env.POLL_SLEEP_MS, 200),
    workflowWaitTimeoutMs: numberEnv(env.WORKFLOW_WAIT_TIMEOUT_MS, 30000),
    strictWorkflowMatch: booleanEnv(env.STRICT_WORKFLOW_MATCH, true),
    testRunId:
      env.TEST_RUN_ID ||
      `tc00-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    workerIdPrefix: env.WORKER_ID_PREFIX || 'k6-tc00-worker',
  };
}

function buildOptions(config) {
  return {
    scenarios: {
      tc00_smoke: {
        executor: 'shared-iterations',
        vus: config.vus,
        iterations: config.iterations,
        maxDuration: '5m',
      },
    },
    thresholds: {
      workflow_success_rate: ['rate>=0.99'],
      errors: ['count==0'],
    },
  };
}

function createTc00DefinitionFactory(config) {
  return {
    buildTaskDefinition(taskType) {
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
        ownerEmail: config.ownerEmail,
        inputKeys: [],
        outputKeys: [],
        inputTemplate: {},
      };
    },

    buildWorkflowDefinition(workflowName, taskType, version) {
      return {
        name: workflowName,
        description: 'K6 TC00 smoke workflow for Conductor capacity test',
        version,
        schemaVersion: 2,
        ownerEmail: config.ownerEmail,
        inputParameters: ['testRunId', 'iterationId', 'createdAtMs', 'payload'],
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
    },
  };
}

function createTc00DefinitionValidator() {
  return {
    validateTaskDefinition(existing, expected) {
      const mismatches = [];

      if (!existing) {
        return ['Existing task definition response is empty'];
      }

      compareEqual(mismatches, 'name', expected.name, existing.name);
      compareNumber(mismatches, 'timeoutSeconds', expected.timeoutSeconds, existing.timeoutSeconds);
      compareNumber(
        mismatches,
        'responseTimeoutSeconds',
        expected.responseTimeoutSeconds,
        existing.responseTimeoutSeconds,
      );
      compareNumber(mismatches, 'retryCount', expected.retryCount, existing.retryCount);

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
      for (const key of ['testRunId', 'iterationId', 'createdAtMs']) {
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
  const workflowGetLatency = new Trend('workflow_get_latency', true);
  const workflowE2ELatency = new Trend('workflow_e2e_latency', true);
  const taskScheduledToPollLatency = new Trend('task_scheduled_to_poll_latency', true);
  const workflowSubmitToPollLatency = new Trend('workflow_submit_to_poll_latency', true);

  const workflowsStarted = new Counter('workflows_started');
  const tasksPolled = new Counter('tasks_polled');
  const tasksCompleted = new Counter('tasks_completed');
  const pollMisses = new Counter('poll_misses');
  const missingTaskScheduledTime = new Counter('missing_task_scheduled_time');
  const missingInputCreatedAtMs = new Counter('missing_input_created_at_ms');
  const unexpectedWorkflowTask = new Counter('unexpected_workflow_task');
  const errors = new Counter('errors');

  const workflowSuccessRate = new Rate('workflow_success_rate');
  const pollHitRate = new Rate('poll_hit_rate');

  return {
    addError() {
      errors.add(1);
    },

    addWorkflowStart(durationMs) {
      workflowStartLatency.add(durationMs);
      workflowsStarted.add(1);
    },

    addPollAttempt(durationMs) {
      pollAttemptLatency.add(durationMs);
    },

    addPollHit(durationMs) {
      pollHitLatency.add(durationMs);
      pollHitRate.add(true);
      tasksPolled.add(1);
    },

    addPollMiss(durationMs) {
      pollMissLatency.add(durationMs);
      pollMisses.add(1);
      pollHitRate.add(false);
    },

    addTaskUpdate(durationMs) {
      taskUpdateLatency.add(durationMs);
      tasksCompleted.add(1);
    },

    addWorkflowGet(durationMs) {
      workflowGetLatency.add(durationMs);
    },

    addWorkflowCompleted(createdAtMs) {
      workflowE2ELatency.add(Date.now() - createdAtMs);
      workflowSuccessRate.add(true);
    },

    addWorkflowFailed() {
      workflowSuccessRate.add(false);
      errors.add(1);
    },

    addUnexpectedWorkflowTask() {
      unexpectedWorkflowTask.add(1);
      errors.add(1);
    },

    recordPollLatency(task) {
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

      const createdAtRaw = firstValidNumber(
        getTaskInput(task, 'createdAtMs'),
        getTaskInput(task, 'workflowCreatedAtMs'),
      );

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
  };
}

function createSmokeScenario(config, client, metrics) {
  return {
    run(setupData) {
      const context = this.createIterationContext(setupData);
      const workflowId = this.startWorkflow(context);
      const task = this.pollUntilHit(context, workflowId);

      this.completeTask(task, context.workerId);
      this.waitWorkflowCompleted(workflowId, context.createdAtMs);
    },

    createIterationContext(setupData) {
      const iterationId =
        `${setupData.testRunId}` +
        `-vu${exec.vu.idInTest}` +
        `-iter${exec.scenario.iterationInTest}`;
      const createdAtMs = Date.now();

      return {
        testRunId: setupData.testRunId,
        workflowName: setupData.workflowName,
        taskType: setupData.taskType,
        iterationId,
        createdAtMs,
        workerId: `${config.workerIdPrefix}-${exec.vu.idInTest}`,
        input: {
          testRunId: setupData.testRunId,
          iterationId,
          createdAtMs,
          payload: {
            source: 'k6-tc00',
            vu: exec.vu.idInTest,
            iteration: exec.scenario.iterationInTest,
          },
        },
      };
    },

    startWorkflow(context) {
      const res = client.startWorkflow(
        context.workflowName,
        config.workflowVersion,
        context.input,
        context.iterationId,
      );

      metrics.addWorkflowStart(res.timings.duration);

      const ok = check(res, {
        'start workflow status is 200/202': (r) => r.status === 200 || r.status === 202,
        'start workflow has body': (r) => !!r.body && r.body.length > 0,
      });

      if (!ok) {
        metrics.addError();
        fail(`Failed to start workflow. status=${res.status}, body=${res.body}`);
      }

      const workflowId = parseWorkflowId(res);

      if (!workflowId) {
        metrics.addError();
        fail(`Cannot parse workflowId. status=${res.status}, body=${res.body}`);
      }

      return workflowId;
    },

    pollUntilHit(context, expectedWorkflowId) {
      for (let attempt = 0; attempt < config.maxPollAttempts; attempt++) {
        const res = client.pollTask(context.taskType, context.workerId);
        metrics.addPollAttempt(res.timings.duration);

        if (isPollHit(res)) {
          return this.handlePollHit(res, expectedWorkflowId);
        }

        this.handlePollMiss(res);
      }

      metrics.addError();
      fail(
        `Poll timeout. taskType=${context.taskType}, ` +
          `maxAttempts=${config.maxPollAttempts}`,
      );
    },

    handlePollHit(res, expectedWorkflowId) {
      metrics.addPollHit(res.timings.duration);

      const task = safeJson(res);

      if (!task || !task.taskId) {
        metrics.addError();
        fail(`Poll hit but task body is invalid. status=${res.status}, body=${res.body}`);
      }

      this.assertWorkflowMatch(task, expectedWorkflowId);
      metrics.recordPollLatency(task);

      return task;
    },

    assertWorkflowMatch(task, expectedWorkflowId) {
      if (
        config.strictWorkflowMatch &&
        task.workflowInstanceId &&
        task.workflowInstanceId !== expectedWorkflowId
      ) {
        metrics.addUnexpectedWorkflowTask();
        fail(
          `Polled task belongs to another workflow. ` +
            `expected=${expectedWorkflowId}, actual=${task.workflowInstanceId}`,
        );
      }
    },

    handlePollMiss(res) {
      metrics.addPollMiss(res.timings.duration);
      check(res, {
        'poll miss status is acceptable': (r) =>
          r.status === 200 || r.status === 204 || r.status === 404,
      });
      sleep(config.pollSleepMs / 1000);
    },

    completeTask(task, workerId) {
      const workflowInstanceId = task.workflowInstanceId || task.workflowId;

      if (!workflowInstanceId || !task.taskId) {
        metrics.addError();
        fail(`Cannot complete task. Missing workflowInstanceId or taskId.`);
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
      const taskType = task.taskType || task.taskDefName || config.taskType;
      const res = client.completeTask(taskType, payload);
      const ok = check(res, {
        'complete task status is 200/204': (r) => isSuccessfulTaskComplete(r),
      });

      if (!ok) {
        metrics.addError();
        fail(`Failed to complete task. status=${res.status}, body=${res.body}`);
      }

      metrics.addTaskUpdate(res.timings.duration);
    },

    waitWorkflowCompleted(workflowId, createdAtMs) {
      const deadline = Date.now() + config.workflowWaitTimeoutMs;

      while (Date.now() < deadline) {
        const res = client.getWorkflow(workflowId);
        metrics.addWorkflowGet(res.timings.duration);

        if (res.status === 200) {
          const workflow = safeJson(res);
          const status = workflow && workflow.status;

          if (status === 'COMPLETED') {
            metrics.addWorkflowCompleted(createdAtMs);
            return;
          }

          if (TERMINAL_FAILURE_STATUSES.indexOf(status) >= 0) {
            metrics.addWorkflowFailed();
            fail(
              `Workflow reached non-success terminal status. ` +
                `workflowId=${workflowId}, status=${status}`,
            );
          }
        }

        sleep(0.2);
      }

      metrics.addWorkflowFailed();
      fail(`Workflow wait timeout. workflowId=${workflowId}`);
    },
  };
}

function isPollHit(res) {
  const body = (res.body || '').trim();
  return res.status === 200 && body !== '' && body !== 'null';
}

function buildSummary(config, data) {
  const setupData = data.setup_data || {};

  return {
    testRunId: setupData.testRunId || config.testRunId,
    baseUrl: config.baseUrl,
    apiPrefix: config.apiPrefix,
    workflowName: setupData.workflowName || config.workflowName,
    taskType: setupData.taskType || config.taskType,
    workflowVersion: setupData.workflowVersion || config.workflowVersion,
    vus: config.vus,
    iterations: config.iterations,
    strictWorkflowMatch: config.strictWorkflowMatch,
    autoCreateDefinitions: config.autoCreateDefinitions,
    failOnDefinitionMismatch: config.failOnDefinitionMismatch,
    metrics: pickMetrics(data.metrics, METRIC_NAMES),
  };
}

const config = loadConfig(__ENV);
const metrics = createMetrics();
const client = createConductorClient(config);
const definitions = createDefinitionService(
  config,
  client,
  createTc00DefinitionFactory(config),
  createTc00DefinitionValidator(),
);
const scenario = createSmokeScenario(config, client, metrics);

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

export default function (setupData) {
  scenario.run(setupData);
}

export function handleSummary(data) {
  const selected = buildSummary(config, data);

  return {
    stdout: JSON.stringify(selected, null, 2) + '\n',
    'tc00_summary.json': JSON.stringify(selected, null, 2),
    'tc00_raw_summary.json': JSON.stringify(data, null, 2),
  };
}
