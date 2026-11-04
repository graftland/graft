# Events

## Declaring events

cordis declares events by augmenting the `Events` interface with string names.
Graft events are tokens whose type fixes the arguments, the handler result and
the handler errors:

```ts
// cordis
declare module "cordis" {
	interface Events {
		message(text: string): void
		command(name: string): string | undefined
		render(html: string): string
	}
}
```

```ts
// Graft
export const Message = Event.make<[text: string]>("@acme/chat/message")
export const Command = Event.make<[name: string], Option.Option<string>>(
	"@acme/chat/command",
)
export const Render = Event.middleware<string, string>("@acme/chat/render")
```

Export tokens from a shared module; emitters and handlers both import them.

## Handling

| cordis                                               | Graft                                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ctx.on(name, listener)`                             | `yield* Event.on(Token, handler)`                                                                                    |
| `ctx.on(name, listener, true)` / `{ prepend: true }` | `Event.on(Token, handler, { prepend: true })`                                                                        |
| `{ global: true }`                                   | `{ global: true }`: every realm, filters ignored                                                                     |
| `ctx.once(name, listener)`                           | `Event.once(Token, handler)`                                                                                         |
| Disposer returned by `ctx.on`                        | The registration ends with the current `Scope`; for an earlier end, register inside `Effect.scoped` or a child scope |
| `this` inside a listener                             | Handler parameters only; capture what you need in the closure                                                        |

Handlers return Effects. A handler runs with **its own plugin's** services,
realm and intercepts, not the dispatcher's, and each call gets its own `Scope`.

## Dispatching

| cordis                           | Graft                                 | Behavior                                                                                                                                          |
| -------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.emit(name, ...args)`        | `Event.emit`                          | Sequential; stops at the first failure.                                                                                                           |
| `ctx.parallel(name, ...)`        | `Event.parallel`                      | All at once; failures combined in one `Cause`.                                                                                                    |
| `ctx.serial(name, ...)`          | `Event.bail` or `Event.emit`          | cordis `serial` awaits each listener and stops at the first non-nullish, non-`false` result: use `bail` when a result is wanted, `emit` when not. |
| `ctx.bail(name, ...)`            | `Event.bail`                          | First `Some` wins. Map cordis "truthy result" to `Option.some`, `undefined`/`null`/`false` to `Option.none()`.                                    |
| `ctx.waterfall(name, ..., last)` | `Event.waterfall(Token, input, last)` | Middleware chain; each handler gets `(input, next)`.                                                                                              |

Two semantic changes to check in every port:

- **cordis `emit` does not await async listeners.** They run detached, and their
  rejections are lost. Graft `Event.emit` runs handlers in sequence and waits
  for them. If the cordis code relied on fire-and-forget, wrap the dispatch in a
  `Plugin.fork` task.
- **`next` runs downstream once.** Repeated or concurrent `next` calls share one
  result instead of throwing.

## Filters and `thisArg`

cordis passes a `thisArg` whose `[Context.filter]` decides which listener
contexts receive the event. Graft uses `Event.filtered`, which gets the
**registration context** of each handler:

```ts
const formalOnly = Event.emit(Message, "Hello").pipe(
	Event.filtered((owner) => Context.get(owner, Formal)),
)
```

Data that cordis passed as `thisArg` for handlers to read becomes an explicit
event argument.

## Realms

Events share realms with services. Put the token in a fork's `isolate` option to
give that subtree its own handlers. See [isolation](isolation.md).
