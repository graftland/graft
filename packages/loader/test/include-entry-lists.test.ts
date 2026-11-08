import {
	Array,
	Cause,
	Context,
	Effect,
	FileSystem,
	Option,
	PlatformError,
	Ref,
	Schema,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { parseDocument } from "yaml"

import { Entry, Include, ModuleResolver } from "../src/index"
import { fixture, loaderService, run } from "./utils.ts"

it.effect(
	"writes hosted ids without restarting children and preserves YAML comments and formatting",
	() =>
		Effect.gen(function* () {
			const ids = yield* Ref.make<ReadonlyArray<string>>([])

			yield* run({
				host: fixture("include-entry-lists-host-1055"),
				child: fixture("include-entry-lists-child-1055"),
			})(() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const directory = yield* fs.makeTempDirectoryScoped()
					const file = `${directory}/graft.yml`
					yield* fs.writeFileString(
						file,
						`# Hosted plugins
- id: host
  name: host # keep host comment
  config:
    plugins:
      - name: child # keep child comment
`,
					)
					yield* Graft.plugin(Include.Include, { path: file })
					const loader = yield* loaderService
					yield* loader.ready
					const text = yield* fs.readFileString(file)
					const document = parseDocument(text)
					const written = document.getIn([0, "config", "plugins", 0, "id"])
					assert.isString(written)
					const started = yield* Ref.get(ids)
					assert.deepEqual(started, [String(written)])
					assert.include(text, "# Hosted plugins")
					assert.include(text, "name: host # keep host comment")
					assert.include(text, "name: child # keep child comment")
					assert.include(
						text,
						`    plugins:
      - id:`,
					)
				}),
			).pipe(
				Effect.provideService(
					Context.Service<{ readonly ids: typeof ids }>(
						"loader/fixture/include-entry-lists-child-1055",
					),
					{ ids },
				),
			)
		}),
)

it.effect(
	"writes lists inside hosts and groups without leaking ids through anchors",
	() =>
		run({
			host: fixture("include-entry-lists-host-2221"),
			child: fixture("include-entry-lists-child-2221"),
		})(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				yield* fs.writeFileString(
					file,
					`- id: host
  name: host
  config: &settings
    plugins:
      - name: host
        config:
          plugins:
            - name: group
              group: true
              config:
                - name: child
  untouched: *settings
`,
				)
				yield* Graft.plugin(Include.Include, { path: file })
				const loader = yield* loaderService
				yield* loader.ready
				const text = yield* fs.readFileString(file)
				const document = parseDocument(text)
				const nested = [0, "config", "plugins", 0]
				assert.isString(document.getIn([...nested, "id"]))
				const group = [...nested, "config", "plugins", 0]
				assert.isString(document.getIn([...group, "id"]))
				assert.isString(document.getIn([...group, "config", 0, "id"]))
				assert.isUndefined(document.getIn([0, "untouched", "plugins", 0, "id"]))
			}),
		),
)

it.live(
	"identifies a hand-added child before its first activation and writes only once",
	() =>
		Effect.gen(function* () {
			const ids = yield* Ref.make<ReadonlyArray<string>>([])

			yield* run({
				host: fixture("include-entry-lists-host-3751"),
				child: fixture("include-entry-lists-child-3751"),
			})(() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const directory = yield* fs.makeTempDirectoryScoped()
					const file = `${directory}/graft.yml`
					const writes = yield* Ref.make(0)
					yield* Graft.provide(FileSystem.FileSystem, {
						...fs,
						rename: (source, target) =>
							fs
								.rename(source, target)
								.pipe(Effect.tap(() => Ref.update(writes, (n) => n + 1))),
					})
					yield* fs.writeFileString(
						file,
						"- id: host\n  name: host\n  config: { plugins: [] }\n",
					)
					yield* Graft.plugin(Include.Include, { path: file, watch: true })
					const loader = yield* loaderService
					yield* loader.ready
					yield* fs.writeFileString(
						file,
						"- id: host\n  name: host\n  config: { plugins: [{ name: child }] }\n",
					)
					yield* loader.changes.pipe(
						Stream.filter((entries) =>
							Schema.is(
								Schema.Struct({ plugins: Schema.NonEmptyArray(Entry.Entry) }),
							)(entries[0]?.config),
						),
						Stream.runHead,
						Effect.timeout("5 seconds"),
					)
					yield* loader.ready
					const text = yield* fs.readFileString(file)
					const id = parseDocument(text).getIn([
						0,
						"config",
						"plugins",
						0,
						"id",
					])
					const started = yield* Ref.get(ids)
					const count = yield* Ref.get(writes)
					assert.isString(id)
					assert.deepEqual(started, [String(id)])
					assert.equal(count, 1)
					yield* loader.retry
					yield* loader.ready
					const after = yield* Ref.get(writes)
					assert.equal(after, count)
				}),
			).pipe(
				Effect.provideService(
					Context.Service<{ readonly ids: typeof ids }>(
						"loader/fixture/include-entry-lists-child-3751",
					),
					{ ids },
				),
			)
		}),
)

