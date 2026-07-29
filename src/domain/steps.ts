import {
	addIssue,
	findCycle,
	isRecord,
	PlanValidationError,
	type PlanValidationIssue,
	readAllowedPaths,
	readCommandObject,
	readNonEmptyString,
	readSafeRepositoryPaths,
	readStringArray,
	readValidationCommands,
	topologicalIds,
} from "./dag.js";
import {
	STEP_CAPABILITIES,
	type StepCapability,
	type ValidationCommand,
} from "./types.js";

export const WORKFLOW_PLAN_SCHEMA_VERSION = 4 as const;

export const STEP_KINDS = [
	"investigation",
	"change",
	"command",
	"approval",
] as const;

export type StepKind = (typeof STEP_KINDS)[number];

export const MAX_STEP_RETRY_ATTEMPTS = 5 as const;

const STEP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const OUTPUT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const RESOURCE_LOCK_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Reference to an artifact a dependency step declared as an output. */
export interface StepInputReference {
	stepId: string;
	output: string;
}

export interface StepRetryPolicy {
	maxAttempts: number;
}

interface StepDefinitionCommon {
	id: string;
	title: string;
	description: string;
	dependencies: string[];
	inputs?: StepInputReference[];
	outputs?: string[];
	capabilities?: StepCapability[];
	pathLocks?: string[];
	resourceLocks?: string[];
	timeoutMs?: number;
	retry?: StepRetryPolicy;
}

// The maximum authority each step kind may declare; undeclared capabilities
// default to this full set, and declaring a subset narrows it further.
export const STEP_KIND_CAPABILITY_MAXIMA: Record<
	StepKind,
	readonly StepCapability[]
> = {
	investigation: ["read-repository"],
	change: ["read-repository", "mutate-repository", "execute-commands"],
	command: ["read-repository", "execute-commands"],
	approval: [],
};
const KIND_CAPABILITIES = STEP_KIND_CAPABILITY_MAXIMA;

export function stepCapabilities(step: StepDefinition): StepCapability[] {
	return [...(step.capabilities ?? KIND_CAPABILITIES[step.kind])];
}

export function stepPathLocks(step: StepDefinition): string[] {
	if (step.pathLocks) {
		return [...step.pathLocks];
	}
	return step.kind === "change" ? [...step.allowedPaths] : [];
}

export function stepResourceLocks(step: StepDefinition): string[] {
	return [...(step.resourceLocks ?? [])];
}

export function stepRetryPolicy(step: StepDefinition): StepRetryPolicy {
	return step.retry ?? { maxAttempts: 1 };
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

function readInputs(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): StepInputReference[] {
	if (!Array.isArray(value)) {
		addIssue(
			issues,
			"input_array",
			path,
			`${path} must be an array of { stepId, output } references`,
		);
		return [];
	}
	return value.map((item, index) => {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item)) {
			addIssue(
				issues,
				"input_object",
				itemPath,
				`${itemPath} must be an object`,
			);
			return { stepId: "", output: "" };
		}
		return {
			stepId: readNonEmptyString(item.stepId, `${itemPath}.stepId`, issues),
			output: readNonEmptyString(item.output, `${itemPath}.output`, issues),
		};
	});
}

function readNamedIdentifiers(
	value: unknown,
	path: string,
	pattern: RegExp,
	formatCode: string,
	duplicateCode: string,
	issues: PlanValidationIssue[],
): string[] {
	const names = readStringArray(value, path, issues);
	for (const [index, name] of names.entries()) {
		if (name.length > 0 && !pattern.test(name)) {
			addIssue(
				issues,
				formatCode,
				`${path}[${index}]`,
				`${path}[${index}] must match ${pattern}`,
			);
		}
	}
	if (new Set(names).size !== names.length) {
		addIssue(
			issues,
			duplicateCode,
			path,
			`${path} must not contain duplicates`,
		);
	}
	return names;
}

