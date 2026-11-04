---
title: Core concepts
description: The few ideas that the rest of the documentation builds on.
---

Graft runs an application as a **tree of plugins**. This page names the parts.
Each row links to the page that explains it.

## The parts

| Concept       | What it is                                                                 | Learn more                     |
| ------------- | -------------------------------------------------------------------------- | ------------------------------ |
| **Plugin**    | A value that describes how to start something.                             | [Plugins](../plugins/)         |
| **Fork**      | One running instance of a plugin, with its own config and `Scope`.         | [Lifecycle](../lifecycle/)     |
| **Service**   | An Effect `Context` key with a value, published and withdrawn at run time. | [Services](../services/)       |
| **Event**     | A typed token. Handlers belong to the plugin that registered them.         | [Events](../events/)           |
| **Realm**     | A boundary for which services and events a fork can see.                   | [Realms](../isolation/)        |
| **Intercept** | A change to a `Context.Reference` for one fork and everything below it.    | [Intercepts](../intercepts/)   |
| **Entry**     | One line of `graft.yml`. It loads one plugin.                              | [Config file](../config-file/) |
| **Loader**    | Turns a list of entries into forks, and keeps them in sync with edits.     | [Loader API](../loader-api/)   |

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

| Guarantee                             | Where it comes from                                             |
| ------------------------------------- | --------------------------------------------------------------- |
| Dependencies are declared and checked | `inject` is checked by the compiler.                            |
| Consumers stop before providers       | [How withdrawal works](../services/#how-withdrawal-works).      |
| Resources are always released         | Each fork owns a `Scope`; tasks belong to a `FiberSet`.         |
| Failures keep their full `Cause`      | [Fork states](../lifecycle/#fork-states), [Errors](../errors/). |
| Replacement is atomic                 | [Replace plugins](../replace/).                                 |

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
time, the plugin tree, events, config files and hot reload.

## Where to go next

| I want to…                       | Read                           |
| -------------------------------- | ------------------------------ |
| Run something now                | [Quickstart](../quickstart/)   |
| Write a plugin                   | [Plugins](../plugins/)         |
| Know why a plugin is not running | [Lifecycle](../lifecycle/)     |
| Configure an app without code    | [Config file](../config-file/) |
| Understand an error name         | [Errors](../errors/)           |
| Run a plugin in another process  | [Remote](../remote/overview/)  |
