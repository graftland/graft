import { defineProject } from "vitest/config"

export default defineProject({
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["../../scripts/isolated-home.mjs", "test/setup.mjs"],
	},
})