function readDeclarations(
	value: Record<string, unknown>,
	path: string,
	issues: PlanValidationIssue[],
): Partial<StepDefinitionCommon> {
	const declarations: Partial<StepDefinitionCommon> = {};
	if (value.inputs !== undefined) {
		declarations.inputs = readInputs(value.inputs, `${path}.inputs`, issues);
	}
	if (value.outputs !== undefined) {
		declarations.outputs = readNamedIdentifiers(
			value.outputs,
			`${path}.outputs`,
			OUTPUT_NAME_PATTERN,
			"output_format",
			"duplicate_output",
			issues,
		);
	}
	if (value.capabilities !== undefined) {
		const capabilities = readStringArray(
			value.capabilities,
			`${path}.capabilities`,
			issues,
		);
		for (const [index, capability] of capabilities.entries()) {
			if (
				capability.length > 0 &&
				!(STEP_CAPABILITIES as readonly string[]).includes(capability)
			) {
				addIssue(
					issues,
					"unknown_capability",
					`${path}.capabilities[${index}]`,
					`${path}.capabilities[${index}] must be one of ${STEP_CAPABILITIES.join(", ")}`,
				);
			}
		}
		declarations.capabilities = capabilities as StepCapability[];
	}
	if (value.pathLocks !== undefined) {
		declarations.pathLocks = readSafeRepositoryPaths(
			value.pathLocks,
			`${path}.pathLocks`,
			issues,
		);
	}
	if (value.resourceLocks !== undefined) {
		declarations.resourceLocks = readNamedIdentifiers(
			value.resourceLocks,
			`${path}.resourceLocks`,
			RESOURCE_LOCK_PATTERN,
			"resource_lock_format",
			"duplicate_resource_lock",
			issues,
		);
	}
	if (value.timeoutMs !== undefined) {
		if (
			!Number.isSafeInteger(value.timeoutMs) ||
			(value.timeoutMs as number) <= 0
		) {
			addIssue(
				issues,
				"invalid_timeout",
				`${path}.timeoutMs`,
				`${path}.timeoutMs must be a positive integer of milliseconds`,
			);
		} else {
			declarations.timeoutMs = value.timeoutMs as number;
		}
	}
	if (value.retry !== undefined) {
		const retry = value.retry;
		if (
			!isRecord(retry) ||
			!Number.isSafeInteger(retry.maxAttempts) ||
			(retry.maxAttempts as number) < 1 ||
			(retry.maxAttempts as number) > MAX_STEP_RETRY_ATTEMPTS
		) {
			addIssue(
				issues,
				"invalid_retry",
				`${path}.retry`,
				`${path}.retry.maxAttempts must be an integer from 1 to ${MAX_STEP_RETRY_ATTEMPTS}`,
			);
		} else {
			declarations.retry = { maxAttempts: retry.maxAttempts as number };
		}
	}
	return declarations;
}

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
		...readDeclarations(value, path, issues),
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
	let step: StepDefinition;
	switch (value.kind) {
		case "investigation":
			step = {
				...common,
				kind: "investigation",
				questions: readQuestions(value.questions, `${path}.questions`, issues),
			};
			break;
		case "change":
			step = {
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
			break;
		case "command":
			step = {
				...common,
				kind: "command",
				command: readCommandObject(value.command, `${path}.command`, issues),
			};
			break;
		case "approval":
			step = {
				...common,
				kind: "approval",
				prompt: readNonEmptyString(value.prompt, `${path}.prompt`, issues),
			};
			break;
		default:
			addIssue(
				issues,
				"step_kind",
				`${path}.kind`,
				`${path}.kind must be one of ${STEP_KINDS.join(", ")}`,
			);
			return { ...common, kind: "investigation", questions: [] };
	}
	if (common.capabilities) {
		const allowed = new Set<string>(KIND_CAPABILITIES[step.kind]);
		for (const [index, capability] of common.capabilities.entries()) {
			if (capability.length > 0 && !allowed.has(capability)) {
				addIssue(
					issues,
					"capability_not_allowed",
					`${path}.capabilities[${index}]`,
					`${path}.capabilities[${index}] exceeds the ${step.kind} step authority (allowed: ${KIND_CAPABILITIES[step.kind].join(", ") || "none"})`,
				);
			}
		}
	}
	return step;
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
	const outputsByStep = new Map(
		steps.map((step) => [step.id, new Set(step.outputs ?? [])]),
	);
	for (const [stepIndex, step] of steps.entries()) {
		const dependencies = new Set(step.dependencies);
		for (const [inputIndex, input] of (step.inputs ?? []).entries()) {
			const inputPath = `steps[${stepIndex}].inputs[${inputIndex}]`;
			if (input.stepId.length === 0 || input.output.length === 0) {
				continue;
			}
			if (!dependencies.has(input.stepId)) {
				addIssue(
					issues,
					"input_without_dependency",
					inputPath,
					`step ${step.id} consumes an output of ${input.stepId} without declaring it as a dependency`,
				);
			} else if (!outputsByStep.get(input.stepId)?.has(input.output)) {
				addIssue(
					issues,
					"unknown_input_output",
					inputPath,
					`step ${input.stepId} does not declare output ${input.output}`,
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

export function topologicalStepIds(plan: WorkflowPlan): string[] {
	return topologicalIds(plan.steps);
}

export function validateWorkflowPlan(value: unknown): WorkflowPlan {
	const result = validateWorkflowPlanResult(value);
	if (!result.ok) {
		throw new PlanValidationError(result.issues);
	}
	return result.plan;
}
