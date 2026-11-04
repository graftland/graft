import { defineProject } from "vitest/config"

export default defineProject({
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
	test: {
		name: "sample-remote-runner",
		include: ["test/**/*.test.ts"],
		globalSetup: ["./test/setup.mjs"],
		testTimeout: 60000,
	},
})
