import {
	addIssue,
	findCycle,
	isRecord,
	PlanValidationError,
	type PlanValidationIssue,
	readAllowedPaths,
	readCommandObject,
	readNonEmptyString,
	readStringArray,
	readValidationCommands,
} from "./dag.js";
import type { ValidationCommand } from "./types.js";

export const WORKFLOW_PLAN_SCHEMA_VERSION = 4 as const;

export const STEP_KINDS = [
	"investigation",
	"change",
	"command",
	"approval",
] as const;

export type StepKind = (typeof STEP_KINDS)[number];

const STEP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

interface StepDefinitionCommon {
	id: string;
	title: string;
	description: string;
	dependencies: string[];
}

/** Read-only exploration that must answer explicit questions. */
export interface InvestigationStepDefinition extends StepDefinitionCommon {
	kind: "investigation";
	questions: string[];
}

/** Repository mutation bounded by approved paths and validation commands. */
export interface ChangeStepDefinition extends StepDefinitionCommon {
	kind: "change";
	acceptanceCriteria: string[];
	allowedPaths: string[];
	validationCommands: ValidationCommand[];
}

/** One declared executable invocation without model involvement. */
export interface CommandStepDefinition extends StepDefinitionCommon {
	kind: "command";
	command: ValidationCommand;
}

/** An explicit user decision gate that blocks dependent steps. */
export interface ApprovalStepDefinition extends StepDefinitionCommon {
	kind: "approval";
	prompt: string;
}

export type StepDefinition =
	| InvestigationStepDefinition
	| ChangeStepDefinition
	| CommandStepDefinition
	| ApprovalStepDefinition;

export interface WorkflowPlan {
	version: typeof WORKFLOW_PLAN_SCHEMA_VERSION;
	title: string;
	steps: StepDefinition[];
	finalValidationCommands: ValidationCommand[];
}

export type WorkflowPlanValidationResult =
	| { ok: true; plan: WorkflowPlan; issues: [] }
	| { ok: false; issues: PlanValidationIssue[] };

function readStepCommon(
	value: Record<string, unknown>,
	path: string,
	issues: PlanValidationIssue[],
): StepDefinitionCommon {
	return {
		id: readNonEmptyString(value.id, `${path}.id`, issues),
		title: readNonEmptyString(value.title, `${path}.title`, issues),
		description: readNonEmptyString(
			value.description,
			`${path}.description`,
			issues,
		),
		dependencies: readStringArray(
			value.dependencies,
			`${path}.dependencies`,
			issues,
		),
	};
}

function readQuestions(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): string[] {
	const questions = readStringArray(value, path, issues);
	if (questions.length === 0) {
		addIssue(
			issues,
			"required_questions",
			path,
			`${path} must contain at least one question the investigation answers`,
		);
	}
	return questions;
}

function readStep(
	value: unknown,
	index: number,
	issues: PlanValidationIssue[],
): StepDefinition {
	const path = `steps[${index}]`;
	if (!isRecord(value)) {
		addIssue(issues, "step_object", path, `${path} must be an object`);
		return {
			kind: "investigation",
			id: "",
			title: "",
			description: "",
			dependencies: [],
			questions: [],
		};
	}
	const common = readStepCommon(value, path, issues);
	switch (value.kind) {
		case "investigation":
			return {
				...common,
				kind: "investigation",
				questions: readQuestions(value.questions, `${path}.questions`, issues),
			};
		case "change":
			return {
				...common,
				kind: "change",
				acceptanceCriteria: readStringArray(
					value.acceptanceCriteria,
					`${path}.acceptanceCriteria`,
					issues,
				),
				allowedPaths: readAllowedPaths(
					value.allowedPaths,
					`${path}.allowedPaths`,
					issues,
				),
				validationCommands: readValidationCommands(
					value.validationCommands,
					`${path}.validationCommands`,
					issues,
				),
			};
		case "command":
			return {
				...common,
				kind: "command",
				command: readCommandObject(value.command, `${path}.command`, issues),
			};
		case "approval":
			return {
				...common,
				kind: "approval",
				prompt: readNonEmptyString(value.prompt, `${path}.prompt`, issues),
			};
		default:
			addIssue(
				issues,
				"step_kind",
				`${path}.kind`,
				`${path}.kind must be one of ${STEP_KINDS.join(", ")}`,
			);
			return { ...common, kind: "investigation", questions: [] };
	}
}

