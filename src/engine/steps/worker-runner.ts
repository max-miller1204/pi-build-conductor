import type {
	CapabilityProfile,
	RunSecurityPolicy,
	WorkerRole,
	WorkerUiRequest,
} from "../../domain/types.js";
import {
	blockedWorkerResponse,
	stepWorkerLaunchPolicy,
} from "../../security/policy.js";
import type { AttemptLogStore } from "../../storage/attempt-log-store.js";
import type {
	WorkerBackend,
	WorkerExecutionResult,
	WorkerProgressEvent,
	WorkerUiResponder,
} from "../../workers/backend.js";

export const DEFAULT_WORKER_POLL_INTERVAL_MS = 2_000;
const MAX_CONSECUTIVE_STATUS_FAILURES = 3;

export interface StepWorkerProgress {
	runId: string;
	stepId: string;
	attemptId: string;
	workerId: string;
	event: WorkerProgressEvent;
}

export type StepWorkerSpawn = Omit<StepWorkerProgress, "event">;

export interface StepWorkerRunnerOptions {
	workers: WorkerBackend;
	securityPolicy: RunSecurityPolicy;
	pollIntervalMs?: number;
	provider?: string;
	model?: string;
	attemptLogs?: AttemptLogStore;
	onSpawn?: (spawn: StepWorkerSpawn) => Promise<void>;
	onProgress?: (progress: StepWorkerProgress) => void;
}

export interface StepWorkerRequest {
	runId: string;
	stepId: string;
	attemptId: string;
	/** The historical worker role whose allowlist bounds this step. */
	role: WorkerRole;
	profile: CapabilityProfile;
	cwd: string;
	prompt: string;
	signal: AbortSignal;
}

