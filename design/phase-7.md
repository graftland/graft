# Phase 7: contract evolution and projection

Status: complete, 2026-11-08. Written by Claude; GPT reviews once after all
phases. Sources: plan Phase 7; `architecture.md` §4 (communication forms,
notification row) and §11.2 slice 2.

## Notifications as unary deliveries

`@graftland/plugin-remote/Notifications` carries notifications over two unary
operations of one contract service (`<name>/subscribe@1`, `<name>/next@1`).

| Architecture rule (§4)                               | Implementation                                                                                    | Evidence                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| No Effect RPC notification request mode              | Both operations are ordinary unary RPCs; bindings, budgets and call evidence apply unchanged      | `notifications-native.test.ts` (Worker emitter → Process subscriber) |
| Acknowledged after the subscriber handled it         | `next(session, after)` acknowledges `after`; `subscribe` pulls again only after `handle` finished | `notifications.test.ts`: "acknowledges … after its handler finished" |
| Order within one live emitter–subscriber session     | One FIFO queue per session; sessions start with the next published notification                   | Order and independence tests                                         |
| Unknown result is not resent                         | An unacknowledged delivery is reported once as `Lost`, then dropped                               | "reports … as Lost and never sends it again"                         |
| Does not overtake an unsettled delivery              | One outstanding delivery per session; the next pull settles it before handing out another         | Same test                                                            |
| Bounded queue                                        | `capacity` (default 256) per session; overflow drops the oldest and reports `Dropped(count)`      | "bounds each session's queue …"                                      |
| At most once; replay across restarts is the domain's | Sessions live in emitter memory; a restarted emitter starts with no sessions                      | Documented                                                           |

### Deviation: pull instead of push

§4 says the emitter calls a unary delivery operation on each subscriber. The
implementation inverts the direction: the subscriber calls `next` on the
emitter. Reasons:

- Bindings point from consumer to provider. Push would make every subscriber a
  provider that the emitter injects, so the emitter's dependencies would change
  whenever a subscriber is deployed or removed; every subscription would be a
  Change of the emitter.
- With pull, deploying or removing a subscriber touches only the subscriber and
  its binding (Scale: the cost of a change does not grow with the number of
  subscribers).

Every delivery rule in §4 is kept. What changes: the emitter cannot tell a slow
subscriber from a gone one except by idle time (12 × `wait`), and a delivery is
only as fast as the subscriber's next pull. The owner confirms this deviation.

## MCP description changes

Already implemented before this phase; verified against the plan's rules.

| Rule                                              | Evidence (`plugin-mcp-server/test/contract-projection.test.ts`)               |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| A description change does not cancel old calls    | "retains admitted calls while recording and publishing a new description"     |
| An old approval does not cover a new description  | "rejects cached tool calls after a description change until exact reapproval" |
| Invalidation happens before the change is exposed | Same test: the call after `list_changed` is `Unapproved` and never executes   |
| Unchanged metadata keeps its approval             | "keeps approval when an unchanged projection is withdrawn and remounted"      |

## Not done in this phase

| Item                                             | Where                         |
| ------------------------------------------------ | ----------------------------- |
| Notification sessions surviving emitter restarts | Not planned (domain protocol) |
| Server streams                                   | Not in the first slice (plan) |

## Changed

- `packages/plugin-remote/src/Notifications.ts` (new): `service`, `emitter`,
  `subscribe`, `Channel`, `Delivery`, `EmitterOptions`; exported as
  `@graftland/plugin-remote/Notifications`.
- Docs: `remote/contracts.md` § Notifications (three languages).
