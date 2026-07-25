import { isRecord, PlanValidationError, validateTaskPlan } from "./dag.js";
import {
	type ChangeStepDefinition,
	validateWorkflowPlan,
	WORKFLOW_PLAN_SCHEMA_VERSION,
	type WorkflowPlan,
} from "./steps.js";
import { PLAN_SCHEMA_VERSION, type TaskPlan } from "./types.js";

/**
 * Translates a legacy schema version 3 task plan into the workflow step
 * model. Every legacy task becomes a change step with identical identity,
 * dependencies, and execution authority; the step defaults reproduce the
 * legacy behavior (full change capabilities, path locks equal to the
 * approved paths, one attempt, no declared artifacts).
 */
export function translateLegacyTaskPlan(plan: TaskPlan): WorkflowPlan {
	const legacy = validateTaskPlan(plan);
	const steps: ChangeStepDefinition[] = legacy.tasks.map((task) => ({
		id: task.id,
		kind: "change",
		title: task.title,
		description: task.description,
		dependencies: [...task.dependencies],
		acceptanceCriteria: [...task.acceptanceCriteria],
		allowedPaths: [...task.allowedPaths],
		validationCommands: task.validationCommands.map((command) => ({
			command: command.command,
			args: [...command.args],
		})),
	}));
	return validateWorkflowPlan({
		version: WORKFLOW_PLAN_SCHEMA_VERSION,
		title: legacy.title,
		steps,
		finalValidationCommands: legacy.finalValidationCommands.map((command) => ({
			command: command.command,
			args: [...command.args],
		})),
	});
}

/**
 * Reads a plan document in either the current workflow schema (version 4)
 * or the legacy task schema (version 3), returning a validated workflow
 * plan. Other versions fail with a typed validation issue.
 */
export function readWorkflowPlanDocument(value: unknown): WorkflowPlan {
	if (!isRecord(value)) {
		throw new PlanValidationError([
			{ code: "plan_object", path: "plan", message: "plan must be an object" },
		]);
	}
	if (value.version === WORKFLOW_PLAN_SCHEMA_VERSION) {
		return validateWorkflowPlan(value);
	}
	if (value.version === PLAN_SCHEMA_VERSION) {
		return translateLegacyTaskPlan(value as unknown as TaskPlan);
	}
	throw new PlanValidationError([
		{
			code: "unsupported_plan_version",
			path: "version",
			message: `version must be ${WORKFLOW_PLAN_SCHEMA_VERSION} (workflow plan) or ${PLAN_SCHEMA_VERSION} (legacy task plan)`,
		},
	]);
}
