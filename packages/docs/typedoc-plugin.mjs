import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { Comment, Converter, ReflectionKind } from "typedoc"

import { referenceEntries } from "../../scripts/reference.mjs"

/** Keep module names aligned with package exports, including executable entries. */
export function load(app) {
	app.converter.on(Converter.EVENT_END, ({ project }) => {
		const root = fileURLToPath(new URL("../../", import.meta.url))
		const packageName = app.options.getValue("name")
		const entries = referenceEntries(root).filter(
			(entry) => entry.packageName === packageName,
		)
		const modules = project.children ?? []
		const coverage = entries.map((entry) => {
			const file = resolve(entry.directory, entry.source)
			const module = modules.find((module) =>
				module.sources?.some((source) => source.fullFileName === file),
			)
			if (!module) throw new Error(`TypeDoc omitted entry: ${entry.name}`)
			module.name =
				entry.name === packageName
					? "index"
					: entry.name.slice(packageName.length + 1)
			const summary = `Import path: \`${entry.name}\`.${module.children?.length ? "" : " This executable entry exports no API symbols."}`
			module.comment ??= new Comment()
			module.comment.summary = [
				{ kind: "text", text: summary + "\n\n" },
				...module.comment.summary,
			]
			return {
				name: entry.name,
				source: file,
				exports: (module.children ?? []).map((child) => child.name).sort(),
			}
		})
		// Do not duplicate the inherited Effect toolkit on every Schema/Context class.
		// Locally declared members, constructors, and discriminants remain visible.
		for (const reflection of Object.values(project.reflections)) {
			const sources =
				reflection.sources ??
				reflection.signatures?.flatMap(
					(signature) => signature.sources ?? [],
				) ??
				[]
			if (
				reflection.parent?.kindOf(ReflectionKind.Class) &&
				sources.length &&
				sources.every((source) =>
					source.fullFileName.includes("/node_modules/"),
				) &&
				reflection.name !== "_tag" &&
				!reflection.kindOf(ReflectionKind.Constructor)
			) {
				project.removeReflection(reflection)
				continue
			}
			// Factory calls can be hundreds of characters long; the full signature is above.
			for (const relation of ["inheritedFrom", "overwrites"]) {
				if (reflection[relation]?.name.includes("\n"))
					reflection[relation] = undefined
			}
		}
		// Group lists are already built at EVENT_END and retain removed reflections.
		for (const reflection of Object.values(project.reflections)) {
			for (const key of ["groups", "categories"]) {
				if (reflection[key])
					reflection[key] = reflection[key]
						.map((group) => {
							group.children = group.children.filter((child) =>
								project.getReflectionById(child.id),
							)
							return group
						})
						.filter((group) => group.children.length)
			}
		}
		const undocumented = Object.values(project.reflections)
			.filter(
				(reflection) =>
					reflection.parent?.kindOf(
						ReflectionKind.Module | ReflectionKind.Namespace,
					) &&
					!reflection.kindOf(
						ReflectionKind.Reference |
							ReflectionKind.Module |
							ReflectionKind.Namespace,
					) &&
					!reflection.hasComment() &&
					!reflection.signatures?.some((signature) => signature.hasComment()),
			)
			.map((reflection) => ({
				name: reflection.getFullName(),
				source: reflection.sources?.[0],
			}))
		const output = new URL("./.cache/reference/", import.meta.url)
		mkdirSync(output, { recursive: true })
		writeFileSync(
			new URL(`${packageName.replace("@graftland/", "")}.json`, output),
			JSON.stringify({ coverage, undocumented }, null, 2) + "\n",
		)
	})
}
