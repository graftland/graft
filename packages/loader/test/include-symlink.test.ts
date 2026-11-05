import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Option,
	Path,
	Queue,
	Ref,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Include } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

for (const stage of ["api edit", "initial ID assignment"]) {
	it.effect(`preserves config symlink during ${stage}`, () =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const dir = yield* fs.makeTempDirectoryScoped()
				const actual = `${dir}/actual.yml`
				const link = `${dir}/graft.yml`
				const original =
					stage === "api edit"
						? "- id: a\n  name: unused\n  disabled: true\n  config: old\n"
						: "- name: unused\n  disabled: true\n  config: old\n"
				yield* fs.writeFileString(actual, original)
				yield* fs.symlink(actual, link)
				const include = yield* Graft.plugin(Include.Include, { path: link })
				yield* include.await
				const loader = yield* loaderService
				if (stage === "api edit") yield* loader.update("a", { config: "new" })
				const referent = yield* fs.readFileString(actual)
				const configured = yield* fs.readFileString(link)
				const stillLinked = yield* fs.readLink(link).pipe(Effect.isSuccess)
				assert.isTrue(stillLinked, "Include must preserve the config symlink")
				assert.strictEqual(referent, configured)
			}),
		),
	)
}

const contents = (value: string) =>
	`- id: a
  name: unused
  disabled: true
  config: ${value}
`

const fixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const temporary = yield* fs.makeTempDirectoryScoped()
	const directory = yield* fs.realPath(temporary)
	const entrance = path.join(directory, "entry")
	const first = path.join(directory, "first")
	const second = path.join(directory, "second")
	for (const dir of [entrance, first, second]) yield* fs.makeDirectory(dir)
	const link = path.join(entrance, "graft.yml")
	const a = path.join(first, "actual.yml")
	const b = path.join(second, "actual.yml")
	yield* fs.writeFileString(a, contents("original"))
	yield* fs.writeFileString(b, contents("original"))
	yield* fs.symlink("../first/actual.yml", link)
	const retarget = Effect.gen(function* () {
		yield* fs.symlink("../second/actual.yml", `${link}.next`)
		yield* fs.rename(`${link}.next`, link)
	})
	return { fs, path, entrance, first, second, link, a, b, retarget }
})

it.effect(
	"uses the real target directory and permissions through a relative link chain",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const { fs, path, entrance, first, link, a } = yield* fixture
				const alias = path.join(entrance, "alias.yml")
				yield* fs.symlink("graft.yml", alias)
				yield* fs.chmod(a, 0o600)
				const opened = yield* Ref.make<ReadonlyArray<string>>([])
				yield* Graft.provide(FileSystem.FileSystem, {
					...fs,
					open: (file, options) =>
						Ref.update(opened, Array.append(file)).pipe(
							Effect.andThen(fs.open(file, options)),
						),
				})
				const owner = yield* Graft.plugin(Include.Include, { path: alias })
				yield* owner.await
				const loader = yield* loaderService
				yield* loader.update("a", { config: "updated" })
				const files = yield* Ref.get(opened)
				assert.strictEqual(files.length, 1)
				assert(Array.every(files, (file) => path.dirname(file) === first))
				const disk = yield* fs.readFileString(a)
				assert.include(disk, "config: updated")
				const info = yield* fs.stat(a)
				assert.strictEqual(info.mode & 0o777, 0o600)
				const links = yield* Effect.all([fs.readLink(alias), fs.readLink(link)])
				assert.deepStrictEqual(links, ["graft.yml", "../first/actual.yml"])
			}),
		),
)

it.effect(
	"follows a new referent even when it has exactly the previous contents",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const { fs, link, a, b, retarget } = yield* fixture
				const owner = yield* Graft.plugin(Include.Include, { path: link })
				yield* owner.await
				const loader = yield* loaderService
				yield* retarget
				yield* loader.update("a", { config: "updated" })
				const first = yield* fs.readFileString(a)
				const second = yield* fs.readFileString(b)
				assert.strictEqual(first, contents("original"))
				assert.include(second, "config: updated")
				const destination = yield* fs.readLink(link)
				assert.strictEqual(destination, "../second/actual.yml")
			}),
		),
)

