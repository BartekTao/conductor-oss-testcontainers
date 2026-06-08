export function parsePollResult(res, expectedTaskType) {
  const body = (res.body || '').trim();

  if (res.status === 204 || (res.status === 200 && (body === '' || body === 'null'))) {
    return { kind: 'miss', task: null, error: null };
  }

  if (res.status !== 200) {
    return {
      kind: 'error',
      task: null,
      error: `Unexpected poll status. status=${res.status}, body=${res.body}`,
    };
  }

  let task = null;

  try {
    task = res.json();
  } catch (e) {
    return {
      kind: 'error',
      task: null,
      error: `Poll body is not valid JSON. body=${res.body}`,
    };
  }

  if (!task || !task.taskId) {
    return {
      kind: 'error',
      task,
      error: `Poll hit body does not contain taskId. body=${res.body}`,
    };
  }

  const actualTaskType = task.taskType || task.taskDefName;

  if (actualTaskType && actualTaskType !== expectedTaskType) {
    return {
      kind: 'unexpected_task_type',
      task,
      error:
        `Unexpected task type. expected=${expectedTaskType}, ` +
        `actual=${actualTaskType}`,
    };
  }

  return { kind: 'hit', task, error: null };
}

export function buildCompleteTaskPayload(task, workerId) {
  const workflowInstanceId = task.workflowInstanceId || task.workflowId;

  return {
    workflowInstanceId,
    taskId: task.taskId,
    status: 'COMPLETED',
    workerId,
    outputData: {
      completedAtMs: Date.now(),
      testRunId: getTaskInput(task, 'testRunId'),
      preloadIndex: getTaskInput(task, 'preloadIndex'),
    },
  };
}

export function getTaskInput(task, key) {
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

export function firstValidNumber() {
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

export function normalizeEpochMs(value) {
  const numberValue = Number(value);

  if (numberValue > 1000000000000) {
    return numberValue;
  }

  if (numberValue > 1000000000) {
    return numberValue * 1000;
  }

  return numberValue;
}

export function addNonNegativeLatency(metric, receivedAtMs, rawStartedAt, tags) {
  const latency = receivedAtMs - normalizeEpochMs(rawStartedAt);

  if (latency >= 0) {
    metric.add(latency, tags);
  }
}
