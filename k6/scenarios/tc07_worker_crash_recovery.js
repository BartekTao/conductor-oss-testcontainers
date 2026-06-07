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
  'crash_worker_poll_attempt_latency',
  'recovery_worker_poll_attempt_latency',
  'poll_hit_latency',
  'poll_miss_latency',
  'task_update_latency',
  'task_scheduled_to_poll_latency',
  'workflow_submit_to_poll_latency',
  'workflow_submit_to_task_complete_latency',
  'workflow_submit_to_recovery_complete_latency',
  'estimated_recovery_latency',
  'workflows_started',
  'crash_worker_tasks_polled',
  'crash_worker_tasks_completed',
  'crashed_tasks',
  'recovery_worker_tasks_polled',
  'recovery_worker_tasks_completed',
  'recovered_tasks',
  'crash_worker_poll_misses',
  'recovery_worker_poll_misses',
  'workflow_start_errors',
  'poll_errors',
  'complete_errors',
  'errors',
  'missing_task_scheduled_time',
  'missing_input_created_at_ms',
  'unexpected_task_type',
  'workflow_start_success_rate',
  'task_complete_success_rate',
  'crash_injection_rate',
  'recovery_success_observed_rate',
  'poll_hit_rate',
  'poll_success_rate',
];

function loadConfig(env) {
  const baseUrl = requireString(stripTrailingSlash(env.BASE_URL || ''), 'BASE_URL');
  const crashRatio = numberEnv(env.CRASH_RATIO, 0.5);
  const retryCount = numberEnv(env.RETRY_COUNT, 1);
  const retryDelaySeconds = numberEnv(env.RETRY_DELAY_SECONDS, 5);
  const responseTimeoutSeconds = numberEnv(env.RESPONSE_TIMEOUT_SECONDS, 15);
  const timeoutSeconds = numberEnv(env.TIMEOUT_SECONDS, 60);
  const taskTimeoutPolicy = String(env.TASK_TIMEOUT_POLICY || 'RETRY').trim();
  const workflowStartRps = numberEnv(env.WORKFLOW_START_RPS, 5);
  const crashWorkerPollRps = numberEnv(env.CRASH_WORKER_POLL_RPS, 20);
  const recoveryWorkerPollRps = numberEnv(env.RECOVERY_WORKER_POLL_RPS, 20);
  const testDuration = env.TEST_DURATION || '5m';
  const recoveryGraceDuration = env.RECOVERY_GRACE_DURATION || '2m';
  const testDurationSeconds = parseDurationSeconds(testDuration);
  const recoveryGraceDurationSeconds = parseDurationSeconds(recoveryGraceDuration);

  if (crashRatio < 0 || crashRatio > 1) {
    throw new Error(`CRASH_RATIO must be between 0 and 1. CRASH_RATIO=${crashRatio}`);
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

  if (responseTimeoutSeconds <= 0) {
    throw new Error(
      `RESPONSE_TIMEOUT_SECONDS must be > 0. ` +
        `RESPONSE_TIMEOUT_SECONDS=${responseTimeoutSeconds}`,
    );
  }

  if (timeoutSeconds <= responseTimeoutSeconds) {
    throw new Error(
      `TIMEOUT_SECONDS must be > RESPONSE_TIMEOUT_SECONDS. ` +
        `TIMEOUT_SECONDS=${timeoutSeconds}, ` +
        `RESPONSE_TIMEOUT_SECONDS=${responseTimeoutSeconds}`,
    );
  }

  if (!['RETRY', 'TIME_OUT_WF', 'ALERT_ONLY'].includes(taskTimeoutPolicy)) {
    throw new Error(
      `TASK_TIMEOUT_POLICY must be one of RETRY, TIME_OUT_WF, ALERT_ONLY. ` +
        `TASK_TIMEOUT_POLICY=${taskTimeoutPolicy}`,
    );
  }

  if (workflowStartRps < 1) {
    throw new Error(
      `WORKFLOW_START_RPS must be >= 1. ` +
        `WORKFLOW_START_RPS=${workflowStartRps}`,
    );
  }

  if (crashWorkerPollRps < 1) {
    throw new Error(
      `CRASH_WORKER_POLL_RPS must be >= 1. ` +
        `CRASH_WORKER_POLL_RPS=${crashWorkerPollRps}`,
    );
  }

  if (recoveryWorkerPollRps < 1) {
    throw new Error(
      `RECOVERY_WORKER_POLL_RPS must be >= 1. ` +
        `RECOVERY_WORKER_POLL_RPS=${recoveryWorkerPollRps}`,
    );
  }

  if (testDurationSeconds <= 0 || recoveryGraceDurationSeconds < 0) {
    throw new Error(
      `TEST_DURATION and RECOVERY_GRACE_DURATION must be valid durations. ` +
        `TEST_DURATION=${testDuration}, ` +
        `RECOVERY_GRACE_DURATION=${recoveryGraceDuration}`,
    );
  }

  return {
    baseUrl,
    apiPrefix: env.API_PREFIX === undefined ? '/api' : env.API_PREFIX,
    workflowName: env.WORKFLOW_NAME || 'wf_perf_tc07_worker_crash',
    taskType: env.TASK_TYPE || 'perf_task_tc07_crash',
    workflowVersion: numberEnv(env.WORKFLOW_VERSION, 1),
    ownerEmail: env.OWNER_EMAIL || 'perf-test@example.com',
    autoCreateDefinitions: booleanEnv(env.AUTO_CREATE_DEFINITIONS, true),
    failOnDefinitionMismatch: booleanEnv(env.FAIL_ON_DEFINITION_MISMATCH, false),
    workflowStartRps,
    crashWorkerPollRps,
    recoveryWorkerPollRps,
    crashRatio,
    retryCount,
    retryDelaySeconds,
    responseTimeoutSeconds,
    timeoutSeconds,
    taskTimeoutPolicy,
    testDuration,
    recoveryGraceDuration,
    testDurationSeconds,
    recoveryGraceDurationSeconds,
    recoveryWorkerDuration: formatDurationSeconds(
      testDurationSeconds + recoveryGraceDurationSeconds,
    ),
    recoveryWorkerStartTime: formatDurationSeconds(
      responseTimeoutSeconds + retryDelaySeconds + 1,
    ),
    producerPreAllocatedVUs: numberEnv(env.PRODUCER_PRE_ALLOCATED_VUS, 10),
    producerMaxVUs: numberEnv(env.PRODUCER_MAX_VUS, 100),
    crashWorkerPreAllocatedVUs: numberEnv(env.CRASH_WORKER_PRE_ALLOCATED_VUS, 20),
    crashWorkerMaxVUs: numberEnv(env.CRASH_WORKER_MAX_VUS, 200),
    recoveryWorkerPreAllocatedVUs: numberEnv(
      env.RECOVERY_WORKER_PRE_ALLOCATED_VUS,
      20,
    ),
    recoveryWorkerMaxVUs: numberEnv(env.RECOVERY_WORKER_MAX_VUS, 200),
    workerIdPrefix: env.WORKER_ID_PREFIX || 'k6-tc07-worker',
    slaApiP95Ms: numberEnv(env.SLA_API_P95_MS, 500),
    slaRecoveryLatencyP95Ms: numberEnv(env.SLA_RECOVERY_LATENCY_P95_MS, 25000),
    slaScheduleToPollP95Ms: numberEnv(env.SLA_SCHEDULE_TO_POLL_P95_MS, 1000),
    strictLatencyThreshold: booleanEnv(env.STRICT_LATENCY_THRESHOLD, false),
    testRunId:
      env.TEST_RUN_ID ||
      `tc07-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  };
}

function buildOptions(config) {
  const thresholds = {
    workflow_start_success_rate: ['rate>=0.999'],
    task_complete_success_rate: ['rate>=0.99'],
    errors: ['count==0'],
  };

  if (config.strictLatencyThreshold) {
    thresholds.workflow_start_latency = [`p(95)<${config.slaApiP95Ms}`];
    thresholds.task_update_latency = [`p(95)<${config.slaApiP95Ms}`];
    thresholds.task_scheduled_to_poll_latency = [
      `p(95)<${config.slaScheduleToPollP95Ms}`,
    ];
    thresholds.estimated_recovery_latency = [
      `p(95)<${config.slaRecoveryLatencyP95Ms}`,
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
      crashWorker: {
        executor: 'constant-arrival-rate',
        rate: config.crashWorkerPollRps,
        timeUnit: '1s',
        duration: config.testDuration,
        preAllocatedVUs: config.crashWorkerPreAllocatedVUs,
        maxVUs: config.crashWorkerMaxVUs,
        startTime: '1s',
        exec: 'crashWorker',
      },
      recoveryWorker: {
        executor: 'constant-arrival-rate',
        rate: config.recoveryWorkerPollRps,
        timeUnit: '1s',
        duration: config.recoveryWorkerDuration,
        preAllocatedVUs: config.recoveryWorkerPreAllocatedVUs,
        maxVUs: config.recoveryWorkerMaxVUs,
        startTime: config.recoveryWorkerStartTime,
        exec: 'recoveryWorker',
      },
    },
    thresholds,
  };
}

function createTc07DefinitionFactory(config) {
  return {
    buildTaskDefinition(taskType) {
      return {
        name: taskType,
        description: 'TC07 worker crash recovery task',
        retryCount: config.retryCount,
        retryLogic: 'FIXED',
        retryDelaySeconds: config.retryDelaySeconds,
        timeoutSeconds: config.timeoutSeconds,
        responseTimeoutSeconds: config.responseTimeoutSeconds,
        pollTimeoutSeconds: 60,
        timeoutPolicy: config.taskTimeoutPolicy,
        ownerEmail: config.ownerEmail,
        inputKeys: [],
        outputKeys: [],
        inputTemplate: {},
      };
    },

    buildWorkflowDefinition(workflowName, taskType, version) {
      return {
        name: workflowName,
        description: 'TC07 worker crash recovery workflow',
        version,
        schemaVersion: 2,
        ownerEmail: config.ownerEmail,
        inputParameters: [
          'testRunId',
          'iterationId',
          'createdAtMs',
          'crashRatio',
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
              crashRatio: '${workflow.input.crashRatio}',
              payload: '${workflow.input.payload}',
            },
          },
        ],
      };
    },
  };
}

function createTc07DefinitionValidator() {
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
      for (const key of ['testRunId', 'iterationId', 'createdAtMs', 'crashRatio', 'payload']) {
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
  const crashWorkerPollAttemptLatency = new Trend(
    'crash_worker_poll_attempt_latency',
    true,
  );
  const recoveryWorkerPollAttemptLatency = new Trend(
    'recovery_worker_poll_attempt_latency',
    true,
  );
  const pollHitLatency = new Trend('poll_hit_latency', true);
  const pollMissLatency = new Trend('poll_miss_latency', true);
  const taskUpdateLatency = new Trend('task_update_latency', true);
  const taskScheduledToPollLatency = new Trend('task_scheduled_to_poll_latency', true);
  const workflowSubmitToPollLatency = new Trend('workflow_submit_to_poll_latency', true);
  const workflowSubmitToTaskCompleteLatency = new Trend(
    'workflow_submit_to_task_complete_latency',
    true,
  );
  const workflowSubmitToRecoveryCompleteLatency = new Trend(
    'workflow_submit_to_recovery_complete_latency',
    true,
  );
  const estimatedRecoveryLatency = new Trend('estimated_recovery_latency', true);

  const workflowsStarted = new Counter('workflows_started');
  const crashWorkerTasksPolled = new Counter('crash_worker_tasks_polled');
  const crashWorkerTasksCompleted = new Counter('crash_worker_tasks_completed');
  const crashedTasks = new Counter('crashed_tasks');
  const recoveryWorkerTasksPolled = new Counter('recovery_worker_tasks_polled');
  const recoveryWorkerTasksCompleted = new Counter('recovery_worker_tasks_completed');
  const recoveredTasks = new Counter('recovered_tasks');
  const crashWorkerPollMisses = new Counter('crash_worker_poll_misses');
  const recoveryWorkerPollMisses = new Counter('recovery_worker_poll_misses');
  const workflowStartErrors = new Counter('workflow_start_errors');
  const pollErrors = new Counter('poll_errors');
  const completeErrors = new Counter('complete_errors');
  const errors = new Counter('errors');
  const missingTaskScheduledTime = new Counter('missing_task_scheduled_time');
  const missingInputCreatedAtMs = new Counter('missing_input_created_at_ms');
  const unexpectedTaskType = new Counter('unexpected_task_type');

  const workflowStartSuccessRate = new Rate('workflow_start_success_rate');
  const taskCompleteSuccessRate = new Rate('task_complete_success_rate');
  const crashInjectionRate = new Rate('crash_injection_rate');
  const recoverySuccessObservedRate = new Rate('recovery_success_observed_rate');
  const pollHitRate = new Rate('poll_hit_rate');
  const pollSuccessRate = new Rate('poll_success_rate');

  return {
    addSetupMetrics() {
      workflowsStarted.add(0);
      crashWorkerTasksPolled.add(0);
      crashWorkerTasksCompleted.add(0);
      crashedTasks.add(0);
      recoveryWorkerTasksPolled.add(0);
      recoveryWorkerTasksCompleted.add(0);
      recoveredTasks.add(0);
      crashWorkerPollMisses.add(0);
      recoveryWorkerPollMisses.add(0);
      workflowStartErrors.add(0);
      pollErrors.add(0);
      completeErrors.add(0);
      errors.add(0);
      missingTaskScheduledTime.add(0);
      missingInputCreatedAtMs.add(0);
      unexpectedTaskType.add(0);
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

    addCrashPollAttempt(durationMs) {
      crashWorkerPollAttemptLatency.add(durationMs);
    },

    addRecoveryPollAttempt(durationMs) {
      recoveryWorkerPollAttemptLatency.add(durationMs);
    },

    addCrashPollHit(durationMs) {
      pollHitLatency.add(durationMs);
      pollHitRate.add(true);
      pollSuccessRate.add(true);
      crashWorkerTasksPolled.add(1);
    },

    addRecoveryPollHit(durationMs) {
      pollHitLatency.add(durationMs);
      pollHitRate.add(true);
      pollSuccessRate.add(true);
      recoveryWorkerTasksPolled.add(1);
    },

    addCrashPollMiss(durationMs) {
      pollMissLatency.add(durationMs);
      pollHitRate.add(false);
      pollSuccessRate.add(true);
      crashWorkerPollMisses.add(1);
    },

    addRecoveryPollMiss(durationMs) {
      pollMissLatency.add(durationMs);
      pollHitRate.add(false);
      pollSuccessRate.add(true);
      recoveryWorkerPollMisses.add(1);
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

    addCrashInjected() {
      crashInjectionRate.add(true);
      recoverySuccessObservedRate.add(false);
      crashedTasks.add(1);
    },

    addCrashBypassed() {
      crashInjectionRate.add(false);
    },

    addTaskCompleteFailure(durationMs) {
      taskUpdateLatency.add(durationMs);
      taskCompleteSuccessRate.add(false);
      completeErrors.add(1);
      errors.add(1);
    },

    addCrashWorkerTaskCompleteSuccess(durationMs, task) {
      taskUpdateLatency.add(durationMs);
      taskCompleteSuccessRate.add(true);
      crashWorkerTasksCompleted.add(1);
      this.recordWorkflowSubmitToTaskCompleteLatency(task);
    },

    addRecoveryWorkerTaskCompleteSuccess(durationMs, task, isRecovered) {
      taskUpdateLatency.add(durationMs);
      taskCompleteSuccessRate.add(true);
      recoveryWorkerTasksCompleted.add(1);
      this.recordWorkflowSubmitToTaskCompleteLatency(task);

      if (isRecovered) {
        recoverySuccessObservedRate.add(true);
        recoveredTasks.add(1);
        this.recordRecoveryLatencies(task);
      }
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

    recordRecoveryLatencies(task) {
      const createdAtRaw = firstValidNumber(getTaskInput(task, 'createdAtMs'));

      if (createdAtRaw !== null) {
        const completedAtMs = Date.now();
        addNonNegativeLatency(
          workflowSubmitToRecoveryCompleteLatency,
          completedAtMs,
          createdAtRaw,
        );
        addNonNegativeLatency(
          estimatedRecoveryLatency,
          completedAtMs,
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
        crashRatio: config.crashRatio,
        payload: {
          source: 'k6-tc07',
          responseTimeoutSeconds: config.responseTimeoutSeconds,
          timeoutSeconds: config.timeoutSeconds,
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

function createCrashWorkerScenario(config, client, metrics) {
  return {
    run(setupData) {
      const workerId = `${config.workerIdPrefix}-crash-${exec.vu.idInTest}`;
      const pollRes = client.pollTask(setupData.taskType, workerId);
      metrics.addCrashPollAttempt(pollRes.timings.duration);

      const pollResult = parsePollResult(pollRes, setupData.taskType);

      if (pollResult.kind === 'miss') {
        metrics.addCrashPollMiss(pollRes.timings.duration);
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
      metrics.addCrashPollHit(pollRes.timings.duration);
      metrics.recordPollLatencies(task);

      if (Math.random() < config.crashRatio) {
        metrics.addCrashInjected();
        return;
      }

      metrics.addCrashBypassed();
      completeTask(
        client,
        config,
        metrics,
        task,
        workerId,
        'crashWorker',
        false,
      );
    },
  };
}

function createRecoveryWorkerScenario(config, client, metrics) {
  return {
    run(setupData) {
      const workerId = `${config.workerIdPrefix}-recovery-${exec.vu.idInTest}`;
      const pollRes = client.pollTask(setupData.taskType, workerId);
      metrics.addRecoveryPollAttempt(pollRes.timings.duration);

      const pollResult = parsePollResult(pollRes, setupData.taskType);

      if (pollResult.kind === 'miss') {
        metrics.addRecoveryPollMiss(pollRes.timings.duration);
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
      metrics.addRecoveryPollHit(pollRes.timings.duration);
      metrics.recordPollLatencies(task);

      completeTask(
        client,
        config,
        metrics,
        task,
        workerId,
        'recoveryWorker',
        isRecoveredTask(config, task),
      );
    },
  };
}

function completeTask(client, config, metrics, task, workerId, completedBy, isRecovered) {
  const workflowInstanceId = task.workflowInstanceId || task.workflowId;

  if (!workflowInstanceId || !task.taskId) {
    metrics.addTaskCompleteFailure(0);
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
      completedBy,
      recovered: isRecovered,
    },
  };
  const taskType = task.taskType || task.taskDefName || config.taskType;
  const res = client.completeTask(taskType, payload);
  const ok = check(res, {
    'complete task status is 200/204': (r) => isSuccessfulTaskComplete(r),
  });

  if (!ok) {
    metrics.addTaskCompleteFailure(res.timings.duration);
    fail(`Failed to complete task. status=${res.status}, body=${res.body}`);
  }

  if (completedBy === 'recoveryWorker') {
    metrics.addRecoveryWorkerTaskCompleteSuccess(res.timings.duration, task, isRecovered);
    return;
  }

  metrics.addCrashWorkerTaskCompleteSuccess(res.timings.duration, task);
}

function isRecoveredTask(config, task) {
  const createdAtRaw = firstValidNumber(getTaskInput(task, 'createdAtMs'));

  if (createdAtRaw === null) {
    return false;
  }

  return Date.now() - normalizeEpochMs(createdAtRaw) >=
    config.responseTimeoutSeconds * 1000;
}

function buildSummary(config, data) {
  const setupData = data.setup_data || {};
  const metrics = data.metrics || {};
  const workflowsStarted = metricCount(metrics, 'workflows_started');
  const crashWorkerTasksPolled = metricCount(metrics, 'crash_worker_tasks_polled');
  const crashWorkerTasksCompleted = metricCount(
    metrics,
    'crash_worker_tasks_completed',
  );
  const crashedTasks = metricCount(metrics, 'crashed_tasks');
  const recoveryWorkerTasksCompleted = metricCount(
    metrics,
    'recovery_worker_tasks_completed',
  );
  const recoveredTasks = metricCount(metrics, 'recovered_tasks');
  const workflowStartErrors = metricCount(metrics, 'workflow_start_errors');
  const pollErrors = metricCount(metrics, 'poll_errors');
  const completeErrors = metricCount(metrics, 'complete_errors');
  const errors = metricCount(metrics, 'errors');
  const totalCompletedTasks =
    crashWorkerTasksCompleted + recoveryWorkerTasksCompleted;
  const recoveredToCrashedRatio = crashedTasks > 0
    ? ratio(recoveredTasks, crashedTasks)
    : 1;
  const totalCompletedToStartedRatio = ratio(totalCompletedTasks, workflowsStarted);

  const derived = {
    observedCrashRatio: ratio(crashedTasks, crashWorkerTasksPolled),
    recoveredToCrashedRatio,
    totalCompletedTasks,
    totalCompletedToStartedRatio,
    actualCompletedRps: ratio(totalCompletedTasks, config.testDurationSeconds),
    expectedMinRecoveryLatencyMs: config.responseTimeoutSeconds * 1000,
    isStable:
      errors === 0 &&
      workflowStartErrors === 0 &&
      pollErrors === 0 &&
      completeErrors === 0 &&
      metricRate(metrics, 'workflow_start_success_rate') >= 0.999 &&
      metricRate(metrics, 'task_complete_success_rate') >= 0.99 &&
      totalCompletedToStartedRatio >= 0.95 &&
      recoveredToCrashedRatio >= 0.9,
    cliffSignals: {
      recoveryRatioBelowThreshold:
        crashedTasks > 0 && recoveredToCrashedRatio < 0.9,
      completionRatioBelowThreshold: totalCompletedToStartedRatio < 0.95,
      hasErrors: errors > 0,
      hasPollErrors: pollErrors > 0,
      hasCompleteErrors: completeErrors > 0,
    },
  };

  return {
    testCase: 'TC07',
    testRunId: setupData.testRunId || config.testRunId,
    baseUrl: config.baseUrl,
    apiPrefix: config.apiPrefix,
    workflowName: setupData.workflowName || config.workflowName,
    taskType: setupData.taskType || config.taskType,
    workflowVersion: setupData.workflowVersion || config.workflowVersion,
    workflowStartRps: config.workflowStartRps,
    crashWorkerPollRps: config.crashWorkerPollRps,
    recoveryWorkerPollRps: config.recoveryWorkerPollRps,
    crashRatio: config.crashRatio,
    responseTimeoutSeconds: config.responseTimeoutSeconds,
    retryCount: config.retryCount,
    retryDelaySeconds: config.retryDelaySeconds,
    timeoutSeconds: config.timeoutSeconds,
    taskTimeoutPolicy: config.taskTimeoutPolicy,
    testDuration: config.testDuration,
    recoveryGraceDuration: config.recoveryGraceDuration,
    recoveryWorkerDuration: config.recoveryWorkerDuration,
    recoveryWorkerStartTime: config.recoveryWorkerStartTime,
    strictLatencyThreshold: config.strictLatencyThreshold,
    recoveryLatencyNote:
      'estimated_recovery_latency is measured from workflow createdAtMs to ' +
      'recovery completion; it is not exact crash-to-repoll latency.',
    definitionActions: {
      task: setupData.taskDefinitionAction,
      workflow: setupData.workflowDefinitionAction,
    },
    overall: pickMetrics(metrics, METRIC_NAMES),
    derived,
  };
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

function formatDurationSeconds(seconds) {
  return `${seconds}s`;
}

function normalizeEpochMs(value) {
  const numberValue = Number(value);

  if (numberValue > 1000000000000) {
    return numberValue;
  }

  if (numberValue > 1000000000) {
    return numberValue * 1000;
  }

  return numberValue;
}

const config = loadConfig(__ENV);
const metrics = createMetrics();
const client = createConductorClient(config);
const definitions = createDefinitionService(
  config,
  client,
  createTc07DefinitionFactory(config),
  createTc07DefinitionValidator(),
);
const producerScenario = createProducerScenario(config, client, metrics);
const crashWorkerScenario = createCrashWorkerScenario(config, client, metrics);
const recoveryWorkerScenario = createRecoveryWorkerScenario(config, client, metrics);

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

export function recordSetupMetrics() {
  metrics.addSetupMetrics();
}

export function producer(setupData) {
  producerScenario.run(setupData);
}

export function crashWorker(setupData) {
  crashWorkerScenario.run(setupData);
}

export function recoveryWorker(setupData) {
  recoveryWorkerScenario.run(setupData);
}

export function handleSummary(data) {
  const selected = buildSummary(config, data);

  return {
    stdout: JSON.stringify(selected, null, 2) + '\n',
    'tc07_summary.json': JSON.stringify(selected, null, 2),
    'tc07_raw_summary.json': JSON.stringify(data, null, 2),
  };
}
