import { build } from "tsdown"

export default async function setup() {
	const common = {
		config: false,
		format: "esm",
		platform: "node",
		fixedExtension: false,
		dts: false,
		deps: {
			alwaysBundle: [
				"@graftland/graft",
				"@graftland/plugin-remote",
				"@graftland/loader",
			],
			neverBundle: [/^effect(?:\/|$)/, /^@effect\//],
		},
		inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
	}
	await build({
		...common,
		entry: ["contract", "worker"].map(
			(name) => new URL(`../src/${name}.ts`, import.meta.url).pathname,
		),
		outDir: new URL("../.cache/worker", import.meta.url).pathname,
	})
	// Each test project owns its executable, so parallel builds cannot replace it.
	await build({
		...common,
		entry: ["bin", "watchdog"].map(
			(name) =>
				new URL(`../../../packages/remote/src/${name}.ts`, import.meta.url)
					.pathname,
		),
		outDir: new URL("../.cache/runner", import.meta.url).pathname,
	})
}
