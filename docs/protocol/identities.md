# PatchMesh Identity and Resource-Version Protocol

> **Status:** Phase 0 normative contract. No runtime implementation exists yet.

## Authority and scope

This document defines identity equality, path normalization, target snapshots, and
version scope. The versioned schema owns machine shape; this document owns derivation
and comparison.

## Repository, workspace, and worktree

`repositoryId`, `workspaceId`, and `worktreeId` are opaque generated IDs. Repository
identity is persisted below Git's common directory, worktree identity is persisted in
its Git administrative directory, and workspace identity identifies one filesystem and
execution context. Linked worktrees share a repository ID; paths, branches, commits,
remote URLs, and filesystem roots never derive identity. Workspace and worktree IDs are
distinct, and explicit nullable fields represent absence.

## Integration targets and snapshots

Targets are `branch`, `revision`, or `candidate_aggregate`. Each evaluation pins an
immutable snapshot containing repository, normalized locator, resolved base commit,
ordered candidate IDs, and a SHA-256 digest of the closed canonical snapshot object.
Validity evidence names `targetSnapshotId`, never only a moving branch.

## Logical resources and paths

Resources are repository-scoped `file`, `symbol`, `api`, `schema`, or `test` records.
Their ID is `res_` plus the SHA-256 digest of `[repositoryId, resourceKind,
normalizedLocator]`. A rename creates a new resource and a separate relationship.

Logical paths are UTF-8 NFC, repository-relative, slash-separated, and case-preserving.
Absolute paths, backslashes, NUL bytes, empty segments, `.`, `..`, and trailing slash
paths are rejected. Case-folding collisions are identity errors. Symlink paths retain
their logical identity and target evidence is separate.

## Version domains and resource versions

A version domain is the tuple of repository, workspace, and worktree IDs. V1 kinds are
`git_commit`, `git_blob`, `content_hash`, `symbol_signature`, `schema_version`,
`api_version`, and `deleted`; `deleted` has a null value, all other kinds have a
non-empty string value. Every version carries observation event IDs. `observed`,
`candidate`, `target`, `integrated`, and `current` are comparison roles, not global
namespaces.
