---
name: mcp-servers
description: You MUST load this before building, designing, hardening, reviewing, or discussing an MCP server — tools/list and tools/call, the discover response, transports and sessions, per-request authentication, multi-tenant isolation, cacheScope and ttlMs, or refusals that must not reveal what exists. Applies to design and architecture questions with no code present.
---

# MCP Servers

## Use this when

You are writing the server side of the Model Context Protocol: a `tools/list`
handler, the middleware that filters it, the seam where a bearer token becomes
a caller identity, or the response returned to someone who asked for something
they were not granted.

Two facts of the `2026-07-28` revision set every rule below. **There is no
session** — no `initialize`, no `Mcp-Session-Id`, so identity is established per
request or not at all. And **list results carry cache hints**, so a filtered
listing is now something infrastructure may legitimately store and replay.

The load-bearing premise: **a filtered listing is not authorization.** Dispatch
takes a name, and a tool absent from a listing is still callable by name.

## Rules

1. **Put the tenant credential on the transport — the `Authorization` header,
   at the SDK's token-verifier seam — never in per-request `_meta`.** An SDK
   issues protocol requests your code never writes, and they carry no
   *application* metadata. Concretely, on the official Python SDK one
   `call_tool()` produces two server-visible requests: the `tools/call`, and an
   internal `tools/list` from `validate_tool_result()` checking the output
   schema. `call_tool()` takes a `meta=` argument; `list_tools()` has no such
   parameter, so a credential in `_meta` cannot reach the second one and the
   server refuses its own client. The tempting repair — exempt `tools/list`
   from authentication — reopens exactly the hole being closed. Generalize it:
   a credential must live where every request the transport sends carries it,
   including revalidations and retries you did not write.
2. **Give `tools/call` its own authorization branch, checked before the handler
   runs, in addition to filtering the listing.** These are two questions with
   two code paths, and only one of them is a control. A middleware that only
   rewrites the list result demos perfectly, because every client-driven path
   respects the filter. The diff is a branch on the method that reads the
   requested name out of the params and tests it against the caller's grants
   *before* delegating; the test is a call, by name, to a tool that exists and
   was not granted.
3. **Return the refusal as a tool result, not a raised error, and make it
   byte-identical to the unknown-tool result.** A raise becomes a JSON-RPC
   error — a different response *shape* from a tool result, so it is
   distinguishable however carefully the text is worded, and the listing filter
   is undone one probe at a time. Assert it: substitute both tool names with a
   placeholder and compare the two response texts for equality.
4. **Never write `cacheScope: "public"` on a response that was filtered per
   caller, and assert the scope in a test.** It tells every cache on the
   path — client, gateway, CDN — that one tenant's list may be served to
   another, and the server behaves correctly throughout because the leak lives
   in infrastructure it never sees. This one is affirmative, not accidental:
   `"private"` is the safe default in the SDK's `CacheHint`, so the value gets
   copied in from an example built around an unfiltered global listing.
5. **Treat a server-wide cache-hint map as a default, not an enforcement
   point.** The SDK fills `ttlMs`/`cacheScope` per field and only where the
   handler left them unset, so a handler that sets `cache_scope` itself wins
   over the server-wide `private` — read in `mcp` 2.0.0's
   `server/caching.py`, where `apply_cache_hint` skips any field already in
   `model_fields_set`. Grep the handlers too, not just the constructor.
6. **Enumerate the tenant-scoped methods as an explicit set, and fail closed
   when no identity resolves for one.** Inferring the boundary is wrong in both
   directions: too narrow and a scoped method serves unscoped data, too wide
   and you demand a credential for the call a client makes to learn how to
   authenticate. The set is longer than the obvious four — `resources/read`,
   `resources/templates/list`, `prompts/list`, `prompts/get`, and
   `completion/complete` all read tenant-owned data. When the lookup yields no
   tenant, raise; do not serve the unfiltered result.
7. **Verify what your own `server/discover` response contains before leaving it
   unauthenticated.** It is exempt because requiring a credential to discover
   how to authenticate deadlocks bootstrapping, and that exemption is safe only
   while the response carries capability flags and protocol versions — never
   tool or resource names. It is a property of your server to re-check when the
   response grows, not a guarantee of the protocol.
