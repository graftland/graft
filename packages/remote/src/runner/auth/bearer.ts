import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	Effect,
	FileSystem,
	Path,
	Record,
	Redacted,
	Schema,
} from "effect"
import { Digest } from "effect/crypto"
import { Hex } from "effect/encoding"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Token digests use Node's constant-time comparison
import { timingSafeEqual } from "node:crypto"
import { BearerAuthenticator } from "../../Auth"
import { Directory } from "../../internal/config"
import * as Token from "../../internal/auth/token"

export const Config = Schema.Struct({ tokens: Schema.String })
const Tokens = Schema.fromJsonString(
	Schema.Record(
		Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{64}$/)),
		Schema.NonEmptyString,
	),
)
export default Plugin.make({
	name: "remote-bearer-authenticator",
	config: Config,
	inject: [FileSystem.FileSystem, Path.Path, Digest.Digest],
	apply: Effect.fnUntraced(function* (config) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = yield* Directory
		const digest = yield* Digest.Digest
		const file = yield* fs.readFileString(
			path.resolve(directory, config.tokens),
		)
		const mapping = yield* Schema.decodeEffect(Tokens)(file)
		const tokens = yield* Effect.forEach(
			Record.toEntries(mapping),
			([hex, identity]) =>
				Effect.fromResult(Hex.decode(hex)).pipe(
					Effect.map((hash) => ({ hash, identity })),
				),
		)
		yield* Graft.provide(BearerAuthenticator, {
			_tag: "Header",
			authenticate: Effect.fnUntraced(function* (authorization) {
				const token = yield* Token.read(authorization)
				const hash = yield* digest.digest(
					Digest.sha256,
					new TextEncoder().encode(Redacted.value(token)),
				)
				const found = Array.findFirst(tokens, (entry) =>
					timingSafeEqual(hash, entry.hash),
				)
				return yield* Effect.fromOption(found, Token.invalid).pipe(
					Effect.map((entry) => entry.identity),
				)
			}),
		})
	}),
})
