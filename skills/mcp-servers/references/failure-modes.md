# Failure modes

Symptom first, because that is what you have when someone reports it. Ordered
by what the failure costs. The first four are cross-tenant exposure; the last
two are correctness failures that read as flakiness. Note how many of them have
no local symptom at all — three of the six behave perfectly on the server that
caused them.

## Credentials that the SDK's own requests do not carry

**Presents as:** the server refusing its own client. A `tools/call` that the
caller is plainly entitled to make fails with an authorization error, and the
failing request is one nobody wrote. In application code every path looks
correct, which is why this is the most expensive mistake available here.

**Cause:** the credential was put in per-request `_meta`. Under this revision
every request is self-describing — protocol version, client info, capabilities
all ride in `_meta` — so per-request application credentials look like they
belong there too. They do not. An SDK issues protocol calls application code
never writes, and those carry the SDK's own `_meta` stamp but not yours.
Concretely, on the official Python SDK one `call_tool()` produces two
server-visible requests: the `tools/call`, and an internal `tools/list` from
`validate_tool_result()` checking the output schema. `call_tool()` accepts a
`meta=` argument and `list_tools()` has no such parameter, so the credential
cannot reach the second request.

**Do:** authenticate on the transport, at the SDK's token-verifier seam, so the
`Authorization` header covers every request the transport sends regardless of
who issued it. Refuse the tempting repair: exempting `tools/list` from
authentication to make the internal call succeed reopens precisely the hole the
design was closing, and it does so on the method that enumerates your tool
surface. Pin the property with a test that calls a tool and asserts the result
is not an error — that single assertion is what fails when a credential moves
back into `_meta`.

## `cacheScope: public` on a tenant-filtered listing

**Presents as:** nothing, on the server. One tenant reports seeing another
tenant's tools, and every server log shows correctly filtered responses,
because the leak happens in a cache the server never sees — the client's, a
gateway's, a CDN's.

**Cause:** a one-word setting on a response that was filtered per caller.
`public` tells every cache on the path that the response may be shared across
authorization contexts. This failure mode did not exist before `2026-07-28`
introduced the field, so no habit or lint rule was ever built around it.

**Do:** set `private` on every tenant-scoped result and assert it in a test,
not in review — it is a one-word change with no local symptom, which is exactly
the class of thing review misses. Two follow-ons. First, this value is
affirmative rather than accidental: `private` is the safe default in the SDK's
`CacheHint`, so a `public` in your code was typed, usually copied from an
example built around an *unfiltered* global listing where it was correct.
Second, a server-wide cache-hint map is a default, not an enforcement point —
the SDK fills the fields per field and only where the handler left them unset,
so a handler that sets the scope itself overrides your `private`. Check the
handlers, not only the constructor.

## Filtering the listing and calling it authorization

**Presents as:** nothing, until someone probes. Every client-driven path
respects the filter, so the server demos perfectly and passes every test
written by driving a normal host. It surfaces as a security-review finding or
an incident, never as a bug report.

**Cause:** dispatch takes a name. Filtering `tools/list` shapes what a caller
*discovers*; it constrains nothing about what a caller may *name*. A server
that filters the listing and hands `tools/call` straight to the registry has
built a UI convention and called it a boundary.

**Do:** authorize the invocation on its own branch, before the handler runs,
against the same grants the filter used. Two enforcement points, in two places
in the code, because they answer two questions. The decisive test is the one
that is easy to omit: as tenant B, call by name a tool that exists on the
server and was granted only to tenant A, and assert the call is refused. A
suite that only lists-then-calls can never fail this way.

## Refusals that confirm existence

**Presents as:** a tenant able to map every other tenant's capabilities one
call at a time. Usually found by a security review rather than by a test,
because the responses involved are all "errors" and nobody diffs errors.

**Cause:** "exists but forbidden" is distinguishable from "does not exist".
Sometimes that is the error text; more often it is the *shape*. Raising on an
ungranted call produces a JSON-RPC error, while an unknown tool produces a tool
result with an error flag — two different response types, distinguishable
however carefully the message is worded. Error text, shape, and status are all
part of the security surface, and this undoes the listing filter entirely.

**Do:** return the refusal, do not raise it: build the same result an unknown
tool produces, with the same fields and the same message template. Then assert
the indistinguishability rather than eyeballing it — call one forbidden tool
and one genuinely nonexistent tool as the same tenant, replace each tool's name
in its own response text with a common placeholder, and assert the two strings
are equal. That comparison fails the moment someone adds a helpful "you do not
have access to" prefix.

## Per-connection state under a stateless protocol

**Presents as:** intermittent, load-dependent wrongness. Correct on one replica
in development, wrong behind a load balancer: a request served as the wrong
tenant, a capability set that belongs to whoever connected first, a
multi-step interaction that fails only sometimes.

**Cause:** code carried over from the previous revision, which had an
`initialize` handshake and a session to hang state on. Caching an identity, a
capability set, or an in-progress operation "for the connection" is invisible
in a single-replica test and unfounded under `2026-07-28`, where nothing
guarantees the next request lands on the same replica.

**Do:** resolve identity from the in-flight request every time — read the
request-scoped access token, not any state the server object holds — and delete
the caches. Where a tool genuinely needs state across calls, mint an explicit
handle and pass it as an ordinary tool argument, so the state is visible in the
schema, expirable, and auditable instead of hidden in the transport. Prove the
absence rather than assuming it: drive alternating identities through one
server object back to back and assert each call sees its own, which is a test
that fails loudly the day someone adds a convenience cache.

## Tenant-scoped data in the discover response

**Presents as:** capability names readable by anyone who can reach the
endpoint, with no credential at all. It is not detected by any test that uses a
client, because a client always sends its token.

**Cause:** `server/discover` is served unauthenticated by design — requiring a
credential to discover how to authenticate is a bootstrapping deadlock — so
anything that grows into that response is published. The exemption was
justified once, when the response held capability flags and protocol versions,
and nobody re-checked it when the response gained a field.

**Do:** keep the unauthenticated method list explicit and enumerated rather than
inferred, so the boundary is a thing someone edits deliberately. Re-verify the
discover response's actual contents whenever it changes, and treat "contains no
tenant-scoped names" as a property of your server to test, not a guarantee of
the protocol. If tenant-specific advertisement is genuinely needed, it moves
behind the boundary; it does not get an exception.

**Source:** [Architecture: Enterprise MCP Platform](https://handbook.vinodspattar.in/architecture/systems/enterprise-mcp-platform/), [Lab: Multi-Tenant MCP Server](https://handbook.vinodspattar.in/build/labs/multi-tenant-mcp-server/), [Module 6: MCP](https://handbook.vinodspattar.in/learn/modules/06-mcp/), [MCP lookup](https://handbook.vinodspattar.in/reference/lookups/mcp/)