export type StepWorkerOutcome =
	| { status: "succeeded"; workerId: string; output?: string }
	| { status: "failed"; workerId?: string; error: string }
	| { status: "cancelled"; workerId?: string; error: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one Pi worker for one workflow step attempt: it launches under the
 * step's narrowed allowlist, streams progress, answers blocked UI requests
 * from the run policy, watches for a worker that dies without settling, and
 * always stops the process it started.
 */
export class StepWorkerRunner {
	private readonly pollIntervalMs: number;

	constructor(private readonly options: StepWorkerRunnerOptions) {
		this.pollIntervalMs =
			options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
		if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
			throw new Error("pollIntervalMs must be a positive finite number");
		}
	}

	async run(request: StepWorkerRequest): Promise<StepWorkerOutcome> {
		if (request.signal.aborted) {
			return {
				status: "cancelled",
				error: errorMessage(request.signal.reason ?? new Error("Cancelled")),
			};
		}
		const launchPolicy = stepWorkerLaunchPolicy(
			this.options.securityPolicy,
			request.role,
			request.profile,
		);
		const controller = new AbortController();
		const forwardAbort = () => {
			controller.abort(request.signal.reason);
		};
		request.signal.addEventListener("abort", forwardAbort, { once: true });
		let poll: NodeJS.Timeout | undefined;
		let workerId: string | undefined;
		try {
			const worker = await this.options.workers.spawn({
				cwd: request.cwd,
				label: `pi-orchestrator:${request.runId}:${request.attemptId}:${request.stepId}`,
				...(launchPolicy ? { launchPolicy } : {}),
				...(this.options.provider && this.options.model
					? { provider: this.options.provider, model: this.options.model }
					: {}),
			});
			workerId = worker.id;
			await this.options.onSpawn?.({
				runId: request.runId,
				stepId: request.stepId,
				attemptId: request.attemptId,
				workerId,
			});
			const execution = await this.options.workers.startPrompt(
				worker.id,
				request.prompt,
				{
					signal: controller.signal,
					onEvent: (event) => {
						this.emit(request, worker.id, event);
					},
					onUiRequest: (uiRequest, respond) =>
						this.answerUiRequest(request, worker.id, uiRequest, respond),
				},
			);
			poll = this.startStatusPolling(worker.id, controller);
			const result = await execution.completion.catch(
				(error: unknown): WorkerExecutionResult => ({
					status: "failed",
					error: errorMessage(error),
				}),
			);
			clearInterval(poll);
			poll = undefined;
			const cleanupError = await this.stopWorker(worker.id);
			await this.recordTerminalLog(request, result, cleanupError);
			if (cleanupError) {
				return {
					status: "failed",
					workerId: worker.id,
					error: `Failed to stop worker ${worker.id}: ${cleanupError}`,
				};
			}
			if (result.status === "succeeded") {
				return {
					status: "succeeded",
					workerId: worker.id,
					...(result.output === undefined ? {} : { output: result.output }),
				};
			}
			return {
				status: request.signal.aborted ? "cancelled" : "failed",
				workerId: worker.id,
				error: result.error,
			};
		} catch (error) {
			let message = errorMessage(error);
			if (workerId) {
				const cleanupError = await this.stopWorker(workerId);
				if (cleanupError) {
					message += `; failed to stop worker: ${cleanupError}`;
				}
			}
			return {
				status: request.signal.aborted ? "cancelled" : "failed",
				...(workerId ? { workerId } : {}),
				error: message,
			};
		} finally {
			if (poll) {
				clearInterval(poll);
			}
			request.signal.removeEventListener("abort", forwardAbort);
		}
	}

	private emit(
		request: StepWorkerRequest,
		workerId: string,
		event: WorkerProgressEvent,
	): void {
		try {
			this.options.attemptLogs?.record(request.runId, request.attemptId, event);
		} catch {
			// Output capture must never affect worker execution.
		}
		try {
			this.options.onProgress?.({
				runId: request.runId,
				stepId: request.stepId,
				attemptId: request.attemptId,
				workerId,
				event,
			});
		} catch {
			// UI observers must not affect worker execution.
		}
	}

	private async answerUiRequest(
		request: StepWorkerRequest,
		workerId: string,
		uiRequest: WorkerUiRequest,
		respond: WorkerUiResponder,
	): Promise<void> {
		const policy = this.options.securityPolicy.workers.uiPolicy;
		const response = blockedWorkerResponse(policy, uiRequest);
		this.emit(request, workerId, {
			type: "ui_decision",
			requestId: uiRequest.id,
			method: uiRequest.method,
			policy,
			outcome: response.kind === "confirmation" ? "declined" : "cancelled",
		});
		await respond(response);
	}

	private startStatusPolling(
		workerId: string,
		controller: AbortController,
	): NodeJS.Timeout {
		let polling = false;
		let consecutiveFailures = 0;
		const poll = setInterval(() => {
			if (polling || controller.signal.aborted) {
				return;
			}
			polling = true;
			void this.options.workers
				.status(workerId)
				.then((worker) => {
					consecutiveFailures = 0;
					if (worker.status === "error" || worker.status === "stopped") {
						controller.abort(
							new Error(
								`Worker ${workerId} entered ${worker.status} status before Pi settled`,
							),
						);
					}
				})
				.catch((error: unknown) => {
					consecutiveFailures += 1;
					if (consecutiveFailures >= MAX_CONSECUTIVE_STATUS_FAILURES) {
						controller.abort(
							new Error(
								`Worker ${workerId} status checks failed: ${errorMessage(error)}`,
							),
						);
					}
				})
				.finally(() => {
					polling = false;
				});
		}, this.pollIntervalMs);
		poll.unref();
		return poll;
	}

	private async stopWorker(workerId: string): Promise<string | undefined> {
		try {
			await this.options.workers.stop(workerId);
			return undefined;
		} catch (error) {
			return errorMessage(error);
		}
	}

	private async recordTerminalLog(
		request: StepWorkerRequest,
		result: WorkerExecutionResult,
		cleanupError: string | undefined,
	): Promise<void> {
		const logs = this.options.attemptLogs;
		if (!logs) {
			return;
		}
		try {
			logs.recordTerminal(
				request.runId,
				request.attemptId,
				result.status === "aborted" ? "aborted" : result.status,
				cleanupError ??
					(result.status === "succeeded" ? undefined : result.error),
			);
			await logs.flush(request.runId, request.attemptId);
		} catch {
			// Output capture must never invalidate otherwise correct work.
		}
	}
}
