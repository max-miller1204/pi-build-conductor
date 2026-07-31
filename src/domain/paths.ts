/**
 * Whether a repository-relative path falls inside an approved path list. A
 * trailing slash approves a directory subtree; anything else approves exactly
 * one file, so an allowance can never widen by accident.
 */
export function pathIsAllowed(
	path: string,
	allowedPaths: readonly string[],
): boolean {
	return allowedPaths.some((allowed) =>
		allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed,
	);
}
