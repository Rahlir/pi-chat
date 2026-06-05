# Design note: capability scoping

Reference for how pi-chat classifies its capabilities across sessions. The
decision itself (drivers, options, chosen approach, compliance rules) lives in
[ADR-0001](./adr/0001-capability-scoping.md); this note holds the supporting
analysis and the per-capability classification that the ADR deliberately omits.

## Problem

pi-chat is installed as a package, so its extension factory runs in **every**
pi session, not just chat workers. Capabilities meant for a connected chat
session currently leak into ordinary coding sessions:

- `pi.setActiveTools([...])` runs unconditionally in `session_start`, clobbering
  the active tool set of every session down to pi-chat's 8-tool allowlist. This
  hides builtins, MCP, and other extensions' tools in non-chat sessions.
- Turn-only tools (`chat_attach`, `chat_history`, `chat_request_secret`) sit in
  the model's context in sessions that can never use them.
- The `chat` status segment is painted ("disconnected") in every status bar via
  `updateStatus` from `session_start`.

The root cause is conflating "the package is loaded" with "this session is the
active chat driver." Capability availability must be a function of **connection
state**, not load state.

## Model

There is no single global-vs-connected axis. Classify each capability on two
axes.

### Lifecycle (when is it meaningful?)

1. **Control plane** - managing chat from any session (configure, spawn,
   inspect, connect). Operator-driven.
2. **Bridge** - this pi process is acting as a worker for a channel.
3. **Turn** - the model is mid-reply to a remote trigger.

### Capability type (what does it cost to be wrong about scope?)

| Type | Out-of-scope cost | Gate strategy |
|---|---|---|
| Tool | High: schema enters model context every turn; model may misfire | Gate via active set |
| Command | ~Zero model cost; only menu clutter | Keep global; guard handler |
| Status / widget | Ambient human noise | Scope to when it is true |
| Renderer / handler | Zero if it self-guards | Register global; early-return |

## Mechanism constraints (pi API)

These shape what is even possible:

- `registerTool` / `registerCommand` return `void`. **No unregister.**
  Registration happens once per session; the only runtime lever for tools is
  `setActiveTools`, and for commands it is guarding the handler.
- Registered tools are **active by default** (callable without `setActiveTools`).
  So scoping a tool out is not a no-op: in non-connected sessions the reconciler
  must explicitly remove pi-chat's turn tools from the active set, **filtering**
  the current set rather than replacing it so builtins and other extensions'
  tools are untouched.
- `setStatus(key, undefined)` removes a status segment, so status is freely
  scopable.
- Renderers and event handlers are inert until triggered, so global registration
  is free if they self-guard.

Because tools cannot be unregistered, the three lifecycles **collapse to two
states for tool activation**: connected vs not. A worker only runs the model
during a turn, and the turn boundary is already enforced by each tool's
`chatTurnInFlight` guard plus the `tool_call` gate. So we do not flip active
tools per turn.

## Classification

| Capability | Type | Lifecycle | Treatment |
|---|---|---|---|
| `chat-config`, `chat-list`, `chat-connect` | command | Control plane | Global |
| `chat-spawn-all` / `open-all` / `kill-all` / `chat-workers` (cmd) | command | Control plane | Global |
| `chat-disconnect`, `chat-status`, `chat-new` | command | Bridge | Global registration; handler no-ops with "no active connection" when not bridged |
| sandboxed `read`/`write`/`edit`/`bash` | tool | Bridge | Active and overriding builtins only when connected |
| `chat_attach`, `chat_history`, `chat_request_secret` | tool | Turn | Active only when connected; in-tool `chatTurnInFlight` guard covers the turn boundary |
| `chat_workers` (tool) | tool | Control plane | Drop (see ADR-0001); the command already serves humans |
| `chat` status segment | UI | Bridge | `setStatus("chat", undefined)` when not connected; show only when bridged or on error |
| `chat-context` renderer | UI | Bridge | Global registration; emits only when connected |
| dispatch / `before_agent_start` / `agent_end` / `tool_call` / `context` | handler | Bridge/Turn | Global registration; early-return when no runtime |
| `--chat-conversation` flag | flag | Control plane | Global |

## Out of scope

- Per-turn active-tool flipping (unnecessary; see Mechanism constraints).
- A "manager mode" that re-enables model-driven control-plane tools. Revisit if
  a supervisor-agent use case materializes.
