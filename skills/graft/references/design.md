# Designing with plugins and Effects

Design before code. A Graft program is good when its shape matches the problem's
**lifetimes**: what can start, stop, change, fail and be replaced on its own.
Find those first; the API calls follow.

## Think in plugins

Take the feature list and ask of each part, in order:

| Question                                                              | If yes, it is…                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| Could someone turn it on or off, reconfigure it, or replace it alone? | A **plugin** (one entry in `graft.yml`)                    |
| Does it offer a capability that other parts call?                     | A **service** its plugin publishes; callers `inject` it    |
| Does it announce something that any number of parts may react to?     | An **event**; the sender does not know the receivers       |
| Do parts contribute pieces to one result (help text, menus, routes)?  | An event collected with `Event.parallel` or `Event.bail`   |
| Do parts transform one value in a chain (filters, rendering)?         | A **middleware** event with `Event.waterfall`              |
| Does it vary per tenant or instance, side by side?                    | A **realm**: the same plugins under a group with `isolate` |
| Does a shared service need a per-caller setting?                      | An **intercept** on a `Context.Reference`                  |
| Does it live as long as the process and nobody configures it?         | An **environment** service in the host's layer             |
| Must it crash alone, use its own thread or run on another machine?    | Still a **plugin**; its entry uses [Remote](remote.md)     |
| Is it a value the operator chooses?                                   | A field in the plugin's config **schema**                  |

Then put **state where its owner lives**. State belongs to the fork that creates
it (a `Ref`, a connection, a cache), and other forks reach it only through that
fork's service or events. When the fork stops, its state goes with it; when it
restarts, it starts clean.

### Ownership replaces bookkeeping

Most code a plugin system usually needs disappears when every registration has
an owner. Reach for the right-hand column:

| Hand-written approach                              | Graft approach                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| A central registry plus code that unregisters      | `Event.on` or `Graft.provide` inside `apply`; the scope unregisters  |
| `if (client)` checks before using an optional part | `inject: [Client]`: the code runs only while `Client` exists         |
| A startup order list                               | Dependencies: each plugin waits for what it injects                  |
| A module-level singleton                           | A service published by a plugin, or an environment service           |
| Feature flags in code                              | `disabled: true` on the entry                                        |
| Restarting the process to reconfigure              | A new entry `config`; an update function to keep running             |
| A list kept in sync with what is enabled (`/help`) | An event every feature handles; collect it on demand                 |
| try/catch that keeps a broken part limping         | Let the fork fail; it is cleaned up and retried, others keep running |

### Sizing plugins

- One plugin per independently useful unit. A plugin too large forces unrelated
  parts to restart together; one too small spreads one lifetime over several
  entries that are always loaded together.
- Split by what changes together: a client and the commands that use it are two
  plugins when the commands can exist without being reconfigured with the
  client.
- A plugin that loads a fixed set of children is a composition; a group entry in
  `graft.yml` is the same composition left to the operator. Prefer the group
  when the operator should choose the members.

## Think in Effects

| Habit                                       | In practice                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Describe, then run at the edge.**         | Modules define values. Only the host runs them, and only `apply` acquires anything.                                                   |
| **Every lifetime is a `Scope`.**            | For each resource and fiber, name its owner and when it ends: the fork, a task, a handler call.                                       |
| **Failures are values.**                    | Expected failures are tagged errors in the type; bugs are defects. Both keep their `Cause`.                                           |
| **Recover where you can act.**              | Catch an error at the closest point that can do something useful; let the rest fail the fork and retry.                               |
| **Dependencies live in the type.**          | A requirement shows up in `R`; satisfy it with `inject` or a `Layer`, never a global.                                                 |
| **Concurrency is structured.**              | Fibers have owners (`Plugin.fork`, `FiberSet`). Use `Stream` for sequences, `Queue` or `PubSub` for hand-off, `Ref` for shared state. |
| **Time and randomness are services.**       | `Schedule`, `Clock` and `Random` make retries and timing testable with `TestClock`.                                                   |
| **Validate at the boundary, trust inside.** | `Schema` decodes config, files and network input once; inside, values are typed and immutable (`Option`, `Data`, `HashMap`).          |

A useful test: if a piece of code needs to remember to clean something up, an
owner is missing. If it needs to check whether something exists, a dependency is
missing. If it catches an error only to log and continue, decide whether that
error is expected (handle it where it happens) or a failure (let the fork fail).

## Worked example: a chat bot

Features: `/roll`, `/weather <city>` (needs a weather API client), `/help`
listing whatever commands are enabled, a moderation filter with an editable word
list.

| Part                    | Becomes                                                                                 | Why                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Incoming messages       | Middleware event `Inbound`, run with `Event.waterfall`; `last` dispatches the command   | Filters can wrap, change or stop a message                              |
| Commands                | Event `Command` answered with `Event.bail`                                              | The first command that recognizes the name answers                      |
| Help lines              | Event `Describe` collected with `Event.parallel`                                        | Each command contributes its own line                                   |
| Moderation              | Plugin with an `Inbound` handler and an update function                                 | Answers without `next` on a banned word; the word list changes in place |
| Weather client          | Plugin publishing service `Forecasts`                                                   | A capability with a connection to own                                   |
| `/weather`              | Plugin with `inject: [Forecasts]`                                                       | Exists only while the client does                                       |
| `/roll`, `/help`        | One plugin each                                                                         | Turned on and off independently                                         |
| A real client's API key | `Schema.RedactedFromValue(Schema.String)` in the client's config, `!env` in `graft.yml` | The operator's secret, hidden in logs                                   |

What follows without extra code: unloading the weather client stops `/weather`
first, `/help` stops listing it, and an invalid moderation config fails only
moderation. The repository's `samples/chat-bot` is this design, with tests;
`samples/market-feed` and `samples/saas-tenants` apply the same questions to a
data pipeline and to per-tenant realms.

## Design checklist

Done when every line holds:

- Every part has a row: plugin, service, event, realm, intercept, environment or
  config field.
- Every piece of state has one owning fork, reached by others only through a
  service or an event.
- Every resource has an owning scope, and every background fiber goes through
  `Plugin.fork`.
- Every interaction between plugins is a token in a shared module.
- Every expected failure has a recovery point, and every other failure is left
  to fail its fork, with a `retry` schedule where retrying helps.
- Every setting is either a config field, an environment service, or an
  intercept, chosen by who sets it and how long it lives.
