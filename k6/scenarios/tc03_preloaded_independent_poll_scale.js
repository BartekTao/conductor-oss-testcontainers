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
  'poll_success_rate',
  'task_complete_success_rate',
];

function loadConfig(env) {
  const baseUrl = requireString(stripTrailingSlash(env.BASE_URL || ''), 'BASE_URL');
  const maxPairCount = numberEnv(env.MAX_PAIR_COUNT, 16);
  const pairCount = numberEnv(env.PAIR_COUNT, 4);
  const pairPollRps = numberEnv(env.PAIR_POLL_RPS, 300);
  const pairPreloadWorkflowCount = numberEnv(
    env.PAIR_PRELOAD_WORKFLOW_COUNT,
    108000,
  );

  if (pairCount < 1) {
    throw new Error('PAIR_COUNT must be >= 1');
  }

  if (pairCount > maxPairCount) {
    throw new Error(
      `PAIR_COUNT must be <= MAX_PAIR_COUNT. ` +
        `PAIR_COUNT=${pairCount}, MAX_PAIR_COUNT=${maxPairCount}`,
    );
  }

  if (pairPollRps < 1) {
    throw new Error('PAIR_POLL_RPS must be >= 1');
  }

  if (pairPreloadWorkflowCount < 1) {
    throw new Error('PAIR_PRELOAD_WORKFLOW_COUNT must be >= 1');
  }

  const singlePairBaselineCompletedRps = numberEnv(
    env.TC01_SINGLE_PAIR_STABLE_TASK_COMPLETED_RPS,
    pairPollRps,
  );

  const config = {
    baseUrl,
    apiPrefix: env.API_PREFIX === undefined ? '/api' : env.API_PREFIX,
    workflowPrefix: env.WORKFLOW_PREFIX || 'wf_perf_tc03',
    taskPrefix: env.TASK_PREFIX || 'perf_task_tc03',
    workflowVersion: numberEnv(env.WORKFLOW_VERSION, 1),
    ownerEmail: env.OWNER_EMAIL || 'perf-test@example.com',
    autoCreateDefinitions: booleanEnv(env.AUTO_CREATE_DEFINITIONS, true),
    failOnDefinitionMismatch: booleanEnv(env.FAIL_ON_DEFINITION_MISMATCH, true),
    maxPairCount,
    pairCount,
    pairPreloadWorkflowCount,
    preloadBatchSize: numberEnv(env.PRELOAD_BATCH_SIZE, 100),
    preloadMaxInFlightBatches: numberEnv(env.PRELOAD_MAX_IN_FLIGHT_BATCHES, 5),
    pairPollRps,
    testDuration: env.TEST_DURATION || '5m',
    pairWorkerPreAllocatedVUs: numberEnv(env.PAIR_WORKER_PRE_ALLOCATED_VUS, 50),
    pairWorkerMaxVUs: numberEnv(env.PAIR_WORKER_MAX_VUS, 500),
    workerIdPrefix: env.WORKER_ID_PREFIX || 'k6-tc03-worker',
    singlePairBaselineCompletedRps,
    slaPollAttemptP95Ms: numberEnv(env.SLA_POLL_ATTEMPT_P95_MS, 500),
    slaPollHitP95Ms: numberEnv(env.SLA_POLL_HIT_P95_MS, 500),
    slaTaskUpdateP95Ms: numberEnv(env.SLA_TASK_UPDATE_P95_MS, 500),
    slaScheduleToPollP95Ms: numberEnv(env.SLA_SCHEDULE_TO_POLL_P95_MS, 300000),
    maxErrorRate: numberEnv(env.MAX_ERROR_RATE, 0.001),
    strictLatencyThreshold: booleanEnv(env.STRICT_LATENCY_THRESHOLD, false),
    testRunId:
      env.TEST_RUN_ID ||
      `tc03-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  };

  config.allPairs = buildPairs(config, config.maxPairCount);
  config.activePairs = config.allPairs.slice(0, config.pairCount);
  config.totalPreloadWorkflowCount =
    config.pairCount * config.pairPreloadWorkflowCount;
  config.expectedTotalPollRps = config.pairCount * config.pairPollRps;
  config.testDurationSeconds = parseDurationSeconds(config.testDuration);

  return config;
}

function buildPairs(config, count) {
  const pairs = [];

  for (let index = 1; index <= count; index++) {
    const pairId = pad3(index);
    pairs.push({
      pairId,
      workflowName: `${config.workflowPrefix}_${pairId}`,
      taskType: `${config.taskPrefix}_${pairId}`,
    });
  }

  return pairs;
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

  const scenarios = {
    setup_metrics: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '30s',
      exec: 'recordSetupMetrics',
    },
  };

  for (const pair of config.activePairs) {
    scenarios[`worker_pair_${pair.pairId}`] = {
      executor: 'constant-arrival-rate',
      rate: config.pairPollRps,
      timeUnit: '1s',
      duration: config.testDuration,
      preAllocatedVUs: config.pairWorkerPreAllocatedVUs,
      maxVUs: config.pairWorkerMaxVUs,
      startTime: '1s',
      exec: 'worker',
      env: {
        PAIR_ID: pair.pairId,
      },
      tags: pairTags(pair),
    };
  }

  return { scenarios, thresholds };
}

function createTc03DefinitionFactory(config, pair) {
  return {
    buildTaskDefinition(taskType) {
      return {
        name: taskType,
        description: `TC03 preloaded independent simple task ${pair.pairId}`,
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
        description: `TC03 preloaded independent workflow ${pair.pairId}`,
        version,
        schemaVersion: 2,
        ownerEmail: config.ownerEmail,
        inputParameters: [
          'testRunId',
          'pairId',
          'preloadIndex',
          'createdAtMs',
          'payload',
        ],
        outputParameters: {
          testRunId: '${workflow.input.testRunId}',
          pairId: '${workflow.input.pairId}',
          preloadIndex: '${workflow.input.preloadIndex}',
        },
        tasks: [
          {
            name: taskType,
            taskReferenceName: `${taskType}_ref`,
            type: 'SIMPLE',
            inputParameters: {
              testRunId: '${workflow.input.testRunId}',
              pairId: '${workflow.input.pairId}',
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

function createTc03DefinitionValidator() {
  return {
    validateTaskDefinition(existing, expected) {
      const mismatches = [];

      if (!existing) {
        return ['Existing task definition response is empty'];
      }

      compareEqual(mismatches, 'name', expected.name, existing.name);
      compareNumber(mismatches, 'retryCount', expected.retryCount, existing.retryCount);
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
      for (const key of ['testRunId', 'pairId', 'preloadIndex', 'createdAtMs']) {
        if (!hasOwn(inputParameters, key)) {
          mismatches.push(`task.inputParameters missing key=${key}`);
        }
      }

      return mismatches;
    },
  };
}

function createMetrics(config) {
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
  const pollSuccessRate = new Rate('poll_success_rate');
  const taskCompleteSuccessRate = new Rate('task_complete_success_rate');

  const perPair = {};
  for (const pair of config.activePairs) {
    perPair[pair.pairId] = {
      preloadedWorkflows: new Counter(`tc03_pair_${pair.pairId}_preloaded_workflows`),
      preloadErrors: new Counter(`tc03_pair_${pair.pairId}_preload_errors`),
      pollAttempts: new Counter(`tc03_pair_${pair.pairId}_poll_attempts`),
      tasksPolled: new Counter(`tc03_pair_${pair.pairId}_tasks_polled`),
      tasksCompleted: new Counter(`tc03_pair_${pair.pairId}_tasks_completed`),
      pollMisses: new Counter(`tc03_pair_${pair.pairId}_poll_misses`),
      pollErrors: new Counter(`tc03_pair_${pair.pairId}_poll_errors`),
      completeErrors: new Counter(`tc03_pair_${pair.pairId}_complete_errors`),
      taskUpdateLatency: new Trend(`tc03_pair_${pair.pairId}_task_update_latency`, true),
      scheduleToPollLatency: new Trend(
        `tc03_pair_${pair.pairId}_task_scheduled_to_poll_latency`,
        true,
      ),
      pollSuccessRate: new Rate(`tc03_pair_${pair.pairId}_poll_success_rate`),
      taskCompleteSuccessRate: new Rate(
        `tc03_pair_${pair.pairId}_task_complete_success_rate`,
      ),
    };
  }

  return {
    addSetupMetrics(setupData) {
      for (const pairResult of setupData.preloadResults || []) {
        const pair = pairById(config, pairResult.pairId);
        const tags = pairTags(pair);
        const pairMetrics = perPair[pairResult.pairId];
        preloadedWorkflows.add(pairResult.preloadedWorkflows, tags);
        preloadErrors.add(pairResult.preloadErrors, tags);
        pollErrors.add(0, tags);
        completeErrors.add(0, tags);
        missingTaskScheduledTime.add(0, tags);
        unexpectedTaskType.add(0, tags);
        errors.add(pairResult.preloadErrors, tags);

        pairMetrics.preloadedWorkflows.add(pairResult.preloadedWorkflows);
        pairMetrics.preloadErrors.add(pairResult.preloadErrors);
        pairMetrics.pollErrors.add(0);
        pairMetrics.completeErrors.add(0);
      }
    },

    addPollAttempt(pair, durationMs) {
      const tags = pairTags(pair);
      pollAttemptLatency.add(durationMs, tags);
      pollAttempts.add(1, tags);
      perPair[pair.pairId].pollAttempts.add(1);
    },

    addPollHit(pair, durationMs) {
      const tags = pairTags(pair);
      pollHitLatency.add(durationMs, tags);
      pollHitRate.add(true, tags);
      pollSuccessRate.add(true, tags);
      tasksPolled.add(1, tags);
      perPair[pair.pairId].tasksPolled.add(1);
      perPair[pair.pairId].pollSuccessRate.add(true);
    },

    addPollMiss(pair, durationMs) {
      const tags = pairTags(pair);
      pollMissLatency.add(durationMs, tags);
      pollHitRate.add(false, tags);
      pollSuccessRate.add(true, tags);
      pollMisses.add(1, tags);
      perPair[pair.pairId].pollMisses.add(1);
      perPair[pair.pairId].pollSuccessRate.add(true);
    },

    addPollError(pair) {
      const tags = pairTags(pair);
      pollSuccessRate.add(false, tags);
      pollErrors.add(1, tags);
      errors.add(1, tags);
      perPair[pair.pairId].pollErrors.add(1);
      perPair[pair.pairId].pollSuccessRate.add(false);
    },

    addUnexpectedTaskType(pair) {
      const tags = pairTags(pair);
      unexpectedTaskType.add(1, tags);
      this.addPollError(pair);
    },

    addTaskCompleteSuccess(pair, durationMs) {
      const tags = pairTags(pair);
      taskUpdateLatency.add(durationMs, tags);
      taskCompleteSuccessRate.add(true, tags);
      tasksCompleted.add(1, tags);
      perPair[pair.pairId].taskUpdateLatency.add(durationMs);
      perPair[pair.pairId].taskCompleteSuccessRate.add(true);
      perPair[pair.pairId].tasksCompleted.add(1);
    },

    addTaskCompleteFailure(pair, durationMs) {
      const tags = pairTags(pair);
      taskUpdateLatency.add(durationMs, tags);
      taskCompleteSuccessRate.add(false, tags);
      completeErrors.add(1, tags);
      errors.add(1, tags);
      perPair[pair.pairId].taskUpdateLatency.add(durationMs);
      perPair[pair.pairId].taskCompleteSuccessRate.add(false);
      perPair[pair.pairId].completeErrors.add(1);
    },

    recordScheduledToPollLatency(pair, task) {
      const pollReceivedAtMs = Date.now();
      const scheduledAtRaw = firstValidNumber(
        task.scheduledTime,
        task.scheduledTimeMs,
        task.scheduledTimeInMs,
      );

      if (scheduledAtRaw !== null) {
        const tags = pairTags(pair);
        addNonNegativeLatency(
          taskScheduledToPollLatency,
          pollReceivedAtMs,
          scheduledAtRaw,
          tags,
        );
        addNonNegativeLatency(
          perPair[pair.pairId].scheduleToPollLatency,
          pollReceivedAtMs,
          scheduledAtRaw,
        );
      } else {
        missingTaskScheduledTime.add(1, pairTags(pair));
      }
    },
  };
}

function createSetupService(config, client) {
  const validator = createTc03DefinitionValidator();

  return {
    ensureDefinitions() {
      const results = [];
      for (const pair of config.allPairs) {
        const pairConfig = {
          ...config,
          workflowName: pair.workflowName,
          taskType: pair.taskType,
        };
        const definitions = createDefinitionService(
          pairConfig,
          client,
          createTc03DefinitionFactory(config, pair),
          validator,
        );
        const result = definitions.ensureDefinitions();
        results.push({
          pairId: pair.pairId,
          workflowName: pair.workflowName,
          taskType: pair.taskType,
          taskDefinitionAction: result.taskDefinitionAction,
          workflowDefinitionAction: result.workflowDefinitionAction,
        });
      }

      return results;
    },

    preloadActivePairs() {
      const results = [];

      for (const pair of config.activePairs) {
        results.push(this.preloadPair(pair));
      }

      return results;
    },

    preloadPair(pair) {
      const windowSize = Math.max(
        1,
        config.preloadBatchSize * Math.max(1, config.preloadMaxInFlightBatches),
      );
      let preloaded = 0;
      let preloadErrors = 0;

      console.log(
        `[setup] Preloading pair=${pair.pairId}, workflow=${pair.workflowName}, ` +
          `count=${config.pairPreloadWorkflowCount}`,
      );

      for (
        let startIndex = 1;
        startIndex <= config.pairPreloadWorkflowCount;
        startIndex += windowSize
      ) {
        const endIndex = Math.min(
          config.pairPreloadWorkflowCount,
          startIndex + windowSize - 1,
        );
        const requests = [];

        for (let preloadIndex = startIndex; preloadIndex <= endIndex; preloadIndex++) {
          requests.push(this.buildPreloadRequest(pair, preloadIndex));
        }

        const responses = client.batchStartWorkflows(requests);

        for (let i = 0; i < responses.length; i++) {
          const res = responses[i];
          if (isSuccessfulWorkflowStart(res)) {
            preloaded += 1;
          } else {
            preloadErrors += 1;
            throw new Error(
              `[setup] Failed to preload TC03 workflow. ` +
                `pairId=${pair.pairId}, preloadIndex=${startIndex + i}, ` +
                `status=${res.status}, body=${res.body}`,
            );
          }
        }

        console.log(
          `[setup] Preloaded pair=${pair.pairId} ` +
            `${preloaded}/${config.pairPreloadWorkflowCount}`,
        );
      }

      return {
        pairId: pair.pairId,
        workflowName: pair.workflowName,
        taskType: pair.taskType,
        preloadedWorkflows: preloaded,
        preloadErrors,
        ready: preloaded === config.pairPreloadWorkflowCount && preloadErrors === 0,
      };
    },

    buildPreloadRequest(pair, preloadIndex) {
      const createdAtMs = Date.now();
      const correlationId = `${config.testRunId}-${pair.pairId}-${preloadIndex}`;
      const input = {
        testRunId: config.testRunId,
        pairId: pair.pairId,
        preloadIndex,
        createdAtMs,
        payload: {
          source: 'tc03-preload',
        },
      };

      return client.buildStartWorkflowRequest(
        pair.workflowName,
        config.workflowVersion,
        input,
        correlationId,
      );
    },
  };
}

function createWorkerScenario(config, client, metrics) {
  return {
    run() {
      const pair = pairById(config, __ENV.PAIR_ID);
      const workerId = this.workerId(pair);
      const pollRes = client.pollTask(pair.taskType, workerId);
      metrics.addPollAttempt(pair, pollRes.timings.duration);

      const pollResult = parsePollResult(pollRes, pair.taskType);

      if (pollResult.kind === 'miss') {
        metrics.addPollMiss(pair, pollRes.timings.duration);
        return;
      }

      if (pollResult.kind === 'unexpected_task_type') {
        metrics.addUnexpectedTaskType(pair);
        fail(pollResult.error);
      }

      if (pollResult.kind === 'error') {
        metrics.addPollError(pair);
        fail(pollResult.error);
      }

      const task = pollResult.task;
      metrics.addPollHit(pair, pollRes.timings.duration);
      metrics.recordScheduledToPollLatency(pair, task);
      this.completeTask(pair, task, workerId);
    },

    completeTask(pair, task, workerId) {
      const payload = buildCompleteTaskPayload(task, workerId);

      if (!payload.workflowInstanceId || !payload.taskId) {
        metrics.addTaskCompleteFailure(pair, 0);
        fail(`Cannot complete task. Missing workflowInstanceId or taskId.`);
      }

      const taskType = task.taskType || task.taskDefName || pair.taskType;
      const res = client.completeTask(taskType, payload);
      const ok = check(res, {
        'complete task status is 200/204': (r) => isSuccessfulTaskComplete(r),
      });

      if (!ok) {
        metrics.addTaskCompleteFailure(pair, res.timings.duration);
        fail(`Failed to complete task. status=${res.status}, body=${res.body}`);
      }

      metrics.addTaskCompleteSuccess(pair, res.timings.duration);
    },

    workerId(pair) {
      return `${config.workerIdPrefix}-${pair.pairId}-${exec.vu.idInTest}`;
    },
  };
}

function buildSummary(config, data) {
  const setupData = data.setup_data || {};
  const metrics = data.metrics || {};
  const tasksCompleted = metricCount(metrics, 'tasks_completed');
  const pollAttempts = metricCount(metrics, 'poll_attempts');
  const tasksPolled = metricCount(metrics, 'tasks_polled');
  const pollMisses = metricCount(metrics, 'poll_misses');
  const errors = metricCount(metrics, 'errors');
  const pollErrors = metricCount(metrics, 'poll_errors');
  const completeErrors = metricCount(metrics, 'complete_errors');
  const preloadedWorkflows = metricCount(metrics, 'preloaded_workflows');
  const preloadErrors = metricCount(metrics, 'preload_errors');
  const actualTaskCompletedRps = ratio(tasksCompleted, config.testDurationSeconds);
  const scalingEfficiency = ratio(
    actualTaskCompletedRps,
    config.pairCount * config.singlePairBaselineCompletedRps,
  );

  const derived = {
    actualTaskCompletedRps,
    taskCompletedToPollAttemptRatio: ratio(tasksCompleted, pollAttempts),
    taskCompletedToTaskPolledRatio: ratio(tasksCompleted, tasksPolled),
    pollMissRatio: ratio(pollMisses, pollAttempts),
    scalingEfficiency,
    isStable:
      errors === 0 &&
      pollErrors === 0 &&
      completeErrors === 0 &&
      preloadErrors === 0 &&
      metricRate(metrics, 'poll_success_rate') >= 0.99 &&
      metricRate(metrics, 'task_complete_success_rate') >= 0.99 &&
      scalingEfficiency >= 0.75,
  };

  return {
    testCase: 'TC03',
    testRunId: setupData.testRunId || config.testRunId,
    baseUrl: config.baseUrl,
    apiPrefix: config.apiPrefix,
    pairCount: config.pairCount,
    maxPairCount: config.maxPairCount,
    pairPreloadWorkflowCount: config.pairPreloadWorkflowCount,
    totalPreloadWorkflowCount: config.totalPreloadWorkflowCount,
    pairPollRps: config.pairPollRps,
    expectedTotalPollRps: config.expectedTotalPollRps,
    testDuration: config.testDuration,
    singlePairBaselineCompletedRps: config.singlePairBaselineCompletedRps,
    strictLatencyThreshold: config.strictLatencyThreshold,
    activePairs: setupData.activePairs || config.activePairs,
    overall: pickMetrics(metrics, METRIC_NAMES),
    derived,
    perPair: buildPerPairSummary(config, metrics, setupData),
    setup: {
      preloadedWorkflows,
      preloadErrors,
      definitionResults: setupData.definitionResults || [],
      preloadResults: setupData.preloadResults || [],
    },
  };
}

function buildPerPairSummary(config, metrics, setupData) {
  const preloadByPair = {};
  for (const result of setupData.preloadResults || []) {
    preloadByPair[result.pairId] = result;
  }

  return config.activePairs.map((pair) => {
    const prefix = `tc03_pair_${pair.pairId}`;
    const tasksPolled = metricCount(metrics, `${prefix}_tasks_polled`);
    const tasksCompleted = metricCount(metrics, `${prefix}_tasks_completed`);
    const pollAttempts = metricCount(metrics, `${prefix}_poll_attempts`);
    const pollMisses = metricCount(metrics, `${prefix}_poll_misses`);
    const pollErrors = metricCount(metrics, `${prefix}_poll_errors`);
    const completeErrors = metricCount(metrics, `${prefix}_complete_errors`);
    const actualTaskCompletedRps = ratio(
      tasksCompleted,
      config.testDurationSeconds,
    );
    const pairScalingEfficiency = ratio(
      actualTaskCompletedRps,
      config.singlePairBaselineCompletedRps,
    );
    const scheduleToPollP95Ms = metricP95(
      metrics,
      `${prefix}_task_scheduled_to_poll_latency`,
    );
    const taskUpdateP95Ms = metricP95(metrics, `${prefix}_task_update_latency`);

    return {
      pairId: pair.pairId,
      workflowName: pair.workflowName,
      taskType: pair.taskType,
      preloadedWorkflows:
        (preloadByPair[pair.pairId] || {}).preloadedWorkflows ||
        metricCount(metrics, `${prefix}_preloaded_workflows`),
      preloadErrors:
        (preloadByPair[pair.pairId] || {}).preloadErrors ||
        metricCount(metrics, `${prefix}_preload_errors`),
      pollAttempts,
      tasksPolled,
      tasksCompleted,
      pollMisses,
      pollErrors,
      completeErrors,
      actualTaskCompletedRps,
      taskCompletedToPollAttemptRatio: ratio(tasksCompleted, pollAttempts),
      taskCompletedToTaskPolledRatio: ratio(tasksCompleted, tasksPolled),
      pollSuccessRate: metricRate(metrics, `${prefix}_poll_success_rate`),
      taskCompleteSuccessRate: metricRate(
        metrics,
        `${prefix}_task_complete_success_rate`,
      ),
      scheduleToPollP95Ms,
      taskUpdateP95Ms,
      scalingEfficiency: pairScalingEfficiency,
      isStable:
        pollErrors === 0 &&
        completeErrors === 0 &&
        ratio(tasksCompleted, tasksPolled) >= 0.999 &&
        pairScalingEfficiency >= 0.75,
    };
  });
}

function pairById(config, pairId) {
  for (const pair of config.allPairs) {
    if (pair.pairId === pairId) {
      return pair;
    }
  }

  throw new Error(`Unknown PAIR_ID: ${pairId}`);
}

function pairTags(pair) {
  return {
    pairId: pair.pairId,
    workflowName: pair.workflowName,
    taskType: pair.taskType,
  };
}

function pad3(value) {
  return String(value).padStart(3, '0');
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

function metricP95(metrics, name) {
  const metric = metrics[name];
  return metric && metric.values && metric.values['p(95)'] !== undefined
    ? metric.values['p(95)']
    : null;
}

const config = loadConfig(__ENV);
const metrics = createMetrics(config);
const client = createConductorClient(config);
const setupService = createSetupService(config, client);
const workerScenario = createWorkerScenario(config, client, metrics);

export const options = buildOptions(config);

export function setup() {
  const definitionResults = setupService.ensureDefinitions();
  const preloadResults = setupService.preloadActivePairs();

  return {
    testRunId: config.testRunId,
    activePairs: config.activePairs,
    definitionResults,
    preloadResults,
  };
}

export function recordSetupMetrics(setupData) {
  metrics.addSetupMetrics(setupData);
}

export function worker() {
  workerScenario.run();
}

export function handleSummary(data) {
  const selected = buildSummary(config, data);

  return {
    stdout: JSON.stringify(selected, null, 2) + '\n',
    'tc03_summary.json': JSON.stringify(selected, null, 2),
    'tc03_raw_summary.json': JSON.stringify(data, null, 2),
  };
}
