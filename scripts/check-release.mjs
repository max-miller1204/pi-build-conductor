import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import semver from "semver";

function parseJson(value, source) {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`Invalid JSON in ${source}`, { cause: error });
	}
}

const packageJson = parseJson(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
	"package.json",
);
const packageLock = parseJson(
	await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
	"package-lock.json",
);
const args = process.argv.slice(2);

function option(name) {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

function has(name) {
	return args.includes(name);
}

function requireEqual(actual, expected, message) {
	if (actual !== expected) {
		throw new Error(
			`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
		);
	}
}

function git(...gitArgs) {
	return execFileSync("git", gitArgs, { encoding: "utf8" }).trim();
}

const version = semver.valid(packageJson.version);
if (!version || version !== packageJson.version) {
	throw new Error(
		`package.json version must be a canonical SemVer value, received ${packageJson.version}`,
	);
}
requireEqual(
	packageLock.name,
	packageJson.name,
	"Lockfile package name mismatch",
);
requireEqual(
	packageLock.version,
	packageJson.version,
	"Lockfile package version mismatch",
);
requireEqual(
	packageLock.packages?.[""]?.name,
	packageJson.name,
	"Lockfile root package name mismatch",
);
requireEqual(
	packageLock.packages?.[""]?.version,
	packageJson.version,
	"Lockfile root package version mismatch",
);

const compatibility = packageJson.conductorCompatibility;
if (!compatibility || typeof compatibility !== "object") {
	throw new Error("package.json must define conductorCompatibility");
}
if (!semver.valid(compatibility.testedPiVersion)) {
	throw new Error(
		"conductorCompatibility.testedPiVersion must be valid SemVer",
	);
}
requireEqual(
	compatibility.upstreamPiTag,
	`v${compatibility.testedPiVersion}`,
	"Tested Pi tag mismatch",
);
for (const dependency of [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
]) {
	requireEqual(
		packageJson.devDependencies?.[dependency],
		compatibility.testedPiVersion,
		`${dependency} development pin mismatch`,
	);
	requireEqual(
		packageJson.peerDependencies?.[dependency],
		"*",
		`${dependency} peer range mismatch`,
	);
}
for (const [name, commit] of [
	["upstreamPiCommit", compatibility.upstreamPiCommit],
	["serverCommit", compatibility.serverCommit],
]) {
	if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error(
			`conductorCompatibility.${name} must be a full lowercase Git commit`,
		);
	}
}
requireEqual(
	compatibility.workerLaunchPolicyVersion,
	1,
	"Worker launch policy mismatch",
);

const tag = option("--tag");
if (tag) {
	const expectedTag = `v${packageJson.version}`;
	requireEqual(tag, expectedTag, "Release tag mismatch");
	requireEqual(
		git("rev-list", "-n", "1", `refs/tags/${tag}`),
		git("rev-parse", "HEAD"),
		"Tag commit mismatch",
	);
	const ancestry = spawnSync(
		"git",
		["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"],
		{
			stdio: "ignore",
		},
	);
	if (ancestry.status !== 0) {
		throw new Error(`${tag} is not reachable from origin/main`);
	}
}

const githubPrerelease = option("--github-prerelease");
if (githubPrerelease) {
	if (githubPrerelease !== "true" && githubPrerelease !== "false") {
		throw new Error("--github-prerelease must be true or false");
	}
	const semverPrerelease = semver.prerelease(packageJson.version) !== null;
	requireEqual(
		githubPrerelease === "true",
		semverPrerelease,
		"GitHub prerelease state mismatch",
	);
}

if (has("--publish")) {
	if (packageJson.private === true) {
		throw new Error(
			"npm publication is disabled while package.json has private=true",
		);
	}
	requireEqual(
		packageJson.publishConfig?.access,
		"public",
		"npm access mismatch",
	);
	requireEqual(
		packageJson.publishConfig?.registry,
		"https://registry.npmjs.org/",
		"npm registry mismatch",
	);
	const published = spawnSync(
		"npm",
		["view", `${packageJson.name}@${packageJson.version}`, "version", "--json"],
		{
			encoding: "utf8",
		},
	);
	if (published.status === 0) {
		throw new Error(
			`${packageJson.name}@${packageJson.version} is already published`,
		);
	}
	if (!`${published.stderr}\n${published.stdout}`.includes("E404")) {
		throw new Error(
			`Could not verify npm version availability: ${published.stderr || published.stdout}`,
		);
	}
}

if (
	args.some(
		(argument) =>
			argument.startsWith("--") &&
			!["--tag", "--github-prerelease", "--publish"].includes(argument),
	)
) {
	throw new Error(`Unknown option in ${args.join(" ")}`);
}

process.stdout.write(
	`Release metadata is consistent for ${packageJson.name}@${packageJson.version} with Pi ${compatibility.testedPiVersion} and server ${compatibility.serverCommit}.\n`,
);
