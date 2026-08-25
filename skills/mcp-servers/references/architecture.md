# Multi-tenant MCP platform architecture

## The problem the design exists to solve

One MCP server per team per integration stops scaling the moment more than one
team wants servers: every server is a separate deployment, a separate
credential, a separate thing to patch. The obvious consolidation — one server,
many tenants — does not remove the problem so much as relocate it, from
operations into code, where a single missing check exposes one customer's tools
to another.

The `2026-07-28` protocol revision reshapes that problem twice. **Removing the
session** means identity can no longer be established once per connection; it
has to be re-established per request. **Adding `cacheScope`** means a listing
response is now something infrastructure may legitimately store and replay,
which creates a leak class that did not previously exist.

Material written for `2025-11-25` assumes an `initialize` handshake and a
session this revision removed. That assumption changes both the identity model
and the deployment topology, so a design copied from it is wrong in a way that
looks like working code.

## Requirements worth writing down

- **Per-request identity.** Every request authenticates on its own; nothing is
  trusted because an earlier request on the same connection was trusted.
- **Discovery isolation.** A tenant's `tools/list` and `resources/list` return
  only what that tenant was granted.
- **Invocation authorization.** A tenant cannot call what it was not granted,
  whether or not it ever appeared in a listing.
- **Non-disclosure on refusal.** A refusal must not reveal that the refused
  capability exists.
- **Cache safety.** No response is ever advertised as shareable across tenants.
- **Horizontal scale without affinity.** Any replica serves any request.
- **Auditability.** Every call and every refusal is attributable to a tenant.

## Constraints that decide the design

- **Credentials must live where the SDK's own calls carry them.** An SDK issues
  protocol requests application code never writes — validation, revalidation,
  retries. Any credential scoped to application-issued requests has gaps
  invisible from your own call sites. In practice: the transport's
  `Authorization` header, not per-request `_meta`.
- **`server/discover` cannot require authentication.** A client needs it to
  learn how to talk to the server, so gating it deadlocks bootstrapping.
  Everything in that response is therefore public by construction.
- **Filtering happens below model serialization.** Middleware sees outbound
  mappings, not typed result models, so isolation logic manipulates the wire
  representation and has to preserve the protocol fields sitting beside the
  collection it is filtering.
- **Dynamic Client Registration is deprecated.** New integrations use Client ID
  Metadata Documents, and issuers are validated per RFC 9207.
- **The listing is a cacheable artifact now.** `ttlMs` and `cacheScope` are
  required on complete results from the list methods, `resources/read`,
  `resources/templates/list`, and `server/discover` — so the caching posture is
  a decision the server states, not one it can decline to have.

## Request flow

As transitions rather than a diagram:

1. **A host sends a request to any replica**, carrying a bearer credential on
   the `Authorization` header. The load balancer needs no session affinity,
   because there is no session.
2. **A token verifier resolves the credential to a tenant before dispatch.** An
   absent or invalid credential is rejected at the transport with `401` and
   `invalid_token` — before any handler runs, which is what makes the check
   cover the SDK's own internal calls as well as the application's.
3. **Tenancy middleware asks whether the method is tenant-scoped.** Methods
   that describe the *server* rather than any tenant — `server/discover` — pass
   straight through and are served unauthenticated: capability flags and
   supported protocol versions, no tenant data.
4. **A tenant-scoped method with no resolved identity fails closed.** Reaching
   this point unauthenticated means the server was wired without a verifier,
   and the safe answer is to raise rather than serve unscoped data.
5. **`tools/list` and `resources/list` run, then are filtered** down to the
   entries this tenant was granted, with `cacheScope: private` on the result.
6. **`tools/call` is authorized before the handler runs**, against those same
   grants, on the name in the request's params.
7. **An ungranted call returns a refusal identical to a genuinely unknown
   tool** — same shape, same status, same text modulo the name.
8. **A granted call runs the handler as this tenant**, with the tenant read
   from the request-scoped token rather than from anything the server holds.
9. **The SDK's own internal calls traverse steps 1–5 identically**, because
   they carry the same header the application's request did.

**Steps 5 and 6 are two enforcement points, not one.** That separation is the
architecture: step 5 decides what the model learns about, step 6 decides what
runs, and a server with only step 5 has published a UI convention. Step 3 is
the second load-bearing property, and it is dangerous in both directions —
inferring the boundary instead of enumerating it either serves unscoped data
or demands a credential for the bootstrap call.

## Scaling

- **Statelessness is what makes the fleet ordinary.** No session store, no
  affinity, no drain-on-deploy for session migration. This is the largest
  operational consequence of the revision, and it accrues to platform teams
  rather than to tool authors.
- **`Mcp-Method` enables policy at the edge.** Because the operation is visible
  without parsing the body, a gateway can rate limit `tools/call` differently
  from `tools/list`, route expensive operations to dedicated capacity, or shed
  load by operation class.
