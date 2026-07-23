import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OfficialOrchestratorBackend } from "../src/workers/orchestrator-backend.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

interface UiRequestFrame {
	type: "extension_ui_request";
	id: string;
	method: string;
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
}

async function fakeUiOrchestrator(
	uiRequest: UiRequestFrame,
	options: {
		requestBeforePromptResponse?: boolean;
		settleAfterRequestTimeoutMs?: number;
	} = {},
): Promise<{ socketPath: string; requests: unknown[] }> {
	const directory = await mkdtemp(
		join(tmpdir(), "pi-build-conductor-ui-orchestrator-"),
	);
	directories.push(directory);
	const socketPath = join(directory, "orchestrator.sock");
	const requests: unknown[] = [];
	const server = createServer((socket) => {
		let buffer = "";
		let streaming = false;
		const settle = () => {
			socket.write(
				`${JSON.stringify({
					type: "agent_end",
					messages: [
						{
							role: "assistant",
							stopReason: "stop",
							content: [{ type: "text", text: "Dialog handled" }],
						},
					],
				})}\n${JSON.stringify({ type: "agent_settled" })}\n`,
			);
		};
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) {
					return;
				}
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const request = JSON.parse(line) as {
					id?: string;
					type: string;
				};
				requests.push(request);
				if (!streaming && request.type === "rpc_stream") {
					streaming = true;
					socket.write(`${JSON.stringify({ type: "rpc_ready", ok: true })}\n`);
					continue;
				}
				if (request.type === "prompt") {
					const response = {
						id: request.id,
						type: "response",
						command: "prompt",
						success: true,
					};
					const frames = options.requestBeforePromptResponse
						? [uiRequest, response]
						: [response, uiRequest];
					for (const frame of frames) {
						socket.write(`${JSON.stringify(frame)}\n`);
					}
					if (options.settleAfterRequestTimeoutMs !== undefined) {
						setTimeout(settle, options.settleAfterRequestTimeoutMs).unref();
					}
					continue;
				}
				if (request.type === "extension_ui_response") {
					settle();
				}
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return { socketPath, requests };
}

async function fakeOrchestrator(
	options: {
		failExecution?: boolean;
		failSetModel?: boolean;
		eventsBeforePromptResponse?: boolean;
	} = {},
): Promise<{
	socketPath: string;
	requests: unknown[];
}> {
	const directory = await mkdtemp(
		join(tmpdir(), "pi-build-conductor-orchestrator-"),
	);
	directories.push(directory);
	const socketPath = join(directory, "orchestrator.sock");
	const requests: unknown[] = [];
	const instance = {
		id: "worker-1",
		status: "online",
		cwd: "/repo/worktree",
		label: "run-1:implementation",
	};
	const server = createServer((socket) => {
		let buffer = "";
		let streaming = false;
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) {
					return;
				}
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				let request: {
					id?: string;
					type: string;
					command?: { type: string };
					launchPolicy?: unknown;
				};
				try {
					request = JSON.parse(line) as typeof request;
				} catch (error) {
					socket.end(
						`${JSON.stringify({ type: "error", ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
					);
					return;
				}
				requests.push(request);
				if (streaming) {
					const response = {
						id: request.id,
						type: "response",
						command: request.type,
						success: true,
					};
					const events = [
						{ type: "agent_start" },
						{ type: "tool_execution_start", toolName: "bash" },
						{
							type: "tool_execution_end",
							toolName: "bash",
							isError: false,
						},
						{
							type: "agent_end",
							messages: [
								options.failExecution
									? {
											role: "assistant",
											stopReason: "error",
											errorMessage: "provider failed",
										}
									: {
											role: "assistant",
											stopReason: "stop",
											content: [{ type: "text", text: "Done" }],
										},
							],
						},
						{ type: "agent_settled" },
					];
					const messages = options.eventsBeforePromptResponse
						? [...events, response]
						: [response, ...events];
					for (const message of messages) {
						socket.write(`${JSON.stringify(message)}\n`);
					}
					continue;
				}
				if (request.type === "rpc_stream") {
					streaming = true;
					socket.write(
						`${JSON.stringify({ type: "rpc_ready", ok: true, instance })}\n`,
					);
					continue;
				}
				if (request.type === "capabilities") {
					socket.end(
						`${JSON.stringify({
							type: "capabilities_result",
							ok: true,
							capabilities: { workerLaunchPolicyVersions: [1] },
						})}\n`,
					);
					return;
				}
				if (request.type === "spawn") {
					socket.end(
						`${JSON.stringify({
							type: "spawn_result",
							ok: true,
							instance: request.launchPolicy
								? { ...instance, appliedPolicy: request.launchPolicy }
								: instance,
						})}\n`,
					);
					return;
				}
				if (request.type === "rpc") {
					const failed =
						options.failSetModel && request.command?.type === "set_model";
					socket.end(
						`${JSON.stringify({
							type: "rpc_result",
							ok: true,
							response: {
								success: !failed,
								command: request.command?.type,
								...(failed ? { error: "model unavailable" } : {}),
							},
						})}\n`,
					);
					return;
				}
				if (request.type === "status") {
					socket.end(
						`${JSON.stringify({ type: "status_result", ok: true, instance })}\n`,
					);
					return;
				}
				if (request.type === "list") {
					socket.end(
						`${JSON.stringify({ type: "list_result", ok: true, instances: [instance] })}\n`,
					);
					return;
				}
				socket.end(
					`${JSON.stringify({ type: "stop_result", ok: true, instanceId: instance.id })}\n`,
				);
				return;
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return { socketPath, requests };
}

describe("OfficialOrchestratorBackend", () => {
	it("streams worker progress through terminal completion", async () => {
		const fake = await fakeOrchestrator({
			eventsBeforePromptResponse: true,
		});
		const backend = new OfficialOrchestratorBackend({
			socketPath: fake.socketPath,
		});
		const events: string[] = [];

		const execution = await backend.startPrompt(
			"worker-1",
			"Implement the task",
			{ onEvent: (event) => events.push(event.type) },
		);

		expect(await execution.completion).toEqual({
			status: "succeeded",
			output: "Done",
		});
		expect(events).toEqual(["agent_started", "tool_started", "tool_finished"]);
		expect(fake.requests.slice(0, 2)).toEqual([
			{ type: "rpc_stream", instanceId: "worker-1" },
			{
				id: "conductor_prompt",
				type: "prompt",
				message: "Implement the task",
			},
		]);
	});

	it.each([
		{
			name: "select",
			request: {
				type: "extension_ui_request" as const,
				id: "dialog-select",
				method: "select",
				title: "Choose safely",
				options: ["first", "second"],
			},
			answer: { kind: "value" as const, value: "second" },
			wire: {
				type: "extension_ui_response",
				id: "dialog-select",
				value: "second",
			},
			outcome: "responded",
		},
		{
			name: "confirm",
			request: {
				type: "extension_ui_request" as const,
				id: "dialog-confirm",
				method: "confirm",
				title: "Allow action?",
				message: "This changes files",
			},
			answer: { kind: "confirmation" as const, confirmed: false },
			wire: {
				type: "extension_ui_response",
				id: "dialog-confirm",
				confirmed: false,
			},
			outcome: "declined",
		},
		{
			name: "input",
			request: {
				type: "extension_ui_request" as const,
				id: "dialog-input",
				method: "input",
				title: "Provide secret",
				placeholder: "token",
			},
			answer: { kind: "cancelled" as const },
			wire: {
				type: "extension_ui_response",
				id: "dialog-input",
				cancelled: true,
			},
			outcome: "cancelled",
		},
		{
			name: "editor",
			request: {
				type: "extension_ui_request" as const,
				id: "dialog-editor",
				method: "editor",
				title: "Edit content",
				prefill: "original",
			},
			answer: { kind: "value" as const, value: "updated" },
			wire: {
				type: "extension_ui_response",
				id: "dialog-editor",
				value: "updated",
			},
			outcome: "responded",
		},
	])(
		"answers a blocking $name request on its owning stream",
		async ({ request, answer, wire, outcome }) => {
			const fake = await fakeUiOrchestrator(request, {
				requestBeforePromptResponse: true,
			});
			const backend = new OfficialOrchestratorBackend({
				socketPath: fake.socketPath,
			});
			const events: unknown[] = [];

			const execution = await backend.startPrompt("worker-1", "Implement it", {
				onEvent: (event) => events.push(event),
				onUiRequest: async (_received, respond) => respond(answer),
			});

			expect(await execution.completion).toEqual({
				status: "succeeded",
				output: "Dialog handled",
			});
			expect(fake.requests[2]).toEqual(wire);
			expect(events).toContainEqual({
				type: "ui_blocked",
				requestId: request.id,
				method: request.method,
			});
			expect(events).toContainEqual({
				type: "ui_resolved",
				requestId: request.id,
				method: request.method,
				outcome,
			});
		},
	);

	it("ignores fire-and-forget extension UI events", async () => {
		const fake = await fakeUiOrchestrator(
			{
				type: "extension_ui_request",
				id: "notification",
				method: "notify",
				message: "Worker notice",
			},
			{ settleAfterRequestTimeoutMs: 5 },
		);
		const backend = new OfficialOrchestratorBackend({
			socketPath: fake.socketPath,
		});
		const events: string[] = [];
		let dialogRequests = 0;

		const execution = await backend.startPrompt("worker-1", "Implement it", {
			onEvent: (event) => events.push(event.type),
			onUiRequest: () => {
				dialogRequests += 1;
			},
		});

		expect(await execution.completion).toMatchObject({ status: "succeeded" });
		expect(dialogRequests).toBe(0);
		expect(events).not.toContain("ui_blocked");
		expect(
			fake.requests.filter(
				(request) =>
					(request as { type?: string }).type === "extension_ui_response",
			),
		).toEqual([]);
	});

	it("expires a timed request and rejects a late response", async () => {
		const fake = await fakeUiOrchestrator(
			{
				type: "extension_ui_request",
				id: "timed-dialog",
				method: "input",
				title: "Input",
				timeout: 5,
			},
			{ settleAfterRequestTimeoutMs: 30 },
		);
		const backend = new OfficialOrchestratorBackend({
			socketPath: fake.socketPath,
		});
		let lateResponse: (() => Promise<void>) | undefined;
		const events: string[] = [];

		const execution = await backend.startPrompt("worker-1", "Implement it", {
			onEvent: (event) => {
				if (event.type === "ui_resolved") {
					events.push(event.outcome);
				}
			},
			onUiRequest: (_request, respond) => {
				lateResponse = () => respond({ kind: "cancelled" });
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 15));
		if (!lateResponse) {
			throw new Error("UI request was not observed");
		}
		await expect(lateResponse()).rejects.toThrow(/no longer pending/);
		expect(await execution.completion).toMatchObject({ status: "succeeded" });
		expect(events).toContain("request_timeout");
		expect(
			fake.requests.filter(
				(request) =>
					(request as { type?: string }).type === "extension_ui_response",
			),
		).toEqual([]);
	});

	it("invalidates a blocked request when execution is cancelled", async () => {
		const fake = await fakeUiOrchestrator({
			type: "extension_ui_request",
			id: "cancelled-dialog",
			method: "editor",
			title: "Editor",
		});
		const backend = new OfficialOrchestratorBackend({
			socketPath: fake.socketPath,
		});
		const controller = new AbortController();
		const outcomes: string[] = [];
		const execution = await backend.startPrompt("worker-1", "Implement it", {
			signal: controller.signal,
			onEvent: (event) => {
				if (event.type === "ui_resolved") {
					outcomes.push(event.outcome);
				}
			},
			onUiRequest: () => {},
		});

		controller.abort(new Error("Run cancelled"));
		expect(await execution.completion).toEqual({
			status: "aborted",
			error: "Run cancelled",
		});
		expect(outcomes).toContain("execution_aborted");
	});

	it("records cancellation before prompt acceptance as an execution abort", async () => {
		const fake = await fakeUiOrchestrator(
			{
				type: "extension_ui_request",
				id: "early-cancelled-dialog",
				method: "confirm",
				title: "Confirm",
				message: "Continue?",
			},
			{ requestBeforePromptResponse: true },
		);
		const backend = new OfficialOrchestratorBackend({
			socketPath: fake.socketPath,
		});
		const controller = new AbortController();
		const outcomes: string[] = [];

		await expect(
			backend.startPrompt("worker-1", "Implement it", {
				signal: controller.signal,
				onEvent: (event) => {
					if (event.type === "ui_resolved") {
						outcomes.push(event.outcome);
					}
				},
				onUiRequest: () => controller.abort(new Error("Run cancelled")),
			}),
		).rejects.toThrow("Run cancelled");
		expect(outcomes).toEqual(["execution_aborted"]);
	});

	it("reports terminal Pi failures", async () => {
		const fake = await fakeOrchestrator({ failExecution: true });
		const backend = new OfficialOrchestratorBackend({
			socketPath: fake.socketPath,
		});

		const execution = await backend.startPrompt("worker-1", "Implement it");

		expect(await execution.completion).toEqual({
			status: "failed",
			error: "provider failed",
		});
	});

	it("preflights and verifies an applied worker launch policy", async () => {
		const fake = await fakeOrchestrator();
		const backend = new OfficialOrchestratorBackend({
			socketPath: fake.socketPath,
		});
		const launchPolicy = {
			version: 1 as const,
			role: "review" as const,
			tools: ["read", "grep", "find", "ls"],
			resourceDiscovery: "disabled" as const,
		};

		await backend.preflightPolicy(launchPolicy);
		const worker = await backend.spawn({
			cwd: "/repo/worktree",
			launchPolicy,
		});

		expect(worker.appliedPolicy).toEqual(launchPolicy);
		expect(fake.requests).toEqual([
			{ type: "capabilities" },
			{
				type: "spawn",
				cwd: "/repo/worktree",
				launchPolicy,
			},
		]);
	});

	it("isolates the first-party spawn and RPC protocol", async () => {
		const fake = await fakeOrchestrator();
		const backend = new OfficialOrchestratorBackend({
			socketPath: fake.socketPath,
		});

		const worker = await backend.spawn({
			cwd: "/repo/worktree",
			label: "run-1:implementation",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
		await backend.sendPrompt(worker.id, "Implement the task");

		expect(await backend.status(worker.id)).toEqual(worker);
		expect(await backend.list()).toEqual([worker]);
		await backend.stop(worker.id);
		expect(fake.requests).toEqual([
			{
				type: "spawn",
				cwd: "/repo/worktree",
				label: "run-1:implementation",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
			{
				type: "rpc",
				instanceId: "worker-1",
				command: {
					type: "set_model",
					provider: "anthropic",
					modelId: "claude-sonnet-4-5",
				},
			},
			{
				type: "rpc",
				instanceId: "worker-1",
				command: { type: "prompt", message: "Implement the task" },
			},
			{ type: "status", instanceId: "worker-1" },
			{ type: "list" },
			{ type: "stop", instanceId: "worker-1" },
		]);
	});

	it("stops a spawned worker when model configuration fails", async () => {
		const fake = await fakeOrchestrator({ failSetModel: true });
		const backend = new OfficialOrchestratorBackend({
			socketPath: fake.socketPath,
		});

		await expect(
			backend.spawn({
				cwd: "/repo/worktree",
				provider: "anthropic",
				model: "missing-model",
			}),
		).rejects.toThrow(/model unavailable/);
		expect(fake.requests.at(-1)).toEqual({
			type: "stop",
			instanceId: "worker-1",
		});
	});
});
