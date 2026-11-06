import {
	Array,
	Context,
	Option,
	SchemaAST,
	type Effect,
	type HashMap,
	type Schema,
} from "effect"

import { EntriesId } from "./entryIds"

export type Locator = ReadonlyArray<string>
export type Lists = HashMap.HashMap<string, ReadonlyArray<Locator>>
export type Reporter = (
	name: string,
	locators: ReadonlyArray<Locator>,
) => Effect.Effect<void>
export const EntryLists = Context.Reference<Option.Option<Reporter>>(
	"@graftland/loader/EntryLists",
	{ defaultValue: () => Option.none() },
)

// ASTs are immutable identities; sharing a schema must not repeat discovery work.
const cache = new WeakMap<SchemaAST.AST, ReadonlyArray<Locator>>()
const marked = (check: SchemaAST.Check<unknown>): boolean =>
	check.annotations?.[EntriesId] === true ||
	(check._tag === "FilterGroup" && Array.some(check.checks, marked))

/** Locate entry lists on the encoded side, where names match the file. */
export const entryLists = (
	schema: Schema.Top | undefined,
): ReadonlyArray<Locator> => {
	if (schema === undefined) return []
	const cached = cache.get(schema.ast)
	if (cached !== undefined) return cached
	// A branch-local identity guard terminates recursion without losing shared fields.
	const active = new WeakSet<SchemaAST.AST>()
	const visit = (ast: SchemaAST.AST, path: Locator): ReadonlyArray<Locator> => {
		if (ast.checks !== undefined && Array.some(ast.checks, marked))
			return [path]
		if (active.has(ast)) return []
		active.add(ast)
		let paths: ReadonlyArray<Locator> = []
		switch (ast._tag) {
			case "Objects":
				paths = [
					...Array.flatMap(ast.propertySignatures, (property) =>
						typeof property.name === "string"
							? visit(property.type, [...path, property.name])
							: [],
					),
					...Array.flatMap(ast.indexSignatures, (index) =>
						visit(index.type, [...path, "*"]),
					),
				]
				break
			case "Arrays":
				paths = Array.flatMap([...ast.elements, ...ast.rest], (element) =>
					visit(element, [...path, "*"]),
				)
				break
			case "Union":
				paths = Array.flatMap(ast.types, (member) => visit(member, path))
				break
			case "Suspend":
				paths = visit(ast.thunk(), path)
				break
		}
		active.delete(ast)
		return paths
	}
	const paths = visit(SchemaAST.toEncoded(schema.ast), [])
	cache.set(schema.ast, paths)
	return paths
}
