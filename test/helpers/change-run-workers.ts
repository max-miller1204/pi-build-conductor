import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewCategory } from "../../src/domain/types.js";
import { reviewStepId } from "../../src/engine/steps/review.js";
import {
	REVIEW_REPORT_END,
	REVIEW_REPORT_START,
} from "../../src/review/review-report.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerInstance,
} from "../../src/workers/backend.js";

/** The exit code and run id the live change run crash fixture uses. */
export const CHANGE_RUN_CRASH_EXIT_CODE = 93;
export const CHANGE_RUN_CRASH_RUN_ID = "run-change-crash";

export interface ScriptedFinding {
	/** The review step that reports it, defaulting to the first security review. */
	stepId?: string;
	/** The repository path the finding names. */
	path: string;
}

/**
 * A worker backend for live change runs: the change worker implements the
 * feature, reviewers report the scripted finding once, and the repair worker
 * creates the file that finding asked for.
 */
export class ChangeRunWorkers implements WorkerBackend {
	readonly workers = new Map<string, WorkerInstance>();
	readonly labels: string[] = [];
	readonly prompts: string[] = [];
	/** Set to fail the next change worker, as a first attempt would. */
	failNextChange = false;
	/** Awaited by the change worker before it reports, to hold a run open. */
	onChangeWorker?: () => Promise<void>;
	private next = 1;

	constructor(private readonly finding?: ScriptedFinding) {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		const worker: WorkerInstance = {
			id: `worker-${this.next++}`,
			status: "online",
			cwd: request.cwd,
			...(request.label ? { label: request.label } : {}),
		};
		this.workers.set(worker.id, worker);
		this.labels.push(request.label ?? "");
		return worker;
	}

	async list(): Promise<WorkerInstance[]> {
		return [...this.workers.values()];
	}

	async status(workerId: string): Promise<WorkerInstance> {
		const worker = this.workers.get(workerId);
		if (!worker) {
			throw new Error(`Unknown worker ${workerId}`);
		}
		return worker;
	}

	async startPrompt(
		workerId: string,
		prompt: string,
	): Promise<WorkerExecution> {
		this.prompts.push(prompt);
		const worker = await this.status(workerId);
		if (prompt.includes("You are the change worker")) {
			if (this.failNextChange) {
				this.failNextChange = false;
				return {
					completion: Promise.resolve({
						status: "failed",
						error: "The implementation worker gave up",
					}),
				};
			}
			await this.write(worker.cwd, "result.txt", "implemented\n");
			const gate = this.onChangeWorker?.();
			return {
				completion: (async () => {
					await gate;
					return { status: "succeeded" as const };
				})(),
			};
		}
		if (prompt.includes("You are the repair worker")) {
			await this.write(worker.cwd, "review-fix.txt", "repaired\n");
			return { completion: Promise.resolve({ status: "succeeded" }) };
		}
		const category = /independent ([a-z]+) reviewer/.exec(prompt)?.[1];
		const stepId = /step (review-[0-9]+-[a-z]+)\./.exec(prompt)?.[1];
		const baseCommit = /at commit ([0-9a-f]{40,64})/.exec(prompt)?.[1];
		if (!category || !stepId || !baseCommit) {
			throw new Error(`Unexpected worker prompt: ${prompt.slice(0, 160)}`);
		}
		const reporting =
			this.finding?.stepId ?? reviewStepId(1, "security" as ReviewCategory);
		const findings =
			this.finding && stepId === reporting
				? [
						{
							severity: "high",
							confidence: "high",
							title: "Missing review fix",
							description: "The implementation needs the required review fix.",
							paths: [this.finding.path],
							recommendation: "Create the review fix file.",
						},
					]
				: [];
		return {
			completion: Promise.resolve({
				status: "succeeded",
				output: `${REVIEW_REPORT_START}\n${JSON.stringify({
					version: 1,
					category,
					baseCommit,
					summary:
						findings.length > 0 ? "One important finding" : "No findings",
					findings,
				})}\n${REVIEW_REPORT_END}`,
			}),
		};
	}

	async stop(workerId: string): Promise<void> {
		const worker = await this.status(workerId);
		worker.status = "stopped";
	}

	private async write(cwd: string, name: string, body: string): Promise<void> {
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(join(cwd, "src", name), body);
	}
}
