import { defineProject } from "vitest/config"

export default defineProject({
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
	test: {
		globalSetup: ["../../scripts/isolated-home.mjs"],
		include: ["test/**/*.test.ts"],
	},
})
