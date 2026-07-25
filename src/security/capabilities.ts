import {
	STEP_KIND_CAPABILITY_MAXIMA,
	type StepDefinition,
} from "../domain/steps.js";
import {
	CAPABILITY_PROFILE_NAMES,
	type CapabilityProfile,
	type CapabilityProfileName,
	type RunCapabilityProfiles,
	STEP_CAPABILITIES,
	type StepCapability,
} from "../domain/types.js";

/**
 * Every worker tool belongs to exactly one capability, so a tool allowlist
 * is always derivable from, and verifiable against, a capability set.
 * External-effect tools (deploy, publish, cloud administration) have no
 * entry here and therefore can never appear in a valid profile.
 */
export const CAPABILITY_TOOLS: Record<StepCapability, readonly string[]> = {
	"read-repository": ["read", "grep", "find", "ls"],
	"execute-commands": ["bash"],
	"mutate-repository": ["edit", "write"],
};

// Deterministic tool order: read tools, execution, then mutation, matching
// the historical fixed-role allowlists byte for byte.
const CAPABILITY_ORDER: readonly StepCapability[] = [
	"read-repository",
	"execute-commands",
	"mutate-repository",
];

const TOOL_CAPABILITY = new Map<string, StepCapability>(
	CAPABILITY_ORDER.flatMap((capability) =>
		CAPABILITY_TOOLS[capability].map((tool) => [tool, capability] as const),
	),
);

export function toolCapability(tool: string): StepCapability | undefined {
	return TOOL_CAPABILITY.get(tool);
}

function orderedCapabilities(
	capabilities: readonly StepCapability[],
): StepCapability[] {
	const requested = new Set(capabilities);
	return CAPABILITY_ORDER.filter((capability) => requested.has(capability));
}

/** Derives the least-authority profile granting exactly these capabilities. */
export function capabilityProfileFor(
	capabilities: readonly StepCapability[],
): CapabilityProfile {
	for (const capability of capabilities) {
		if (!(STEP_CAPABILITIES as readonly string[]).includes(capability)) {
			throw new Error(`Unknown capability: ${capability}`);
		}
	}
	const ordered = orderedCapabilities(capabilities);
	return {
		capabilities: ordered,
		tools: ordered.flatMap((capability) => [...CAPABILITY_TOOLS[capability]]),
		resourceDiscovery: "disabled",
		externalEffects: "forbidden",
	};
}

/**
 * Narrows a frozen profile to the capabilities a step actually declared.
 * The result only ever removes authority: capabilities outside the frozen
 * profile stay absent, and tools never exceed the frozen allowlist.
 */
export function narrowCapabilityProfile(
	profile: CapabilityProfile,
	declared: readonly StepCapability[],
): CapabilityProfile {
	const kept = new Set(
		profile.capabilities.filter((capability) => declared.includes(capability)),
	);
	return {
		capabilities: orderedCapabilities([...kept]),
		tools: profile.tools.filter((tool) => {
			const capability = toolCapability(tool);
			return capability !== undefined && kept.has(capability);
		}),
		resourceDiscovery: "disabled",
		externalEffects: "forbidden",
	};
}

/**
 * The maximum authority each profile may hold. Step-kind profiles share the
 * plan schema's kind maxima; the review and repair archetypes mirror the
 * historical reviewer and repair worker authority.
 */
export const CAPABILITY_PROFILE_MAXIMA: Record<
	CapabilityProfileName,
	readonly StepCapability[]
> = {
	investigation: STEP_KIND_CAPABILITY_MAXIMA.investigation,
	change: STEP_KIND_CAPABILITY_MAXIMA.change,
	command: STEP_KIND_CAPABILITY_MAXIMA.command,
	approval: STEP_KIND_CAPABILITY_MAXIMA.approval,
	review: ["read-repository"],
	repair: ["read-repository", "mutate-repository", "execute-commands"],
};

/** The default profile snapshot frozen into new run security policies. */
export function defaultCapabilityProfiles(): RunCapabilityProfiles {
	const profiles = {} as RunCapabilityProfiles;
	for (const name of CAPABILITY_PROFILE_NAMES) {
		profiles[name] = capabilityProfileFor(CAPABILITY_PROFILE_MAXIMA[name]);
	}
	return profiles;
}

/**
 * Resolves the frozen authority of one workflow step: the step kind's frozen
 * profile narrowed to the capabilities the step declared.
 */
