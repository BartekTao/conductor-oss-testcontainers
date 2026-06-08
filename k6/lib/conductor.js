import http from 'k6/http';

export function createConductorClient(config) {
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

    startWorkflow(workflowName, version, input, correlationId) {
      const endpoint =
        `/workflow/${encodeURIComponent(workflowName)}` +
        `?version=${encodeURIComponent(version)}` +
        `&correlationId=${encodeURIComponent(correlationId)}`;

      return http.post(
        this.api(endpoint),
        JSON.stringify(input),
        this.jsonParams({ op: 'start_workflow', workflow: workflowName }),
      );
    },

    batchStartWorkflows(requests) {
      return http.batch(requests);
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

    buildStartWorkflowRequest(workflowName, version, input, correlationId) {
      const endpoint =
        `/workflow/${encodeURIComponent(workflowName)}` +
        `?version=${encodeURIComponent(version)}` +
        `&correlationId=${encodeURIComponent(correlationId)}`;

      return [
        'POST',
        this.api(endpoint),
        JSON.stringify(input),
        this.jsonParams({ op: 'preload_workflow', workflow: workflowName }),
      ];
    },

    api(path) {
      const prefix = config.apiPrefix || '';
      return `${config.baseUrl}${prefix}${path}`;
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

export function safeJson(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

export function assertCreated(res, resourceName, resourceContext) {
  const ok = res.status === 200 || res.status === 201 || res.status === 204;

  if (!ok) {
    throw new Error(
      `[setup] Failed to create ${resourceName}. ` +
        `${resourceContext}, status=${res.status}, body=${res.body}`,
    );
  }
}

export function isSuccessfulWorkflowStart(res) {
  return res.status === 200 || res.status === 202;
}

export function isSuccessfulTaskComplete(res) {
  return res.status === 200 || res.status === 204;
}

export function parseWorkflowId(res) {
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