it.effect(
	"logs a denied hosted-id write with its cause and keeps the child running",
	() =>
		run({
			host: fixture("include-entry-lists-host-5468"),
			child: fixture("include-entry-lists-child-5468"),
		})((journal) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				const original =
					"- id: host\n  name: host\n  config: { plugins: [{ name: child }] }\n"
				yield* fs.writeFileString(file, original)
				const denied = PlatformError.systemError({
					_tag: "PermissionDenied",
					module: "FileSystem",
					method: "rename",
				})
				yield* Graft.provide(FileSystem.FileSystem, {
					...fs,
					rename: () => Effect.fail(denied),
				})
				yield* Graft.plugin(Include.Include, { path: file })
				const loader = yield* loaderService
				yield* loader.ready
				const log = yield* Graft.logs.pipe(
					Stream.filter(
						(entry) =>
							Array.isArray(entry.message) &&
							Array.contains(entry.message, "Refreshing loader entries failed"),
					),
					Stream.runHead,
				)
				assert.strictEqual(Cause.squash(Option.getOrThrow(log).cause), denied)
				yield* journal.expect(["started"])
				const text = yield* fs.readFileString(file)
				assert.equal(text, original)
			}),
		),
)

it.live("discovers an entry-list field introduced by a replacement", () =>
	run({
		host: fixture("include-entry-lists-host-6992"),
		"replacement-host": fixture("host"),
		child: fixture("include-entry-lists-child-6992"),
	})(() =>
		Effect.gen(function* () {
			const resolver = yield* ModuleResolver.ModuleResolver
			const beforeDescriptor = yield* resolver.resolve("host")
			const hostDescriptor = yield* resolver.resolve("replacement-host")
			const beforeModule = yield* Effect.tryPromise({
				try: () => import(beforeDescriptor.location),
				catch: (cause) =>
					ModuleResolver.ModuleInvalid.make({
						specifier: beforeDescriptor.location,
						cause,
					}),
			})
			const hostModule = yield* Effect.tryPromise({
				try: () => import(hostDescriptor.location),
				catch: (cause) =>
					ModuleResolver.ModuleInvalid.make({
						specifier: hostDescriptor.location,
						cause,
					}),
			})
			const before = yield* Effect.fromOption(Plugin.fromModule(beforeModule))
			const host = yield* Effect.fromOption(Plugin.fromModule(hostModule))
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const file = `${directory}/graft.yml`
			yield* fs.writeFileString(
				file,
				"- id: host\n  name: host\n  config: { plugins: [{ name: child }] }\n",
			)
			yield* Graft.plugin(Include.Include, { path: file })
			const loader = yield* loaderService
			yield* loader.ready
			const original = yield* fs.readFileString(file)
			assert.isUndefined(
				parseDocument(original).getIn([0, "config", "plugins", 0, "id"]),
			)
			yield* Graft.replace([[before, host]])
			yield* loader.changes.pipe(
				Stream.filter((entries) =>
					Schema.is(
						Schema.Struct({ plugins: Schema.NonEmptyArray(Entry.Entry) }),
					)(entries[0]?.config),
				),
				Stream.runHead,
				Effect.timeout("2 seconds"),
			)
			yield* loader.ready
			const text = yield* fs.readFileString(file)
			assert.isString(
				parseDocument(text).getIn([0, "config", "plugins", 0, "id"]),
			)
		}),
	),
)
