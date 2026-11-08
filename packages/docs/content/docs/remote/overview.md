---
title: Remote units
description: Run captured plugins in native units.
---

Remote executes captured plugin code in a [native unit](../../units/). Units use
encoded unary [contracts](../contracts/) and fixed [bindings](../../bindings/).

Submit replacement through [public control](../../control/). The kernel loads
fixed metadata only; contract imports, configuration decoding and handlers run
inside units.

Choose Worker, Process or Runner in the target. Native exit evidence settles
reservations. A disconnected Runner has no confirmed exit; its unresolved work
remains visible.
