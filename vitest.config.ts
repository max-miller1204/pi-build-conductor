import { defineConfig } from "vitest/config";

// Real-Git end-to-end tests routinely exceed the 5 second default when the
// whole suite runs in parallel workers; the raised timeouts still bound
// genuinely hung tests without failing merely loaded ones.
export default defineConfig({
	test: {
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
