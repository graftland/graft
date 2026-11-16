import * as Node from "@graftland/graft/node"

export const subprocess = (options: Node.SubprocessOptions) =>
	Node.subprocessProtocol(options)
export const worker = (options: Node.WorkerOptions) =>
	Node.workerProtocol(options)
export const stdio = Node.layerProtocolStdio
export const workerServer = Node.layerProtocolWorker
