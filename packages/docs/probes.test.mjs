import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

for (const locale of ["", "zh-cn/", "zh-tw/"]) {
	test(`Probe guidance describes managed policy checks in ${locale || "English"}`, async () => {
		const guide = await readFile(
			new URL(`content/docs/${locale}probes.md`, import.meta.url),
			"utf8",
		)
		assert.match(guide, /\.\.\/transitions\//)
		assert.match(guide, /`policy\.probes`/)
		assert.match(guide, /`fork\.probe`/)
		assert.doesNotMatch(
			guide,
			/transitions are not available yet|尚不支持自动升级|尚不支援自動升級/,
		)
	})
}
