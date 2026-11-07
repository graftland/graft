import { pathToFileURL } from "node:url"
import { isMainThread, parentPort } from "node:worker_threads"

export const start = () => {
	let sequence = 0
	const send = (message) =>
		isMainThread ? process.send(message) : parentPort.postMessage(message)
	const receive = (message) => {
		if (message.stop) {
			if (isMainThread) process.disconnect()
			else parentPort.close()
			return
		}
		const echo = (text) => ({ text, sequence: ++sequence, value: 1 })
		send(
			message.texts
				? { id: message.id, values: message.texts.map(echo) }
				: { id: message.id, ...echo(message.text) },
		)
	}
	if (isMainThread) process.on("message", receive)
	else parentPort.on("message", receive)
	send({ ready: true })
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
	start()