export function stepCapabilityProfile(
	profiles: RunCapabilityProfiles,
	step: StepDefinition,
): CapabilityProfile {
	const declared = step.capabilities ?? [
		...STEP_KIND_CAPABILITY_MAXIMA[step.kind],
	];
	return narrowCapabilityProfile(profiles[step.kind], declared);
}

/**
 * The external-effect boundary every profile carries: no capability can
 * express deployment, publishing, cloud administration, or other remote
 * mutations, so they stay disabled until safely supported.
 */
export const EXTERNAL_EFFECT_BOUNDARY =
	"External effects forbidden: no deployment, publishing, cloud administration, or remote mutation authority exists in any capability profile";

/** One bounded human-readable line describing a profile's authority. */
export function describeCapabilityProfile(profile: CapabilityProfile): string {
	return `capabilities: ${profile.capabilities.join(", ") || "none"}; tools: ${profile.tools.join(", ") || "none"}; external effects: ${profile.externalEffects}`;
}

export class CapabilityViolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CapabilityViolationError";
	}
}

/**
 * Enforces the approved capability boundary against observed worker output:
 * a worker whose profile lacks `mutate-repository` must leave the repository
 * untouched, whatever its prompt claimed or its tools allowed.
 */
export function assertCapabilityBoundary(
	profile: CapabilityProfile,
	observed: { changedPaths: readonly string[] },
): void {
	if (
		observed.changedPaths.length > 0 &&
		!profile.capabilities.includes("mutate-repository")
	) {
		const paths = [...new Set(observed.changedPaths)].join(", ");
		throw new CapabilityViolationError(
			`Observed repository mutations without the mutate-repository capability (approved: ${profile.capabilities.join(", ") || "none"}): ${paths}`,
		);
	}
}

export function assertCapabilityProfiles(
	value: unknown,
	path: string,
): asserts value is RunCapabilityProfiles {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	const profiles = value as Record<string, unknown>;
	const names = Object.keys(profiles);
	if (
		names.length !== CAPABILITY_PROFILE_NAMES.length ||
		CAPABILITY_PROFILE_NAMES.some((name) => !names.includes(name))
	) {
		throw new Error(
			`${path} must declare exactly the profiles ${CAPABILITY_PROFILE_NAMES.join(", ")}`,
		);
	}
	for (const name of CAPABILITY_PROFILE_NAMES) {
		const profilePath = `${path}.${name}`;
		const profile = profiles[name];
		if (
			typeof profile !== "object" ||
			profile === null ||
			Array.isArray(profile)
		) {
			throw new Error(`${profilePath} must be an object`);
		}
		const record = profile as Record<string, unknown>;
		if (record.resourceDiscovery !== "disabled") {
			throw new Error(`${profilePath}.resourceDiscovery must be disabled`);
		}
		if (record.externalEffects !== "forbidden") {
			throw new Error(`${profilePath}.externalEffects must be forbidden`);
		}
		const capabilities = record.capabilities;
		if (!Array.isArray(capabilities)) {
			throw new Error(`${profilePath}.capabilities must be an array`);
		}
		const maxima = CAPABILITY_PROFILE_MAXIMA[name];
		for (const capability of capabilities) {
			if (
				!(STEP_CAPABILITIES as readonly string[]).includes(String(capability))
			) {
				throw new Error(
					`${profilePath}.capabilities contains an unknown capability`,
				);
			}
			if (!maxima.includes(capability as StepCapability)) {
				throw new Error(
					`${profilePath}.capabilities exceeds the ${name} profile authority`,
				);
			}
		}
		if (new Set(capabilities).size !== capabilities.length) {
			throw new Error(
				`${profilePath}.capabilities must not contain duplicates`,
			);
		}
		const tools = record.tools;
		if (!Array.isArray(tools)) {
			throw new Error(`${profilePath}.tools must be an array`);
		}
		if (new Set(tools).size !== tools.length) {
			throw new Error(`${profilePath}.tools must not contain duplicates`);
		}
		for (const tool of tools) {
			const capability = toolCapability(String(tool));
			if (capability === undefined) {
				throw new Error(
					`${profilePath}.tools contains a tool outside the capability vocabulary: ${String(tool)}`,
				);
			}
			if (!(capabilities as unknown[]).includes(capability)) {
				throw new Error(
					`${profilePath}.tools grants ${String(tool)} without the ${capability} capability`,
				);
			}
		}
	}
}
