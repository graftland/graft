import { Context, Effect, Layer } from "effect"

import { Plugin } from "@graftland/graft"

class Word extends Context.Service<Word, string>()("fixture/service/Word") {}
export const service = Plugin.service(Word, Effect.succeed("hello"), {
	name: "word",
})
export const layer = Plugin.layer(Layer.succeed(Word, "hello"), {
	name: "layer",
	provides: [Word],
})
export default Plugin.make({ name: "simple", apply: () => Effect.void })
