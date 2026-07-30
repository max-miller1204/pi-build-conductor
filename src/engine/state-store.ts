import type { WorkflowRunState } from "./workflow-state.js";

/**
 * The persistence surface the engine needs. It matches the run store's
 * load-and-transaction shape so a persisted orchestration run can back it.
 */
export interface WorkflowStateStore {
	load(runId: string): Promise<WorkflowRunState>;
	transaction(
		runId: string,
		mutate: (current: WorkflowRunState) => WorkflowRunState,
	): Promise<WorkflowRunState>;
}

/**
 * An in-process store with the same serialization guarantee as the durable
 * one: transactions never interleave, and callers never share mutable state.
 */
export class InMemoryWorkflowStateStore implements WorkflowStateStore {
	private readonly runs = new Map<string, WorkflowRunState>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(...runs: WorkflowRunState[]) {
		for (const run of runs) {
			this.save(run);
		}
	}

	save(run: WorkflowRunState): void {
		this.runs.set(run.id, structuredClone(run));
	}

	async load(runId: string): Promise<WorkflowRunState> {
		const run = this.runs.get(runId);
		if (!run) {
			throw new Error(`Unknown run: ${runId}`);
		}
		return structuredClone(run);
	}

	async transaction(
		runId: string,
		mutate: (current: WorkflowRunState) => WorkflowRunState,
	): Promise<WorkflowRunState> {
		const result = this.queue.then(async () => {
			const current = await this.load(runId);
			const next = mutate(current);
			if (next.id !== runId) {
				throw new Error("A transaction must not change the run id");
			}
			this.save(next);
			return structuredClone(next);
		});
		this.queue = result.catch(() => undefined);
		return result;
	}
}
