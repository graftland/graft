import { build } from "tsdown"

// The runner loads built JavaScript. Build it here from source, so the test
// needs no `pnpm build` and never races another project's build output.
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
	await build({
		...common,
		root: new URL("../../../packages/remote/src", import.meta.url).pathname,
		entry: [
			"bin",
			"watchdog",
			"runner/supervisor",
			"runner/websocket",
			"internal/legacy/runner/websocket",
			"internal/legacy/runner/auth/none",
			"internal/legacy/runner/auth/mtls",
			"runner/auth/jwt",
		].map(
			(name) =>
				new URL(`../../../packages/remote/src/${name}.ts`, import.meta.url)
					.pathname,
		),
		outDir: new URL("../.cache/runner", import.meta.url).pathname,
	})
}
