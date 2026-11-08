# Phase 5 evidence

Status: complete. Written by Claude; GPT reviews once after all phases.

| Rule (`phase-5.md`)                                                | Evidence                                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interleaving, reopening, history by Change id, unconcluded Changes | `journal.test.ts`: `interleaves concurrent Changes, survives reopening and summarizes each Change by id (C4)`                                                                        |
| Repeats acknowledged once; conflicting content refused             | `journal.test.ts`: `acknowledges a repeat without a second line and refuses the same id with other content`                                                                          |
| Torn tail truncated; earlier corruption refused                    | `journal.test.ts`: `truncates a torn final line on open and refuses corruption before the tail`                                                                                      |
| Segment rotation keeps order                                       | `journal.test.ts`: `starts a new segment at the size limit and keeps the order across segments`                                                                                      |
| fsync failure is a storage failure; the retried record lands once  | `journal.test.ts`: `reports a failed fsync as a storage failure and acknowledges the retried record once (C4)` (injected failing file system)                                        |
| On disk before acknowledgement, in a real unit                     | `recorder-unit.test.ts`: `journals every stage of a recorded Change on disk before acknowledging it, readable by Change id (C4)`                                                     |
| Storage failure blocks the Change                                  | The recorder retries a failed append and only then acknowledges; the kernel side is `recording-duties.test.ts` from Phase 3 (no acknowledgement → no forward action, no `Accepted`). |

## Deleted

| Removed                                                                                                             | Reason                                                    |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/plugin-release/src/internal/journal.ts`                                                                   | Single-pending-intent replay model, replaced by `Journal` |
| `packages/plugin-release/src/internal/changes.ts`                                                                   | Used only by the deleted replay model                     |
| `storage.durable`                                                                                                   | Whole-file rewrite of the old journal                     |
| Model schemas `Change`, `Plan`, `Status`, `OutcomeSummary`, `JournalObject`, `RejectionSummary`, `Event`, `Journal` | The old journal's records                                 |
| `storage.test.ts`: `replays admission rejection separately from admitted outcomes and failed compensation`          | Old replay model                                          |
| `storage.test.ts`: `retains strict version-one journal rejection validation after removing runtime adapters`        | Old replay model                                          |

## Open

Durable request-key deduplication across kernel restarts, per-member recovery
checkpoints, diagnostics retention and segment compaction (see `phase-5.md`
"Non-goals"). A sync failure after the bytes were written can leave a duplicate
identical line on retry; reading tolerates it.
