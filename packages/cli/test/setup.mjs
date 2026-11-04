import { build } from "tsdown"

export default function setup() {
	return build({
		config: false,
		entry: [new URL("./runtime.ts", import.meta.url).pathname],
		outDir: new URL("../.cache/integration", import.meta.url).pathname,
		format: "esm",
		platform: "node",
		dts: false,
		deps: {
			alwaysBundle: ["@graftland/graft", "@graftland/hmr", "@graftland/loader"],
			neverBundle: [/^effect(?:\/|$)/],
		},
		inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
	})
		.then(() =>
			build({
				config: false,
				entry: [new URL("./plugin.ts", import.meta.url).pathname],
				outDir: new URL("../.cache/integration", import.meta.url).pathname,
				clean: false,
				format: "esm",
				platform: "node",
				dts: false,
				deps: {
					alwaysBundle: ["@graftland/graft"],
					neverBundle: [/^effect(?:\/|$)/],
				},
				inputOptions: {
					resolve: { conditionNames: ["source", "import", "node"] },
				},
			}),
		)
		.then(() =>
			build({
				config: false,
				entry: ["index", "Contract", "bin", "host/local"].map(
					(name) =>
						new URL(`../../remote/src/${name}.ts`, import.meta.url).pathname,
				),
				root: new URL("../../remote/src", import.meta.url).pathname,
				outDir: new URL("../.cache/remote", import.meta.url).pathname,
				format: "esm",
				fixedExtension: false,
				platform: "node",
				dts: false,
				deps: {
					alwaysBundle: ["@graftland/graft", "@graftland/loader"],
					neverBundle: [/^effect(?:\/|$)/, /^@effect\//],
				},
				inputOptions: {
					resolve: { conditionNames: ["source", "import", "node"] },
				},
			}),
		)
		.then(() => undefined)
}