it.effect.each([false, true])(
	"rebases a retarget during write preparation (conflicting field: %s)",
	(conflicting) =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const { fs, first, second, link, a, b, retarget } = yield* fixture
				if (conflicting) yield* fs.writeFileString(b, contents("external"))
				const ready = yield* Deferred.make<void>()
				const resume = yield* Deferred.make<void>()
				const attempts = yield* Ref.make(0)
				yield* Graft.provide(FileSystem.FileSystem, {
					...fs,
					open: (name, options) =>
						Effect.map(fs.open(name, options), (handle) => ({
							...handle,
							stat: handle.stat,
							writeAll: (bytes) => handle.writeAll(bytes),
							sync: handle.sync.pipe(
								Effect.andThen(
									Effect.gen(function* () {
										const attempt = yield* Ref.updateAndGet(
											attempts,
											(n) => n + 1,
										)
										if (attempt === 1) {
											yield* Deferred.succeed(ready, undefined)
											yield* Deferred.await(resume)
										}
									}),
								),
							),
						})),
				})
				const owner = yield* Graft.plugin(Include.Include, { path: link })
				yield* owner.await
				const loader = yield* loaderService
				const editing = yield* loader
					.update("a", { config: "updated" })
					.pipe(Effect.forkChild)
				yield* Deferred.await(ready)
				yield* retarget
				yield* Deferred.succeed(resume, undefined)
				yield* Fiber.join(editing)
				const old = yield* fs.readFileString(a)
				const current = yield* fs.readFileString(b)
				const target = yield* loader.entries
				assert.strictEqual(old, contents("original"))
				assert.include(
					current,
					`config: ${conflicting ? "external" : "updated"}`,
				)
				assert.strictEqual(
					target[0]?.config,
					conflicting ? "external" : "updated",
				)
				const count = yield* Ref.get(attempts)
				assert.strictEqual(count, conflicting ? 1 : 2)
				for (const directory of [first, second]) {
					const files = yield* fs.readDirectory(directory)
					assert.deepStrictEqual(files, ["actual.yml"])
				}
				const destination = yield* fs.readLink(link)
				assert.strictEqual(destination, "../second/actual.yml")
			}),
		),
)

it.effect(
	"does not replace a dangling symlink with initial configuration",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const { fs, entrance, first, link, a } = yield* fixture
				yield* fs.remove(a)
				const owner = yield* Graft.plugin(Include.Include, {
					path: link,
					initial: [],
				})
				const result = yield* Effect.exit(owner.await)
				assert(Exit.isFailure(result))
				assert(Cause.hasFails(result.cause))
				const destination = yield* fs.readLink(link)
				assert.strictEqual(destination, "../first/actual.yml")
				const targetFiles = yield* fs.readDirectory(first)
				const entryFiles = yield* fs.readDirectory(entrance)
				assert.deepStrictEqual(targetFiles, [])
				assert.deepStrictEqual(entryFiles, ["graft.yml"])
			}),
		),
)

it.live(
	"watches the referent, switches directories after retargeting, and releases old watchers",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const { fs, entrance, first, second, link, a, b, retarget } =
					yield* fixture
				const installed = yield* Queue.unbounded<string>()
				const closed = yield* Ref.make<ReadonlyArray<string>>([])
				yield* Graft.provide(FileSystem.FileSystem, {
					...fs,
					watch: (directory, options) =>
						fs
							.watch(directory, {
								...options,
								onReady: () => {
									options?.onReady?.()
									Queue.offerUnsafe(installed, directory)
								},
							})
							.pipe(
								Stream.ensuring(Ref.update(closed, Array.append(directory))),
							),
				})
				const owner = yield* Graft.plugin(Include.Include, {
					path: link,
					watch: true,
				})
				yield* owner.await
				const loader = yield* loaderService
				const watched = yield* Effect.all([
					Queue.take(installed),
					Queue.take(installed),
				])
				assert.sameMembers(watched, [entrance, first])
				const reaches = (value: string) =>
					loader.changes.pipe(
						Stream.filter((entries) => entries[0]?.config === value),
						Stream.runHead,
						Effect.map(Option.getOrThrow),
					)
				yield* fs.writeFileString(a, contents("external"))
				yield* reaches("external")
				// Even an invalid new target must be watched so a later correction can recover.
				yield* fs.writeFileString(b, "- [invalid\n")
				yield* retarget
				const nextDirectory = yield* Queue.take(installed)
				assert.strictEqual(nextDirectory, second)
				yield* Graft.logs.pipe(
					Stream.filter(
						(entry) =>
							Array.isArray(entry.message) &&
							Array.contains(entry.message, "Refreshing loader entries failed"),
					),
					Stream.runHead,
				)
				const beforeRepair = yield* loader.entries
				assert.strictEqual(beforeRepair[0]?.config, "external")
				const retired = yield* Ref.get(closed)
				assert.include(retired, first)
				yield* fs.writeFileString(b, contents("repaired"))
				yield* reaches("repaired")
				yield* loader.update("a", { config: "api" })
				const current = yield* fs.readFileString(b)
				const old = yield* fs.readFileString(a)
				assert.include(current, "config: api")
				assert.strictEqual(old, contents("external"))
				yield* owner.dispose
				const released = yield* Ref.get(closed)
				assert.sameMembers([...released], [entrance, first, second])
				const destination = yield* fs.readLink(link)
				assert.strictEqual(destination, "../second/actual.yml")
			}),
		),
)
