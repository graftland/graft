import { cp, mkdir, writeFile } from "node:fs/promises"

async function install() {
	// A local installation for the tutorial runner, just as a deployed runner
	// would have its plugin package installed before accepting connections.
	const directory = new URL(
		"../.cache/installation/node_modules/@graftland/sample-remote/",
		import.meta.url,
	)
	await mkdir(directory, { recursive: true })
	await cp(new URL("../dist/", import.meta.url), new URL("dist/", directory), {
		recursive: true,
	})
	await writeFile(
		new URL("package.json", directory),
		JSON.stringify({
			name: "@graftland/sample-remote",
			version: "0.0.0",
			type: "module",
			exports: {
				"./contract": "./dist/contract.js",
				"./greeter": "./dist/greeter.js",
			},
		}),
	)
}

if (import.meta.main) await install()
