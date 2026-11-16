import {
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Schedule,
	Scope,
	Stream,
} from "effect"

import { Graft, Mount, Release } from "@graftland/graft"

class Word extends Context.Service<Word, string>()("fixture/Word") {}
class Count extends Context.Service<Count, number>()("fixture/Count") {}

const label = Context.Reference<string>("fixture/label", {
	defaultValue: () => "default",
})

const word = Layer.effect(Word, Effect.succeed("hello"))
const count = Layer.effect(
	Count,
	Effect.map(Word, (value) => value.length),
)
const maybeCount = Layer.effect(
	Count,
	Effect.map(
		Effect.serviceOption(Word),
		Option.match({ onNone: () => 0, onSome: (value) => value.length }),
	),
)

export default Graft.layer

export const layer = Graft.layer
export const mount = Graft.mount(word)
export const named = Graft.mount(word, {
	name: "word",
	retry: Schedule.exponential("100 millis"),
})
export const required = Graft.mount(count, { requires: [Word] })
export const optional = Graft.mount(maybeCount, {
	requires: [Graft.optional(Word)],
})
export const isolated = Graft.mount(word, { isolate: [Word] })
export const labelled = Graft.mount(word, { isolate: [[Word, "tenant"]] })
export const intercepted = Graft.mount(word, {
	intercept: [Graft.intercept(label, (outer) => `${outer}!`)],
})
export const publication = Graft.publish(Word, "hello")
export const background = Graft.fork(Effect.succeed(1))
export const watch = Graft.watch(Word)
export const awaiting = Graft.await(Word)
export const used = Graft.use(Word, (value) => Effect.succeed(value.length))
export const whileAvailable = Graft.whileAvailable(Word, (value) =>
	Effect.log(value),
)
export const mounts = Graft.mounts
export const logs = Graft.logs

export const states = (handle: Mount.Mount) => Stream.runCollect(handle.state)
export const settled = (handle: Mount.Mount) => handle.await
export const stable = (handle: Mount.Mount) => handle.stable
export const restart = (handle: Mount.Mount) => handle.restart
export const unmount = (handle: Mount.Mount) => handle.unmount
export const set = (value: Mount.Publication<string>) => value.set("next")
export const children = (tree: Mount.MountTree) => tree.children
export const options = (value: Graft.MountOptions<readonly []>) => value
export type State = Mount.MountState

export const scoped = Release.scoped(Effect.succeed(1))
export const close = (
	scope: Scope.Closeable,
	exit: Exit.Exit<unknown, unknown>,
) => Release.close(scope, exit)
export const released = (error: Release.ReleaseInterrupted) => error
export const conflict = (error: Graft.ServiceConflict) => error
export const withdrawn = (error: Graft.ServiceWithdrawn) => error
