---
name: collaborate-with-gpt-6
description: >-
  Use when you work with an OpenAI GPT-6 model (GPT-6 Astra, GPT-6.1 Sol, GPT-6
  Luna) as a worker or reviewer: understanding its decision habits, choosing the
  member, briefing it and checking what it returns. Applies through any harness;
  to run it through Codex CLI, also load `codex`.
---

# Collaborate with GPT-6

Astra and Sol organise work around explicit decision criteria. They translate
source precedence into code, compare implementations against reference systems,
and put safeguards into execution. Give them the controlling sources and the
acceptance condition before implementation. Use separate guidance for Luna.

## Decision habits

**Source evidence changes the implementation.** Astra and Sol correct their own
checks when the original system contradicts them. Give a correction together
with the source statement, measurement or counterexample that requires it.

**Checks carry the decision through to completion.** They use assertions,
dry-runs and differential comparisons to govern execution. Review the premises
behind those checks separately: agreement with a generated expectation does not
establish that the expectation follows the requirements.

**The final message compresses the work.** Decisions, incidents and changes of
interpretation appear in process messages and deliverables. Ask for those items
in the final hand-off instead of relying on its completion statement.

## Pick and adjust for the member

- **Sol**: use for implementation with explicit sources and acceptance checks.
  Its guards check data and state. Add latency and side effects to live-work
  criteria, and inspect the results of each action in bundled commands.
- **Astra**: use for comparing source evidence and reconciling alternatives.
  Require each recorded discrepancy to be tied to an acceptance condition or
  listed as a separate finding in the hand-off.
- **Luna**: use for bounded implementation with real execution feedback. Its
  execution-error diagnosis is stronger than its handling of conflicting
  interpretations. Supply domain inputs; review constants, classifications and
  structural constraints separately from implementation tests.
- For a second review of Astra or Sol, have the reviewer derive the acceptance
  criterion from the original evidence before reading the implementation.

## Brief it

- "Use these controlling sources in this order. List the source for every domain
  constant and consequential interpretation."
- "Acceptance uses this reference. Report each failed or interrupted check
  against it; label any substitute measurement separately."
- "Separate checks of implementation from checks of interpretation. For each
  interpretation, identify the evidence that would require a different result."
- For live work: "Rehearse the full transition on an isolated copy. Include
  latency, side effects and restoration in the acceptance checks."
- For Luna: "List missing inputs before using them. Do not put a guessed
  constant or structural constraint into a test's expected result."
- "End with decisions made, failed checks, discrepancies, incidents, environment
  changes and the status of each restoration."

## Check what comes back

- Trace each decisive check to its source. Read-back checks persistence; inspect
  the shared premises of separately written implementations.
- Compare the reported result with the original acceptance measure. For every
  changed assertion, check the evidence that justified the change.
- Reconcile the final message with process messages and deliverables, including
  errors inside commands whose later actions succeeded.
- For Luna, check the direction of conflicting numbers, the origin of constants,
  actual runtime coverage, retained backups and completed restorations.
