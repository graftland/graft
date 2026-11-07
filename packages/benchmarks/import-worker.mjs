import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const measureImport = async (specifier) => {
	const before = performance.now()
	const namespace = await import(specifier)
	const elapsed = performance.now() - before
	if (Object.keys(namespace).length === 0)
		throw new Error("Import returned an empty namespace")
	return { elapsed, exports: Object.keys(namespace).length }
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	measureImport(process.argv[2]).then(
		(result) => process.stdout.write(JSON.stringify(result)),
		(error) => {
			process.stderr.write(`${error.stack ?? error}\n`)
			process.exitCode = 1
		},
	)
}