export function validateWorkflowPlanResult(
	value: unknown,
): WorkflowPlanValidationResult {
	const issues: PlanValidationIssue[] = [];
	if (!isRecord(value)) {
		return {
			ok: false,
			issues: [
				{
					code: "plan_object",
					path: "plan",
					message: "plan must be an object",
				},
			],
		};
	}
	if (value.version !== WORKFLOW_PLAN_SCHEMA_VERSION) {
		addIssue(
			issues,
			"schema_version",
			"version",
			`version must be ${WORKFLOW_PLAN_SCHEMA_VERSION}`,
		);
	}
	const title = readNonEmptyString(value.title, "title", issues);
	if (!Array.isArray(value.steps) || value.steps.length === 0) {
		addIssue(
			issues,
			"required_steps",
			"steps",
			"steps must be a non-empty array",
		);
	}
	const steps = Array.isArray(value.steps)
		? value.steps.map((step, index) => readStep(step, index, issues))
		: [];
	const hasChangeStep = steps.some((step) => step.kind === "change");
	let finalValidationCommands: ValidationCommand[] = [];
	if (hasChangeStep) {
		if (
			!Array.isArray(value.finalValidationCommands) ||
			value.finalValidationCommands.length === 0
		) {
			addIssue(
				issues,
				"required_final_validation",
				"finalValidationCommands",
				"finalValidationCommands must be a non-empty array when the plan contains a change step",
			);
		} else {
			finalValidationCommands = readValidationCommands(
				value.finalValidationCommands,
				"finalValidationCommands",
				issues,
			);
		}
	} else if (value.finalValidationCommands !== undefined) {
		if (!Array.isArray(value.finalValidationCommands)) {
			addIssue(
				issues,
				"command_array",
				"finalValidationCommands",
				"finalValidationCommands must be an array of command objects",
			);
		} else if (value.finalValidationCommands.length > 0) {
			finalValidationCommands = readValidationCommands(
				value.finalValidationCommands,
				"finalValidationCommands",
				issues,
			);
		}
	}
	const ids = new Set<string>();
	for (const [index, step] of steps.entries()) {
		const idPath = `steps[${index}].id`;
		if (!STEP_ID_PATTERN.test(step.id)) {
			addIssue(
				issues,
				"step_id_format",
				idPath,
				`step id ${JSON.stringify(step.id)} must match ${STEP_ID_PATTERN}`,
			);
		}
		if (ids.has(step.id)) {
			addIssue(
				issues,
				"duplicate_step_id",
				idPath,
				`duplicate step id: ${step.id}`,
			);
		}
		ids.add(step.id);
		const uniqueDependencies = new Set(step.dependencies);
		if (uniqueDependencies.size !== step.dependencies.length) {
			addIssue(
				issues,
				"duplicate_dependency",
				`steps[${index}].dependencies`,
				`step ${step.id} has duplicate dependencies`,
			);
		}
		if (uniqueDependencies.has(step.id)) {
			addIssue(
				issues,
				"self_dependency",
				`steps[${index}].dependencies`,
				`step ${step.id} cannot depend on itself`,
			);
		}
	}
	for (const [stepIndex, step] of steps.entries()) {
		for (const [dependencyIndex, dependency] of step.dependencies.entries()) {
			if (!ids.has(dependency)) {
				addIssue(
					issues,
					"unknown_dependency",
					`steps[${stepIndex}].dependencies[${dependencyIndex}]`,
					`step ${step.id} depends on unknown step ${dependency}`,
				);
			}
		}
	}
	if (issues.length === 0) {
		const cycle = findCycle(steps);
		if (cycle) {
			addIssue(
				issues,
				"dependency_cycle",
				"steps",
				`dependency cycle: ${cycle.join(" -> ")}`,
			);
		}
	}
	if (issues.length > 0) {
		return { ok: false, issues };
	}
	return {
		ok: true,
		plan: {
			version: WORKFLOW_PLAN_SCHEMA_VERSION,
			title,
			steps,
			finalValidationCommands,
		},
		issues: [],
	};
}

export function validateWorkflowPlan(value: unknown): WorkflowPlan {
	const result = validateWorkflowPlanResult(value);
	if (!result.ok) {
		throw new PlanValidationError(result.issues);
	}
	return result.plan;
}
