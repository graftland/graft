# Phase 5: durable release journal

Status: specification, 2026-11-08. Written by Claude; GPT reviews once after all
phases. Sources: `architecture.md` §6.2–6.3 and §8.1; `phase-3.md` "Release unit
and recording obligations"; the plan's Phase 5 section.

## Commitments (slice 3, C4)

- A recorded Change is acknowledged only after its record is on disk.
- The history of every recorded Change can be read by Change id after a crash of
  the release unit or of the whole process, including Changes that never
  concluded.
- Storage failure blocks the dependent Change; it never produces a success.

## Journal

| Rule                   | Behavior                                                                                                                                                                                    | Source                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Format                 | Append-only segments `segment-NNNNNN.jsonl` in the release unit's `directory`; one JSON line per record: id, Change id, stage, content identity, payload.                                   | A §8.1 "日志"                |
| Durability             | A record is written and `fsync`ed before the recorder acknowledges it. A new segment is created and its directory synced before use.                                                        | A §6.3                       |
| Interleaving           | Records of concurrent Changes interleave in arrival order; nothing is rewritten.                                                                                                            | A §8.1                       |
| Repeats                | A record already present with the same content is acknowledged without a second append; the same id with other content is a conflict and is never acknowledged.                             | P3 §"Record and acknowledge" |
| Torn tail              | On open, a final line without its newline or that does not decode is truncated and counted in `recovered.truncated`. A bad line before the tail is corruption: the journal refuses to open. | plan "尾记录截断"            |
| Append or sync failure | Not acknowledged. The recorder retries the append every second while its unit runs; the kernel keeps the duty outstanding and the Change blocked.                                           | P3 O4; A §6.3                |

## History

`Journal.history(directory)` reads the journal without a running kernel and
returns one summary per Change id: the recorded stages, members, targets,
outcome (from the concluding record) and `concluded`. A Change with an intent
but no concluding record is reported unconcluded — after a process crash this is
the evidence of interrupted work.

## Deleted

The single-pending-intent replay model (`internal/journal.ts`), its whole-file
rewrite (`storage.durable`), and the `Journal`, `Event`, `JournalObject`,
`Plan`, `Status`, `Change`, `OutcomeSummary` and `RejectionSummary` schemas.

## Non-goals in this phase

Durable request-key deduplication across kernel restarts and per-member recovery
checkpoints (the kernel's Changes live in memory, so a kernel restart starts
with no Changes to recover); diagnostics retention; segment compaction. These
are recorded as open in the final audit.

## Enough bar

Each rule has a test with an injectable failing file system or a real file; the
release recorder runs durably in a native unit; full checks pass.
