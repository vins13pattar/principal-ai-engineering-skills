# Review checklist

Ordered by what the failure costs, not by where it appears in the file. The
first four are cross-tenant exposure and every one of them passes a normal
review, because three have no local symptom and the fourth demos perfectly.
Stop and comment at the first failing answer in that section. The middle group
is ranked by blast radius; the last two sections are always worth asking.

## The four that find the most

1. **Where does the caller's credential arrive?** *Failing answer:* read out of
   per-request `_meta` in a handler or a decorator. The SDK issues protocol
   requests the application never writes, and they carry no application
   metadata — one `call_tool()` produces an internal `tools/list` from
   `validate_tool_result()` that cannot carry a `meta=` argument, so the server
   refuses its own client. Look for a verifier wired at the transport seam.
   Then look for the second half of the bug: any exemption of `tools/list` from
   authentication, added to make the internal call succeed, has reopened the
   hole on the method that enumerates the tool surface.

2. **Is `tools/call` authorized on its own branch, before the handler runs?**
   *Failing answer:* middleware that only rewrites the `tools/list` result.
   Dispatch takes a name, so a tool absent from a listing is still callable by
   name, and every client-driven path respects the filter — which is why this
   passes demos and tests alike. The check must read the requested name from
   the params and test it against the same grants the filter used. Ask for the
   test that calls, by name, an existing tool the caller was not granted; if it
   does not exist, the boundary has never been exercised.

3. **Is the refusal returned, or raised?** *Failing answer:* `raise` on an
   ungranted call. That produces a JSON-RPC error where an unknown tool
   produces a tool result — two different response shapes, distinguishable
   however carefully the text is worded, and the listing filter is undone one
   probe at a time. Then check the text: it must match the unknown-tool
   template exactly, and the assertion should substitute both names with a
   placeholder and compare, not eyeball.

4. **What `cacheScope` do the filtered listings carry, and is it asserted?**
   *Failing answer:* `public`, or nothing asserted anywhere. `public` tells
   every cache on the path that one tenant's filtered list may be served to
   another, and the server behaves correctly throughout because the leak lives
   in infrastructure it never sees. Check both places: a server-wide cache-hint
   map is a *default* that a handler setting the field itself overrides. And
   confirm `ttlMs` is positive — the responses are cacheable per caller, just
   never shareable.

## Then, in blast-radius order

5. **Is the tenant-scoped method set enumerated, and does it fail closed?**
   *Failing answer:* the boundary inferred from a naming convention, or a
   fall-through that serves the unfiltered result when no tenant resolves. The
   set is longer than the obvious four — `resources/read`,
   `resources/templates/list`, `prompts/list`, `prompts/get`, and
   `completion/complete` all read tenant-owned data. Wrong in the other
   direction is just as bad: a server that scopes `server/discover` demands a
   credential for the call a client makes to learn how to authenticate.

6. **Has anyone actually read the `server/discover` response lately?** *Failing
   answer:* "it's unauthenticated because the spec says so". The exemption is a
   bootstrapping necessity and is safe only while the response holds capability
   flags and protocol versions — no tool or resource names. It is a property of
   this server, re-checked whenever the response grows, not a guarantee.

7. **Is anything cached per connection?** *Failing answer:* an identity, a
   capability set, or an in-progress operation held on the server object or
   keyed by connection. There is no session under this revision and nothing
   routes the next request to the same replica, so the symptom is intermittent
   and load-dependent — right in development, wrong behind a load balancer.
   Look for a test that drives alternating identities through one server object
   back to back.

8. **Does the listing filter preserve the protocol fields?** *Failing answer:*
   returning `{"tools": filtered}`. Middleware runs below model serialization,
   so the entries sit beside `cacheScope`, `ttlMs`, and `resultType` in the
   outbound mapping; rebuilding it from scratch drops them, and losing
   `cacheScope` converts a filtering bug into a caching leak.

9. **What secures `requestState`?** *Failing answer:* an opaque string that is
   neither signed, expired, nor size-bounded. It is client-held state that
   resumes server-side execution — the unsigned-cookie mistake. Bind it to the
   authenticated principal, as the official SDK does.

10. **Is every `tools/call` handler safe to re-run?** *Failing answer:* a
    non-idempotent side effect with no dedup key of its own. Stream
    resumability was removed, so a broken response stream loses the request and
    the client re-issues it with a new id — the id cannot be the key.

11. **Does anything treat the gateway's routing decision as authorization?**
    *Failing answer:* an edge policy keyed on `Mcp-Method`/`Mcp-Name` with no
    corresponding check at the server. Those headers are client-supplied: they
    make routing cheap, not trustworthy. On the official SDK the transport
    already rejects header/body disagreement with `400` and `HeaderMismatch`;
    on anything hand-rolled, that check is missing until someone writes it.

12. **Where do tool descriptions come from?** *Failing answer:* a
    tenant-supplied or third-party string rendered straight into a listing.
    Descriptions enter the model's context, so a hostile source is a
    prompt-injection vector arriving through metadata rather than through the
    user's message.

## Cost — last but always

13. **How large is a tenant's grant, and who decided?** *Failing answer:*
    everything granted to everyone because narrowing was work. Every listed
    tool typically enters the caller's context on every turn, so grant size is
    a model bill and a quality cost before it is ever a server load question.

14. **Is token verification cached?** *Failing answer:* a full verification per
    request against a remote authorization server. It scales with call volume
    rather than connection count now — cache by token with a short TTL bounded
    by the token's own expiry. And is `ttlMs` set to something real? Discovery
    dominates the request mix, so each cache hit is a request the fleet does
    not serve.

## Observability — last but always

15. **Is there a tenant identifier on every log line and span?** *Failing
    answer:* no. Nothing else in this list is answerable after an incident
    without it, and it cannot be backfilled.

16. **Is refusal rate broken down per tenant and per tool?** *Failing answer:*
    an aggregate error rate. A rise is either a misconfigured grant or an
    enumeration attempt, and only the per-tool breakdown separates them.
    Refusals are the security-interesting half of the audit trail, and the only
    durable evidence of attempted cross-tenant access.

17. **Is the `401` rate split by cause?** *Failing answer:* one counter. Absent
    credential usually means a broken client; invalid usually means expiry or
    rotation, and those page different people.

18. **Is latency reported by `Mcp-Method`, and is the `tools/list` cache hit
    ratio tracked?** *Failing answer:* one aggregate latency number, which
    blends cheap listings with expensive calls and describes neither — and no
    hit ratio, so nobody notices clients ignoring `ttlMs` and the fleet serving
    traffic it should not see.

**Source:** [Architecture: Enterprise MCP Platform](https://handbook.vinodspattar.in/architecture/systems/enterprise-mcp-platform/), [Module 6: MCP](https://handbook.vinodspattar.in/learn/modules/06-mcp/), [MCP lookup](https://handbook.vinodspattar.in/reference/lookups/mcp/), [Lab: Multi-Tenant MCP Server](https://handbook.vinodspattar.in/build/labs/multi-tenant-mcp-server/)
