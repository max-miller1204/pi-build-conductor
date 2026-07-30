import type { StepDefinition } from "../../domain/steps.js";
import type { CapabilityProfile } from "../../domain/types.js";
import type { GitClient } from "../../git/git.js";
import { assertCapabilityBoundary } from "../../security/capabilities.js";
import type { Workspace } from "../workspaces.js";

export class UnsupportedStepOutputError extends Error {
	constructor(
		step: StepDefinition,
		unsupported: string[],
		supported: string[],
	) {
		super(
			`${step.kind} step ${step.id} cannot produce output${
				unsupported.length === 1 ? "" : "s"
			} ${unsupported.join(", ")}; supported outputs: ${
				supported.join(", ") || "none"
			}`,
		);
		this.name = "UnsupportedStepOutputError";
	}
}

/**
 * Rejects a plan that asks a handler for an artifact it has no way to
 * produce, before any worker or command runs.
 */
export function assertSupportedOutputs(
	step: StepDefinition,
	supported: readonly string[],
): void {
	const unsupported = (step.outputs ?? []).filter(
		(output) => !supported.includes(output),
	);
	if (unsupported.length > 0) {
		throw new UnsupportedStepOutputError(step, unsupported, [...supported]);
	}
}

/**
 * Enforces the read-only boundary of a step without mutate-repository
 * authority: the workspace it was given must come back unchanged.
 */
export async function assertUnchangedWorkspace(
	git: Pick<GitClient, "status">,
	profile: CapabilityProfile,
	workspace: Workspace,
): Promise<void> {
	if (profile.capabilities.includes("mutate-repository") || !workspace.path) {
		return;
	}
	const status = await git.status(workspace.path);
	const changedPaths = status
		.split("\n")
		.map((line) => line.slice(3).trim())
		.filter((path) => path.length > 0);
	assertCapabilityBoundary(profile, { changedPaths });
}
