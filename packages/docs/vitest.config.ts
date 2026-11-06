import * as Doctest from "@effect/doctest/Plugin"

import type { Plugin } from "vite"
import { defineProject } from "vitest/config"

import { resolveTitled, write } from "./snippets.mjs"

// Lets a doctest import a titled code block of its page, such as `./clock.ts`.
const titledBlocks = (): Plugin => ({
	name: "graft-docs-titled-blocks",
	buildStart: () => void write(),
	resolveId: (source, importer) => resolveTitled(source, importer) ?? null,
})

// Runs every English code block tagged `ts import.meta.vitest` as its own test.
// The Chinese pages carry the same code blocks; `snippets.test.mjs` checks that.
export default defineProject({
	plugins: [Doctest.plugin(), titledBlocks()],
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
	test: {
		globalSetup: ["../../scripts/isolated-home.mjs"],
		include: [],
		// A page whose blocks are all typecheck-only has no doctests.
		passWithNoTests: true,
		includeSource: ["content/docs/**/*.{md,mdx}"],
		exclude: ["content/docs/zh-cn/**", "content/docs/zh-tw/**"],
		testTimeout: 20_000,
	},
})