- **Cache keys must include the tenant.** `cacheScope: private` prevents
  *shared* caches from cross-serving; it says nothing to a single client acting
  for several tenants, whose own cache keys on the method. Multi-tenant hosts
  need per-tenant cache partitions.
- **Discovery dominates the request mix.** Hosts list far more often than they
  call. A correct `ttlMs` turns most of that traffic into cache hits, and
  ignoring the field forfeits the revision's main performance win.
- **Tool count per tenant is a context cost, not just a server cost.** Every
  listed tool typically enters the model's context, so large grants degrade the
  caller's quality and spend before they strain the server.

## Security

- **Verify tokens against an authorization server**, validating the issuer per
  RFC 9207 and binding the credential to that issuer. Static tokens are a lab
  convenience, not a deployment.
- **Use Client ID Metadata Documents** rather than Dynamic Client Registration,
  which this revision deprecated.
- **Authorize invocation independently of discovery**, since the two answer
  different questions.
- **Make refusals indistinguishable** from "does not exist" — status code,
  shape, and text.
- **Set `cacheScope: private` on every tenant-scoped response**, and assert it
  in a test rather than leaving it to review.
- **Treat tool descriptions from any tenant-supplied source as untrusted**,
  since they enter the model's context. Tool poisoning arrives through
  self-reported metadata, past every filter aimed at the user's message, and it
  applies within a platform as much as across one.
- **Sign, bound, and expire `requestState`.** In a Multi-Round-Trip Request it
  is client-held state that resumes server-side execution; the official SDK
  binds it to the authenticated principal, and a platform should not do less.
- **Audit refusals as carefully as successes.** Refusals are the
  security-interesting half, and the only durable evidence of attempted
  cross-tenant access.

## Cost

- **Token verification runs per request**, so its cost scales with call volume
  rather than connection count. Cache verification results by token with a
  short TTL, bounded by the token's own expiry.
- **A correct `ttlMs` is a direct saving**, because discovery dominates the
  request mix and each cache hit is a request the fleet does not serve.
- **Per-tenant grant size drives model spend**, since listed tools enter the
  caller's context on every turn. Over-granting is a bill, not just a risk.
- **Audit retention is the quiet cost.** Every call and refusal per tenant,
  retained long enough to be useful in an investigation, is usually the largest
  storage line in the platform.

## Observability

- **Every log line and span carries a tenant identifier**, or nothing here is
  answerable.
- **Refusal rate per tenant, per tool.** A rise is either a misconfigured grant
  or an enumeration attempt, and distinguishing them requires the per-tool
  breakdown.
- **`401` rate split by cause** — absent credential versus invalid one. Absent
  usually means a broken client; invalid usually means expiry or rotation.
- **Cache hit ratio on `tools/list`.** A low ratio means clients are ignoring
  `ttlMs`, and the fleet is serving traffic it should not see.
- **Latency by `Mcp-Method`.** Aggregate latency blends cheap listings with
  expensive calls into a number that describes neither.
- **Protocol version distribution across callers**, which is what tells you
  when legacy-era clients have actually stopped connecting.

## Trade-offs

**Shared multi-tenant server vs. one deployment per tenant.** A shared server
amortizes operations, patching, and capacity, and makes a new tenant a
configuration change rather than a deployment. The cost is that isolation
becomes a property of code rather than of infrastructure — a missing check is a
cross-tenant breach, where separate deployments would have contained it.
Per-tenant deployment buys that isolation with operational cost growing
linearly in tenants.

**Per-request authentication vs. per-session authentication.** Per-request
costs a verification on every call and buys a fleet with no affinity
requirement, no session store, and no partially-authenticated state to reason
about. Per-session amortizes the verification and reintroduces exactly the
stickiness the revision removed. Token verification is cheap enough that this
trade is rarely close for a network-exposed server.

**Filtering listings server-side vs. returning everything and filtering at the
host.** Server-side filtering is the only option that is actually secure, since
the host is not a trust boundary. Returning everything is simpler and lets one
cached response serve all tenants — which is precisely why it is wrong, and
precisely the shortcut `cacheScope: public` makes available.

**Granting tools per tenant vs. per tenant-and-role.** Tenant-level grants are
simple to model and audit. Role-level grants within a tenant match how
organizations actually delegate, at the cost of a second dimension in every
check, every cache key, and every audit query. Adding the dimension later is
expensive because cache keys and audit history both encode the old shape.

**Source:** [Architecture: Enterprise MCP Platform](https://handbook.vinodspattar.in/architecture/systems/enterprise-mcp-platform/), [Lab: Multi-Tenant MCP Server](https://handbook.vinodspattar.in/build/labs/multi-tenant-mcp-server/) (the request-path diagram, which supplied the request flow), [Module 6: MCP](https://handbook.vinodspattar.in/learn/modules/06-mcp/), [MCP lookup](https://handbook.vinodspattar.in/reference/lookups/mcp/)