8. **Resolve identity from the in-flight request every time, and hold nothing
   per connection.** No cached capability set, no remembered principal, no
   in-progress operation keyed by connection. Nothing routes the next request
   to the same replica, so the symptom is intermittent and load-dependent —
   right on one replica in development, wrong behind a load balancer. Prove it
   by driving alternating identities through one server object back to back and
   asserting nothing carries over.
9. **Do not let the gateway's view of `Mcp-Method`/`Mcp-Name` stand in for the
   server's own check.** Those headers exist so infrastructure can route, meter,
   and shed load without parsing bodies — they are client-supplied, so edge
   policy keyed on them is metering, not authorization. The official SDK's
   Streamable HTTP transport already rejects header/body disagreement with
   `400` and `HeaderMismatch` (`-32020`) — read in `mcp` 2.0.0's
   `shared/inbound.py`, which checks the protocol version *and* the name
   parameter. On anything hand-rolled that check is yours to write, and on
   every server the actual call still gets authorized on its actual
   parameters.
10. **Filter below model serialization, and rebuild the outbound mapping rather
    than mutating it.** Middleware runs on the wire representation, not the
    typed result model, so the entries you are filtering sit beside protocol
    fields — `cacheScope`, `ttlMs`, `resultType` — that must survive untouched.
    Returning a fresh dict of just the filtered collection silently drops them.
11. **Sign, expire, and size-bound `requestState`, and bind it to the
    authenticated principal.** In a Multi-Round-Trip Request it is state the
    server hands the client and trusts on return, resuming server-side
    execution — the unsigned-cookie mistake with a protocol blessing. The
    official SDK binds it to the principal; a platform should not do less.
12. **Make every `tools/call` handler safe to re-run.** Stream resumability was
    removed in this revision: there is no `Last-Event-ID`, so a broken response
    stream loses the in-flight request and the client re-issues it as a new
    request with a new id. Anything non-idempotent behind that call needs its
    own dedup key, from an argument you chose, not from the request id.

## Deciding

| Situation | Do this | Because |
| --- | --- | --- |
| More than one team wants MCP servers | One shared multi-tenant server, unless a tenant's data is separately regulated | Amortizes patching and capacity, and a new tenant becomes configuration rather than a deployment. The cost is that isolation is now a property of code, so a missing check is a cross-tenant breach where separate deployments would have contained it |
| Choosing where authentication happens | Per request, at the transport | "Put the credential on the transport" — verification is cheap, and per-request buys a fleet with no affinity, no session store, and no partially-authenticated state. Per-session amortizes the verification and reintroduces exactly the stickiness this revision removed |
| Tempted to return the full listing and let the host filter | Filter server-side | The host is not a trust boundary. Returning everything is simpler and lets one cached response serve everyone — which is precisely the shortcut `cacheScope: public` makes available, and precisely why it is wrong |
| Modelling grants | Per tenant first; add role only when delegation inside a tenant is real | Tenant-level grants are simple to audit. Adding the role dimension later is expensive because cache keys and audit history both encode the old shape, so decide it before either exists |
| A single client acts for several tenants | Partition its cache per tenant explicitly | `cacheScope: private` constrains *shared* intermediaries and says nothing to one client's own cache, which keys on the method. The correct `private` is not enough on its own here |
| A tool genuinely needs state across calls | Mint an explicit handle and pass it as a tool argument | The protocol stopped carrying state; it did not stop existing. A handle in the schema is visible, auditable, and expirable, where per-connection state is invisible and breaks under a load balancer |

## Going deeper

| Read | When |
| --- | --- |
| [references/architecture.md](references/architecture.md) | Designing a multi-tenant MCP platform, or placing scale, cost, and observability in it |
| [references/failure-modes.md](references/failure-modes.md) | A tenant saw something it should not have, or the server refused its own client |
| [references/patterns.md](references/patterns.md) | You need the shape of the verifier seam, the two enforcement points, the refusal, or the cache hints |
| [references/review-checklist.md](references/review-checklist.md) | Reviewing someone's MCP server, its middleware, or its listings |
