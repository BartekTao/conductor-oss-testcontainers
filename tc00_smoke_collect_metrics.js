import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * TC00 Conductor smoke test with metrics collection.
 *
 * This file intentionally remains a single k6 entrypoint, but internal
 * responsibilities are separated into small collaborators:
 * - RuntimeConfig: ENV parsing and test options input.
 * - MetricRegistry: all metric declarations and metric recording helpers.
 * - ConductorClient: HTTP transport and Conductor response parsing.
 * - DefinitionService: definition build, lookup, create, and validation.
 * - SmokeScenario: one iteration lifecycle orchestration.
 * - SummaryReporter: selected k6 summary output.
 */

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
  const baseUrl = stripTrailingSlash(env.BASE_URL || '');

  if (!baseUrl) {
    throw new Error('Missing required env: BASE_URL');
  }

  return {
    baseUrl,
    apiPrefix: env.API_PREFIX || '/api',
    workflowName: env.WORKFLOW_NAME || 'wf_perf_single_hot',
    taskType: env.TASK_TYPE || 'perf_task_hot',
    workflowVersion: numberEnv(env.WORKFLOW_VERSION, 1),
    ownerEmail: env.OWNER_EMAIL || 'perf-test@example.com',
    autoCreateDefinitions: booleanEnv(env.AUTO_CREATE_DEFINITIONS, true),
    failOnDefinitionMismatch: booleanEnv(
      env.FAIL_ON_DEFINITION_MISMATCH,
      true,
    ),
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

function createMetrics() {
  const workflowStartLatency = new Trend('workflow_start_latency', true);
  const pollAttemptLatency = new Trend('poll_attempt_latency', true);
  const pollHitLatency = new Trend('poll_hit_latency', true);
  const pollMissLatency = new Trend('poll_miss_latency', true);
  const taskUpdateLatency = new Trend('task_update_latency', true);
  const workflowGetLatency = new Trend('workflow_get_latency', true);
  const workflowE2ELatency = new Trend('workflow_e2e_latency', true);
  const taskScheduledToPollLatency = new Trend(
    'task_scheduled_to_poll_latency',
    true,
  );
  const workflowSubmitToPollLatency = new Trend(
    'workflow_submit_to_poll_latency',
    true,
  );

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

function createConductorClient(config) {
  return {
    getTaskDefinition(taskType) {
      const res = http.get(
        this.api(`/metadata/taskdefs/${encodeURIComponent(taskType)}`),
        this.jsonParams({ op: 'get_task_definition', taskType }),
      );

      if (res.status === 200) {
        return { exists: true, body: safeJson(res), status: res.status };
      }

      if (res.status === 404) {
        return { exists: false, body: null, status: res.status };
      }

      throw new Error(
        `[setup] Failed to check task definition. ` +
          `taskType=${taskType}, status=${res.status}, body=${res.body}`,
      );
    },
    createTaskDefinition(taskDef) {
      return http.post(
        this.api('/metadata/taskdefs'),
        JSON.stringify([taskDef]),
        this.jsonParams({
          op: 'create_task_definition',
          taskType: taskDef.name,
        }),
      );
    },
    getWorkflowDefinition(workflowName, version) {
      const endpoint =
        `/metadata/workflow/${encodeURIComponent(workflowName)}` +
        `?version=${encodeURIComponent(version)}`;
      const res = http.get(
        this.api(endpoint),
        this.jsonParams({
          op: 'get_workflow_definition',
          workflow: workflowName,
        }),
      );

      if (res.status === 200) {
        return { exists: true, body: safeJson(res), status: res.status };
      }

      if (res.status === 404) {
        return { exists: false, body: null, status: res.status };
      }

      throw new Error(
        `[setup] Failed to check workflow definition. ` +
          `workflow=${workflowName}, version=${version}, ` +
          `status=${res.status}, body=${res.body}`,
      );
    },
    createWorkflowDefinition(workflowDef) {
      return http.post(
        this.api('/metadata/workflow'),
        JSON.stringify(workflowDef),
        this.jsonParams({
          op: 'create_workflow_definition',
          workflow: workflowDef.name,
        }),
      );
    },
    startWorkflow(workflowName, input, correlationId) {
      const endpoint =
        `/workflow/${encodeURIComponent(workflowName)}` +
        `?version=${config.workflowVersion}` +
        `&correlationId=${encodeURIComponent(correlationId)}`;

      return http.post(
        this.api(endpoint),
        JSON.stringify(input),
        this.jsonParams({ op: 'start_workflow', workflow: workflowName }),
      );
    },
    pollTask(taskType, workerId) {
      const endpoint =
        `/tasks/poll/${encodeURIComponent(taskType)}` +
        `?workerid=${encodeURIComponent(workerId)}`;

      return http.get(
        this.api(endpoint),
        this.jsonParams({ op: 'poll_task', taskType }),
      );
    },
    completeTask(taskType, payload) {
      return http.post(
        this.api('/tasks'),
        JSON.stringify(payload),
        this.jsonParams({ op: 'complete_task', taskType }),
      );
    },
    getWorkflow(workflowId) {
      return http.get(
        this.api(`/workflow/${encodeURIComponent(workflowId)}?includeTasks=true`),
        this.jsonParams({ op: 'get_workflow' }),
      );
    },
    api(path) {
      return `${config.baseUrl}${config.apiPrefix}${path}`;
    },
    jsonParams(tags) {
      return {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        tags: tags || {},
      };
    },
  };
}

function createDefinitionService(config, client) {
  return {
    ensureDefinitions() {
      const taskDef = this.buildTaskDefinition(config.taskType);
      const workflowDef = this.buildWorkflowDefinition(
        config.workflowName,
        config.taskType,
        config.workflowVersion,
      );

      console.log(`[setup] BASE_URL=${config.baseUrl}`);
      console.log(`[setup] API_PREFIX=${config.apiPrefix}`);
      console.log(`[setup] TEST_RUN_ID=${config.testRunId}`);

      console.log(`[setup] Checking task definition: ${taskDef.name}`);
      const taskResult = this.ensureTaskDefinition(taskDef);

      console.log(
        `[setup] Checking workflow definition: ${workflowDef.name}, ` +
          `version=${workflowDef.version}`,
      );
      const workflowResult = this.ensureWorkflowDefinition(workflowDef);

      console.log(
        `[setup] Definition check completed. ` +
          `task=${taskResult.action}, workflow=${workflowResult.action}`,
      );

      return {
        testRunId: config.testRunId,
        workflowName: config.workflowName,
        taskType: config.taskType,
        workflowVersion: config.workflowVersion,
        taskDefinitionAction: taskResult.action,
        workflowDefinitionAction: workflowResult.action,
      };
    },
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
    ensureTaskDefinition(taskDef) {
      const existing = client.getTaskDefinition(taskDef.name);

      if (existing.exists) {
        this.validateTaskDefinition(existing.body, taskDef);
        return { action: 'exists', name: taskDef.name };
      }

      if (!config.autoCreateDefinitions) {
        throw new Error(
          `[setup] Task definition does not exist and ` +
            `AUTO_CREATE_DEFINITIONS=false. taskType=${taskDef.name}`,
        );
      }

      console.log(`[setup] Creating task definition: ${taskDef.name}`);
      const res = client.createTaskDefinition(taskDef);
      assertCreated(res, 'task definition', `taskType=${taskDef.name}`);

      const verify = client.getTaskDefinition(taskDef.name);

      if (!verify.exists) {
        throw new Error(
          `[setup] Task definition create returned success, but ` +
            `verification failed. taskType=${taskDef.name}`,
        );
      }

      return { action: 'created', name: taskDef.name };
    },
    ensureWorkflowDefinition(workflowDef) {
      const existing = client.getWorkflowDefinition(
        workflowDef.name,
        workflowDef.version,
      );

      if (existing.exists) {
        this.validateWorkflowDefinition(existing.body, workflowDef);
        return {
          action: 'exists',
          name: workflowDef.name,
          version: workflowDef.version,
        };
      }

      if (!config.autoCreateDefinitions) {
        throw new Error(
          `[setup] Workflow definition does not exist and ` +
            `AUTO_CREATE_DEFINITIONS=false. workflow=${workflowDef.name}, ` +
            `version=${workflowDef.version}`,
        );
      }

      console.log(
        `[setup] Creating workflow definition: ${workflowDef.name}, ` +
          `version=${workflowDef.version}`,
      );
      const res = client.createWorkflowDefinition(workflowDef);
      assertCreated(
        res,
        'workflow definition',
        `workflow=${workflowDef.name}, version=${workflowDef.version}`,
      );

      const verify = client.getWorkflowDefinition(
        workflowDef.name,
        workflowDef.version,
      );

      if (!verify.exists) {
        throw new Error(
          `[setup] Workflow definition create returned success, but ` +
            `verification failed. workflow=${workflowDef.name}, ` +
            `version=${workflowDef.version}`,
        );
      }

      return {
        action: 'created',
        name: workflowDef.name,
        version: workflowDef.version,
      };
    },
    validateTaskDefinition(existing, expected) {
      if (!existing) {
        throw new Error(
          `[setup] Existing task definition response is empty. ` +
            `taskType=${expected.name}`,
        );
      }

      const mismatches = [];
      compareEqual(mismatches, 'name', expected.name, existing.name);
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
        'retryCount',
        expected.retryCount,
        existing.retryCount,
      );

      this.reportDefinitionMismatches(
        mismatches,
        `[setup] Task definition exists but differs from TC00 expected ` +
          `definition. taskType=${expected.name}`,
      );
    },
    validateWorkflowDefinition(existing, expected) {
      if (!existing) {
        throw new Error(
          `[setup] Existing workflow definition response is empty. ` +
            `workflow=${expected.name}`,
        );
      }

      const mismatches = [];
      compareEqual(mismatches, 'name', expected.name, existing.name);
      compareNumber(mismatches, 'version', expected.version, existing.version);

      if (!Array.isArray(existing.tasks) || existing.tasks.length !== 1) {
        mismatches.push(
          `tasks.length expected=1, actual=${
            existing.tasks ? existing.tasks.length : 'null'
          }`,
        );
      } else {
        this.validateWorkflowTask(mismatches, existing.tasks[0], expected.tasks[0]);
      }

      this.reportDefinitionMismatches(
        mismatches,
        `[setup] Workflow definition exists but differs from TC00 expected ` +
          `definition. workflow=${expected.name}, version=${expected.version}`,
      );
    },
    validateWorkflowTask(mismatches, actual, expected) {
      compareEqual(mismatches, 'task.name', expected.name, actual.name);
      compareEqual(mismatches, 'task.type', 'SIMPLE', actual.type);
      compareEqual(
        mismatches,
        'taskReferenceName',
        expected.taskReferenceName,
        actual.taskReferenceName,
      );

      const inputParameters = actual.inputParameters || {};

      for (const key of ['testRunId', 'iterationId', 'createdAtMs']) {
        if (!Object.prototype.hasOwnProperty.call(inputParameters, key)) {
          mismatches.push(`task.inputParameters missing key=${key}`);
        }
      }
    },
    reportDefinitionMismatches(mismatches, messagePrefix) {
      if (mismatches.length === 0) {
        return;
      }

      const message = `${messagePrefix}, mismatches=${mismatches.join('; ')}`;

      if (config.failOnDefinitionMismatch) {
        throw new Error(message);
      }

      console.warn(message);
    },
  };
}

function createSmokeScenario(config, client, metrics) {
  return {
    run(setupData) {
      const iterationContext = this.createIterationContext(setupData);
      const workflowId = this.startWorkflow(iterationContext);
      const task = this.pollUntilHit(iterationContext, workflowId);

      this.completeTask(task, iterationContext.workerId);
      this.waitWorkflowCompleted(workflowId, iterationContext.createdAtMs);
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
        context.input,
        context.iterationId,
      );

      metrics.addWorkflowStart(res.timings.duration);

      const ok = check(res, {
        'start workflow status is 200/202': (r) =>
          r.status === 200 || r.status === 202,
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
          return this.handlePollHit(res, context, expectedWorkflowId);
        }

        this.handlePollMiss(res);
      }

      metrics.addError();
      fail(
        `Poll timeout. taskType=${context.taskType}, ` +
          `maxAttempts=${config.maxPollAttempts}`,
      );
    },
    handlePollHit(res, context, expectedWorkflowId) {
      metrics.addPollHit(res.timings.duration);

      const task = safeJson(res);

      if (!task || !task.taskId) {
        metrics.addError();
        fail(
          `Poll hit but task body is invalid. ` +
            `status=${res.status}, body=${res.body}`,
        );
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
        fail(
          `Cannot complete task because taskId or workflowInstanceId is ` +
            `missing: ${JSON.stringify(task)}`,
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
      const taskType = task.taskDefName || config.taskType;
      const res = client.completeTask(taskType, payload);

      const ok = check(res, {
        'complete task status is 200/204': (r) =>
          r.status === 200 || r.status === 204,
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

function assertCreated(res, resourceName, resourceContext) {
  const ok = res.status === 200 || res.status === 201 || res.status === 204;

  if (!ok) {
    throw new Error(
      `[setup] Failed to create ${resourceName}. ` +
        `${resourceContext}, status=${res.status}, body=${res.body}`,
    );
  }
}

function addNonNegativeLatency(metric, receivedAtMs, rawStartedAt) {
  const latency = receivedAtMs - normalizeEpochMs(rawStartedAt);

  if (latency >= 0) {
    metric.add(latency);
  }
}

function isPollHit(res) {
  const body = (res.body || '').trim();
  return res.status === 200 && body !== '' && body !== 'null';
}

function compareEqual(mismatches, field, expected, actual) {
  if (actual !== expected) {
    mismatches.push(`${field} expected=${expected}, actual=${actual}`);
  }
}

function compareNumber(mismatches, field, expected, actual) {
  if (Number(actual) !== Number(expected)) {
    mismatches.push(`${field} expected=${expected}, actual=${actual}`);
  }
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
  if (!task) {
    return undefined;
  }

  if (
    task.inputData &&
    Object.prototype.hasOwnProperty.call(task.inputData, key)
  ) {
    return task.inputData[key];
  }

  if (task.input && Object.prototype.hasOwnProperty.call(task.input, key)) {
    return task.input[key];
  }

  return undefined;
}

function firstValidNumber() {
  for (let index = 0; index < arguments.length; index++) {
    const value = arguments[index];

    if (value === undefined || value === null || value === '') {
      continue;
    }

    const numberValue = Number(value);

    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }

  return null;
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

function numberEnv(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return String(value).toLowerCase() === 'true';
}

function stripTrailingSlash(value) {
  return value.replace(/\/$/, '');
}

const config = loadConfig(__ENV);
const metrics = createMetrics();
const client = createConductorClient(config);
const definitions = createDefinitionService(config, client);
const scenario = createSmokeScenario(config, client, metrics);

export const options = buildOptions(config);

export function setup() {
  return definitions.ensureDefinitions();
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
