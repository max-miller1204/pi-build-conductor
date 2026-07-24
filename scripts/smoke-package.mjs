import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piExecutable = resolve(repositoryRoot, "node_modules/.bin/pi");
const expectedCommands = [
	"build",
	"build-cancel",
	"build-follow",
	"build-list",
	"build-prune",
	"build-resume",
	"build-retry",
	"build-show",
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-build-package-smoke-"));

function parseJson(value, source) {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`Invalid JSON from ${source}`, { cause: error });
	}
}

function isolatedEnvironment(agentDirectory) {
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDirectory,
		PI_CONFIG_DIR: join(dirname(agentDirectory), "config"),
		PI_OFFLINE: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	delete env.GITHUB_TOKEN;
	delete env.GH_TOKEN;
	return env;
}

async function rpcCommands(env, extensionArguments) {
	const cwd = join(temporaryRoot, "fixture-repository");
	await mkdir(cwd, { recursive: true });
	await execute("git", ["init", "-q"], { cwd });
	const args = [
		"--mode",
		"rpc",
		"--offline",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-session",
		...extensionArguments,
	];
	const child = spawn(piExecutable, args, {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	let stdout = "";
	child.stderr.on("data", (chunk) => {
		stderr = `${stderr}${chunk}`.slice(-64 * 1024);
	});
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	try {
		const response = await new Promise((resolveResponse, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Pi RPC timed out\n${stderr}`)),
				30_000,
			);
			const inspect = () => {
				try {
					const lines = stdout.split("\n");
					stdout = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.trim()) continue;
						const message = parseJson(line, "Pi RPC");
						if (message.type === "extension_error") {
							clearTimeout(timer);
							reject(new Error(`Extension failed to load: ${line}\n${stderr}`));
							return;
						}
						if (message.type === "response" && message.id === "package-smoke") {
							clearTimeout(timer);
							resolveResponse(message);
							return;
						}
					}
				} catch (error) {
					clearTimeout(timer);
					reject(error);
				}
			};
			child.stdout.on("data", inspect);
			child.once("exit", (code, signal) => {
				clearTimeout(timer);
				reject(
					new Error(
						`Pi exited before the RPC response (${code ?? signal})\n${stderr}`,
					),
				);
			});
			child.stdin.write(
				`${JSON.stringify({ id: "package-smoke", type: "get_commands" })}\n`,
			);
		});
		if (!response.success) {
			throw new Error(`get_commands failed: ${JSON.stringify(response)}`);
		}
		const names = response.data?.commands?.map((command) => command.name) ?? [];
		for (const command of expectedCommands) {
			if (!names.includes(command)) {
				throw new Error(`Packed extension did not register /${command}`);
			}
		}
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			new Promise((resolveExit) => child.once("exit", resolveExit)),
			new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
}

async function smokePackedPackage() {
	const packDirectory = join(temporaryRoot, "pack");
	await mkdir(packDirectory);
	const { stdout } = await execute(
		"npm",
		["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
		{ cwd: repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
	);
	const [packed] = parseJson(stdout, "npm pack");
	if (!packed?.filename || !Array.isArray(packed.files)) {
		throw new Error(`Unexpected npm pack output: ${stdout}`);
	}
	const paths = packed.files.map((file) => file.path);
	for (const required of [
		"package.json",
		"README.md",
		"SECURITY.md",
		"LICENSE",
		"src/extension.ts",
	]) {
		if (!paths.includes(required))
			throw new Error(`Packed package is missing ${required}`);
	}
	const allowedRoots = new Set([
		"package.json",
		"README.md",
		"SECURITY.md",
		"LICENSE",
		"src",
	]);
	for (const path of paths) {
		if (!allowedRoots.has(path.split("/")[0])) {
			throw new Error(`Packed package contains unexpected path: ${path}`);
		}
	}
	const consumer = join(temporaryRoot, "consumer");
	await mkdir(consumer);
	await writeFile(
		join(consumer, "package.json"),
		'{"private":true,"type":"module"}\n',
		"utf8",
	);
	await execute(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--legacy-peer-deps",
			"--no-audit",
			"--no-fund",
			join(packDirectory, packed.filename),
		],
		{ cwd: consumer, maxBuffer: 10 * 1024 * 1024 },
	);
	const installedPackage = join(consumer, "node_modules", "pi-build-conductor");
	await rpcCommands(
		isolatedEnvironment(join(temporaryRoot, "packed-pi-config")),
		["--no-extensions", "-e", installedPackage],
	);
	process.stdout.write(
		`Packed ${packed.filename} and loaded all ${expectedCommands.length} commands through Pi RPC.\n`,
	);
}

async function smokeGitHubInstall() {
	const refIndex = process.argv.indexOf("--github") + 1;
	const ref = process.argv[refIndex];
	if (!ref || !/^[0-9a-f]{40}$/.test(ref)) {
		throw new Error("Usage: npm run github:smoke -- <40-character-commit>");
	}
	const agentDirectory = join(temporaryRoot, "github-pi-agent");
	const env = isolatedEnvironment(agentDirectory);
	const source = `git:github.com/max-miller1204/pi-build-conductor@${ref}`;
	await execute(piExecutable, ["install", source], {
		cwd: temporaryRoot,
		env: { ...env, PI_OFFLINE: "0" },
		maxBuffer: 10 * 1024 * 1024,
	});
	const checkout = join(
		agentDirectory,
		"git",
		"github.com",
		"max-miller1204",
		"pi-build-conductor",
	);
	const { stdout } = await execute("git", ["rev-parse", "HEAD"], {
		cwd: checkout,
	});
	if (stdout.trim() !== ref) {
		throw new Error(
			`GitHub package resolved to ${stdout.trim()} instead of ${ref}`,
		);
	}
	await rpcCommands(env, []);
	const settings = parseJson(
		await readFile(join(agentDirectory, "settings.json"), "utf8"),
		"Pi settings",
	);
	if (!settings.packages?.includes(source)) {
		throw new Error("Pi did not persist the pinned GitHub package source");
	}
	process.stdout.write(
		`Installed ${source} and loaded all ${expectedCommands.length} commands through Pi RPC.\n`,
	);
}

try {
	if (process.argv.includes("--github")) await smokeGitHubInstall();
	else await smokePackedPackage();
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
