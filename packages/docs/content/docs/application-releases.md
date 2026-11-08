---
title: Release artifacts
description: Build immutable release directories.
---

`@graftland/plugin-release` builds content-addressed release directories from
package metadata. It exports storage data and validation; deployment uses the
[kernel Change API](../transitions/).

## Build

Use `build` with a store directory and a source file. The result identifies the
immutable directory. `metadataOnly` avoids importing package code. The
[release recorder](../recording/#read-the-journal) journals recorded Changes.
