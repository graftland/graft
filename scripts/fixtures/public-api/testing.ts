import * as Testing from "@graftland/graft/testing"

export const connection = Testing.make
export const server = (protocol: Testing.InMemoryProtocol) => protocol.server
export const client = (protocol: Testing.InMemoryProtocol) => protocol.client
export const disconnect = (protocol: Testing.InMemoryProtocol) =>
	protocol.disconnect
