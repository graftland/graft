import { defineProject } from "vitest/config"

export default defineProject({
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
	test: {
		name: "sample-chat-bot",
		globalSetup: ["test/setup.mjs"],
		include: ["test/**/*.test.ts"],
	},
})
