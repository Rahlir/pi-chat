---
status: accepted
date: 2026-06-06
deciders: Tadeas Uhlir
scope: extension capability scoping
---

# ADR-0001: Scope pi-chat capabilities by connection lifecycle, not load state

## Context

pi-chat is installed as a package, so its extension factory runs in **every** pi
session, not just chat workers. Today `pi.setActiveTools([...])` runs
unconditionally in `session_start`, which clobbers the active tool set of every
ordinary coding session down to pi-chat's allowlist, hiding builtins, MCP, and
other extensions' tools. Turn-only tools and the `chat` status segment leak the
same way. The root problem is conflating "the package is loaded" with "this
session is the active chat driver." See [capability-scoping.md](../capability-scoping.md)
for the full per-capability analysis.

## Decision drivers

- Ordinary sessions must keep their full toolset, status bar, and context clean; pi-chat must contribute nothing it does not need there.
- The pi API has **no unregister** for tools or commands, so existence is per-session-static; the only runtime levers are `setActiveTools` (tools) and handler guards (commands).
- Every active tool costs model context every turn and invites misfires, so tools must be gated hard; commands cost only menu clutter.
- A session can become a chat worker at runtime via `/chat-connect`, so scoping decided once at startup is insufficient.
- The current `setActiveTools` list and `tool_call` gate are two hardcoded lists that already drift (`chat_workers` is in one, not the other).

## Options considered

### Option A: Do nothing
- Good: zero work.
- Bad: the leak persists; every coding session loses its tools and gains a stale `chat` status segment.

### Option B: Single enforcement via the `tool_call` gate only
- Good: one enforcement point; no `setActiveTools` at all.
- Bad: in a worker the model sees tools it cannot call, wasting turns on blocked calls; the model-visible set no longer matches the callable set.

### Option C: Lifecycle-scoped with a fixed replace-allowlist
- Good: fixes the leak; preserves the sandbox lockdown.
- Bad: still a hardcoded list, so no non-standard tool can ever be enabled in a channel; leaves the two-list drift unaddressed.

### Option D: Lifecycle-scoped, deny-by-default additive policy with one reconciler
- Good: fixes the leak, kills the drift, and makes "allow a non-standard tool in this channel" an explicit opt-in without weakening the default sandbox.
- Bad: more plumbing (config + a reconciler); a missed state transition leaves stale active tools or status.

## Decision

**We chose Option D.**

Register everything globally (commands, handlers, renderer, flag), but
**activate by scope**. A single scope variable drives an `applyScope()`
reconciler called on every transition (`session_start`, connect, disconnect,
shutdown); it recomputes exactly two things, the active tool set and the `chat`
status segment. The connected active set is a deny-by-default base allowlist
(sandboxed `read`/`write`/`edit`/`bash` plus the turn tools), optionally
extended by a per-channel `extraTools` list. `setActiveTools` and the
`tool_call` gate read the **same** computed allowlist. Pre-chat active tools are
captured at connect and restored at disconnect, so `/chat-connect` in an
interactive session is reversible. Because tools cannot be unregistered, the
three lifecycles collapse to two activation states (connected vs not); the turn
boundary is already enforced by each tool's `chatTurnInFlight` guard plus the
`tool_call` gate, so active tools are not flipped per turn.

## Consequences

**Good**
- Ordinary sessions are untouched: builtins, MCP, and other extensions stay visible, no chat tools enter context, and the status bar stays clean.
- One computed allowlist removes the active-set vs `tool_call` drift.
- Per-channel `extraTools` allows controlled opt-in of non-standard tools without loosening the default sandbox.
- `/chat-connect` is reversible because the pre-chat toolset is restored on disconnect.

**Bad**
- A session that runs `/chat-connect` becomes a worker: the human's own tools are swapped for the chat allowlist until disconnect.
- Bridge commands stay visible in every session's command menu (no unregister API); only their handlers guard.
- Correctness depends on every transition reaching the reconciler; a missed transition leaves stale active tools or status.

## Compliance

- `setActiveTools` must never be called from `session_start` or extension top-level, only from the scope reconciler.
- `setActiveTools` and the `tool_call` gate must read the same computed allowlist; no second hardcoded tool list.
- New model-driven tools default inactive and join the channel allowlist policy; they are never activated globally.
- Non-connected sessions must clear the chat status segment (`setStatus("chat", undefined)`), never paint a "disconnected" badge.
- Bridge-scoped commands (`chat-disconnect`, `chat-status`, `chat-new`) must guard their handler and no-op when not connected.

## References

- Design note: [capability-scoping.md](../capability-scoping.md)
