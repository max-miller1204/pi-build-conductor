import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
let packageJson;
try {
	packageJson = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
} catch (error) {
	throw new Error("Could not parse package.json", { cause: error });
}
const checkout = resolve(process.env.PI_COMPAT_CHECKOUT ?? "");
if (!process.env.PI_COMPAT_CHECKOUT) {
	throw new Error(
		"PI_COMPAT_CHECKOUT must point to the built compatible Pi checkout",
	);
}
const { stdout: checkoutCommit } = await execute("git", ["rev-parse", "HEAD"], {
	cwd: checkout,
});
if (checkoutCommit.trim() !== packageJson.conductorCompatibility.serverCommit) {
	throw new Error(
		`Compatible server checkout is ${checkoutCommit.trim()}, expected ${packageJson.conductorCompatibility.serverCommit}`,
	);
}
const serverCli = join(checkout, "packages", "server", "dist", "cli.js");
await access(serverCli);
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-build-server-compat-"));
const serverDirectory = join(temporaryRoot, "server");
const socketPath = join(serverDirectory, "server.sock");
const env = {
	...process.env,
	PI_CONFIG_DIR: join(temporaryRoot, "config"),
	PI_SERVER_DIR: serverDirectory,
};
const server = spawn(process.execPath, [serverCli, "serve"], {
	cwd: checkout,
	env,
	detached: process.platform !== "win32",
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
for (const stream of [server.stdout, server.stderr]) {
	stream.on("data", (chunk) => {
		logs = `${logs}${chunk}`.slice(-64 * 1024);
	});
}

async function stopServer() {
	if (server.exitCode !== null) return;
	if (process.platform === "win32") server.kill("SIGTERM");
	else process.kill(-server.pid, "SIGTERM");
	await Promise.race([
		new Promise((resolveExit) => server.once("exit", resolveExit)),
		new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
	]);
	if (server.exitCode === null) {
		if (process.platform === "win32") server.kill("SIGKILL");
		else process.kill(-server.pid, "SIGKILL");
	}
}

try {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(
				`Compatible server exited before creating its socket\n${logs}`,
			);
		}
		try {
			await access(socketPath);
			break;
		} catch {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
		}
	}
	await access(socketPath).catch(() => {
		throw new Error(`Timed out waiting for compatible server socket\n${logs}`);
	});
	await execute("npm", ["run", "test:server-compat"], {
		cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
		env: { ...process.env, PI_SERVER_SMOKE_SOCKET: socketPath },
		maxBuffer: 10 * 1024 * 1024,
	});
	process.stdout.write(
		`Compatible server smoke passed for ${packageJson.conductorCompatibility.serverCommit} with launch policy ${packageJson.conductorCompatibility.workerLaunchPolicyVersion}.\n`,
	);
} catch (error) {
	throw new Error(
		`${error instanceof Error ? error.message : String(error)}\n${logs}`,
	);
} finally {
	await stopServer();
	await rm(temporaryRoot, { recursive: true, force: true });
}
