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
	options: { failSetModel?: boolean } = {},
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
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1) {
				return;
			}
			let request: { type: string; command?: { type: string } };
			try {
				request = JSON.parse(buffer.slice(0, newline)) as typeof request;
			} catch (error) {
				socket.end(
					`${JSON.stringify({ type: "error", ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
				);
				return;
			}
			requests.push(request);
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
