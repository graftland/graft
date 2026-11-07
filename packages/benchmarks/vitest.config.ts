import { defineProject } from "vitest/config"

export default defineProject({
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
	test: {
		name: "benchmarks",
		globalSetup: ["../../scripts/isolated-home.mjs", "./test/setup.mjs"],
		include: ["test/**/*.test.ts"],
		testTimeout: 15000,
	},
})
