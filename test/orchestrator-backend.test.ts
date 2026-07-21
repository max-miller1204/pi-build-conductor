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
				if (request.type === "spawn") {
					socket.end(
						`${JSON.stringify({ type: "spawn_result", ok: true, instance })}\n`,
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
