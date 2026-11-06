# Graft app

A [Graft](https://github.com/graftland/graft) application. `graft.yml` lists the
plugins to run:

| Plugin    | File             | What it shows                                            |
| --------- | ---------------- | -------------------------------------------------------- |
| `hello`   | `src/hello.ts`   | A plugin with config that logs when it starts and stops. |
| `greeter` | `src/greeter.ts` | A plugin that publishes the `Greeter` service.           |
| `ticker`  | `src/ticker.ts`  | A plugin that injects `Greeter` and greets every 3 s.    |

| Script              | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run dev`       | Runs the application and reloads plugins and config as files change |
| `npm start`         | Runs the application                                                |
| `npm run typecheck` | Checks types, including Effect diagnostics                          |

Use the same scripts with pnpm (`pnpm dev`) or Yarn (`yarn dev`). Node runs the
TypeScript sources directly; there is no build step.

## Try it

Run `npm run dev`, then, while it runs:

| Do this                                                                        | You see                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Change the interval in `src/ticker.ts` and save.                               | `Ticker stopped`, then the ticker at the new pace. `hello` and `greeter` are not restarted. |
| Change `greeting` in `graft.yml` and save.                                     | `Ticker stopped`, `Greeter stopped`, then the new greeting: dependents stop first.          |
| Add `disabled: true` to the `greeter` entry and save.                          | `Ticker stopped`. The ticker waits as `Pending` until you remove the line.                  |
| Make `apply` in `src/ticker.ts` fail, such as `Effect.fail("oops")`, and save. | A warning with the cause; the previous ticker keeps greeting.                               |
| Change `inject: [Greeter]` to `inject: []`.                                    | `npm run typecheck` reports that `apply` uses a service it did not declare.                 |
