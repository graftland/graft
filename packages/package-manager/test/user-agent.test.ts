import { Array, Option } from "effect"
import { assert, describe, it } from "@effect/vitest"

import {
	agentFor,
	installCommand,
	parseUserAgent,
	runPrefix,
} from "../src/index.ts"

describe("user agent", () => {
	it("reads the package manager and its version from the first entry", () => {
		assert.deepStrictEqual(
			parseUserAgent("pnpm/9.15.9 npm/? node/v22.19.0 linux x64"),
			Option.some({ name: "pnpm", version: "9.15.9" }),
		)
		assert.deepStrictEqual(
			parseUserAgent("yarn/4.9.1 npm/? node/v22.19.0 darwin arm64"),
			Option.some({ name: "yarn", version: "4.9.1" }),
		)
	})

	it("names nothing for other or empty user agents", () => {
		for (const userAgent of ["", "bun/1.2.0 npm/? node/v22.19.0", "npm/"])
			assert.isTrue(Option.isNone(parseUserAgent(userAgent)), userAgent)
	})

	it("maps Yarn versions to Classic or Berry", () => {
		assert.strictEqual(agentFor("yarn", "1.22.22"), "yarn-classic")
		assert.strictEqual(agentFor("yarn", "4.9.1"), "yarn-berry")
		assert.strictEqual(agentFor("yarn"), "yarn-classic")
		assert.strictEqual(agentFor("pnpm", "9.15.9"), "pnpm")
	})

	it("names the commands that install and run scripts", () => {
		assert.deepStrictEqual(
			Array.map(
				["npm", "pnpm", "yarn-classic", "yarn-berry"] as const,
				(agent) => [installCommand(agent), `${runPrefix(agent)} dev`],
			),
			[
				["npm install", "npm run dev"],
				["pnpm install", "pnpm dev"],
				["yarn", "yarn dev"],
				["yarn", "yarn dev"],
			],
		)
	})
})
