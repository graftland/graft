# @graftland/plugin-release

Immutable managed application releases, configuration planning and rollback
through Graft Changes.

A rejected Change request stops forward execution and compensates earlier
accepted entries in reverse. Compensation uses the version produced by each
accepted Change; a later accepted Change is preserved on conflict. Observations
distinguish rejections from admitted Change ids. Each allocation resolves the
retained desired configuration again, including recovery and compensation.

https://graftland.github.io/graft/application-releases/
