import { defineProject } from "vitest/config"

export default defineProject({
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
	test: {
		name: "remote",
		globalSetup: ["./test/setup.mjs"],
		include: ["test/**/*.test.ts"],
		// Each integration file boots child runtimes. Serialize files to bound
		// process startup load without serializing calls within duplex tests.
		fileParallelism: false,
		testTimeout: 15000,
	},
})
