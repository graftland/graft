import { NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { Digest, SecureRandom, Signature } from "effect/crypto"
import { FetchHttpClient } from "effect/http"

export const platform = Layer.mergeAll(
	NodeServices.layer,
	FetchHttpClient.layer,
	Digest.layerWebCrypto,
	SecureRandom.layerWebCrypto,
	Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
)
