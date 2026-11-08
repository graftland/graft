---
title: Core concepts
description: The few ideas that the rest of the documentation builds on.
---

Graft runs an application as a **tree of plugins**. This page names the parts.
Each row links to the page that explains it.

## Core words

Each of these words has one meaning in every package and page.

| Word                 | Meaning                                                                                       | Learn more                                       |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Plugin**           | A value that declares and implements one capability: config, dependencies, services, startup. | [Plugins](../plugins/)                           |
| **Instance**         | A plugin in a deployment with a stable identity. A Loader entry id is an instance name.       | [Config file](../config-file/)                   |
| **Service**          | An Effect service. Graft adds publication, withdrawal and leases at run time.                 | [Services](../services/)                         |
| **Contract**         | An Effect `RpcGroup` plus the identity of each operation.                                     | [Remote contracts](../remote/contracts/)         |
| **Realm**            | The boundary within which services and contributions are visible.                             | [Realms](../isolation/)                          |
| **Deployment group** | Instances that share one unit and are affected together when it ends.                         | [Units](../units/)                               |
| **Unit**             | A Worker, child process or runner execution that hosts instances.                             | [Units](../units/)                               |
| **Generation**       | One execution of an instance, from start to end.                                              | [Changes](../transitions/)                       |
| **Placement**        | The kind of unit and who manages it.                                                          | [Units](../units/)                               |
| **Artifact**         | Content-addressed plugin code whose bytes do not change while it runs.                        | [Artifacts](../remote/artifacts/)                |
| **Release**          | Immutable artifacts, config (secrets as references) and deployment declarations.              | [Application releases](../application-releases/) |
| **Change**           | One identified change to the running state.                                                   | [Changes](../transitions/)                       |
| **Outcome**          | How a Change ended, with its evidence.                                                        | [Outcomes](../transitions/#outcomes)             |
| **Probe**            | A named health check that a plugin registers.                                                 | [Probes](../probes/)                             |
| **Trust policy**     | Operator rules for trust tiers, grants, approval and revocation.                              | [Trust](../trust/)                               |

## Other terms

| Term          | Meaning                                                                  | Learn more                     |
| ------------- | ------------------------------------------------------------------------ | ------------------------------ |
| **Fork**      | The handle of a running plugin, with its own config and `Scope`.         | [Lifecycle](../lifecycle/)     |
| **Event**     | A typed token. Handlers belong to the plugin that registered them.       | [Events](../events/)           |
| **Intercept** | A change to a `Context.Reference` for one fork and everything below it.  | [Intercepts](../intercepts/)   |
| **Entry**     | One line of `graft.yml`. It deploys one instance.                        | [Config file](../config-file/) |
| **Loader**    | Turns a list of entries into Changes, and keeps them in sync with edits. | [Loader API](../loader-api/)   |

## How the parts relate

1. A plugin is **loaded** into a fork. Loading the same plugin twice gives two
   independent forks.
2. A fork can **publish** services and **inject** services from others.
3. A fork can **load children**. They stop when the parent stops.
4. Realms and intercepts shape what a fork and its children can see.
5. A fork's code usually runs in the application's process. With
   [Remote](../remote/overview/), it runs in a child process, a worker or on
   another machine instead, and its services are still published and injected in
   the application as usual.

## Guarantees

| Guarantee                                      | Where it comes from                                             |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Dependencies are declared and checked          | `inject` is checked by the compiler.                            |
| Consumers stop before providers                | [How withdrawal works](../services/#how-withdrawal-works).      |
| Resources are always released                  | Each fork owns a `Scope`; tasks belong to a `FiberSet`.         |
| Failures keep their full `Cause`               | [Fork states](../lifecycle/#fork-states), [Errors](../errors/). |
| A failed Change leaves the old plugins running | [Change outcomes](../transitions/#outcomes).                    |

## Built on Effect

Graft adds no parallel vocabulary. It maps directly onto Effect:

| In Graft                 | In Effect                          |
| ------------------------ | ---------------------------------- |
| Plugin activation        | An `Effect` that runs in a `Scope` |
| Service                  | A `Context` key                    |
| Plugin config            | A `Schema`                         |
| Background task          | A `Fiber`, owned by a `FiberSet`   |
| Retry                    | A `Schedule`                       |
| Reference-based settings | `Context.Reference`                |

Graft adds only what Effect does not have: services that come and go at run
time, the plugin tree, events, config files and Changes. For habits that keep
plugin code within these mappings, see
[Effect in plugins](../best-practices/effect/).

## Where to go next

| I want to…                       | Read                                               |
| -------------------------------- | -------------------------------------------------- |
| Run something now                | [Quickstart](../quickstart/)                       |
| Write a plugin                   | [Plugins](../plugins/)                             |
| Know why a plugin is not running | [Lifecycle](../lifecycle/)                         |
| Configure an app without code    | [Config file](../config-file/)                     |
| Understand an error name         | [Errors](../errors/)                               |
| Run a plugin in another process  | [Remote](../remote/overview/)                      |
| Plan the parts of an application | [Design an application](../best-practices/design/) |
