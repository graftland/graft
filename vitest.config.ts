import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			"packages/*",
			"samples/*/vitest.config.ts",
			"scripts/vitest.config.ts",
		],
	},
})
