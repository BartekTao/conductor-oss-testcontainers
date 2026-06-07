import { assertCreated } from './conductor.js';

export function createDefinitionService(config, client, factory, validator) {
  return {
    ensureDefinitions() {
      const taskDef = factory.buildTaskDefinition(config.taskType);
      const workflowDef = factory.buildWorkflowDefinition(
        config.workflowName,
        config.taskType,
        config.workflowVersion,
      );

      console.log(`[setup] BASE_URL=${config.baseUrl}`);
      console.log(`[setup] API_PREFIX=${config.apiPrefix || '(none)'}`);
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
        taskDefinitionAction: taskResult.action,
        workflowDefinitionAction: workflowResult.action,
      };
    },

    ensureTaskDefinition(taskDef) {
      const existing = client.getTaskDefinition(taskDef.name);

      if (existing.exists) {
        this.reportDefinitionMismatches(
          validator.validateTaskDefinition(existing.body, taskDef),
          `[setup] Task definition exists but differs from expected ` +
            `definition. taskType=${taskDef.name}`,
        );
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
        this.reportDefinitionMismatches(
          validator.validateWorkflowDefinition(existing.body, workflowDef),
          `[setup] Workflow definition exists but differs from expected ` +
            `definition. workflow=${workflowDef.name}, ` +
            `version=${workflowDef.version}`,
        );
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

export function compareEqual(mismatches, field, expected, actual) {
  if (actual !== expected) {
    mismatches.push(`${field} expected=${expected}, actual=${actual}`);
  }
}

export function compareNumber(mismatches, field, expected, actual) {
  if (Number(actual) !== Number(expected)) {
    mismatches.push(`${field} expected=${expected}, actual=${actual}`);
  }
}

export function hasOwn(objectValue, key) {
  return Object.prototype.hasOwnProperty.call(objectValue || {}, key);
}
