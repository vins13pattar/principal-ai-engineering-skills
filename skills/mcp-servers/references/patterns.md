# Patterns

Five excerpts from `labs/multi-tenant-mcp-server`, each named with the file it
came from. All five were verified by binding them back over the lab's own
modules and running its suite over the real Streamable HTTP transport: 11/11
before and 11/11 after, on `mcp` 2.0.0 under Python 3.14.

One condition applies throughout: the lab's tenant registry is in-memory and
its bearer tokens are static. That is the part a production server replaces —
tokens minted by an authorization server, issuer validated per RFC 9207, CIMD
in place of Dynamic Client Registration. Only the verifier changes; everything
downstream works from the resolved tenant.

## The credential seam, where the SDK's own calls also pass

From `src/mcp_tenancy/auth.py`. Serves "put the tenant credential on the
transport" — the rule whose violation makes a server refuse its own client.

```python
REQUIRED_SCOPE = "mcp:use"


class TenantTokenVerifier:
    """Resolves a bearer token to a tenant identity."""

    def __init__(self, registry: TenantRegistry) -> None:
        self._registry = registry

    async def verify_token(self, token: str) -> AccessToken | None:
        tenant = self._registry.verify(token)
        if tenant is None:
            return None
        return AccessToken(
            token=token,
            client_id=tenant.tenant_id,
            scopes=[REQUIRED_SCOPE],
            subject=tenant.tenant_id,
        )


def current_tenant(registry: TenantRegistry) -> Tenant | None:
    """The tenant for the in-flight request, or None if unauthenticated."""
    token = get_access_token()
    if token is None or not token.subject:
        return None
    return registry.verify(token.token)
```

`verify_token` implements the SDK's `TokenVerifier` protocol, which the
transport calls before any handler. That placement is the whole point: the
credential arrives on the `Authorization` header, so it covers every request
the transport carries — including the internal `tools/list` that
`validate_tool_result()` issues inside a `call_tool()`, which no application
metadata reaches.

`current_tenant` reads the SDK's *request-scoped* access token. Under a
stateless protocol there is nothing else it could safely read, and the shape is
what stops per-connection identity from creeping back: there is no instance
attribute to cache a tenant on.

The scope here answers "may you talk to this server", not "may you call this
tool" — every token gets the same single scope, and per-tool authorization is a
separate decision made later from the tenant's grants.

Deliberately omitted: the imports (`get_access_token`, `AccessToken`, and the
`.tenancy` types); the module's docstrings, each cut to its first line; and the
three-line comment above `REQUIRED_SCOPE`, whose content is the paragraph
directly above. No comment in this excerpt is mine.

## Two enforcement points, in two places

From `src/mcp_tenancy/middleware.py`. Serves the rule this skill exists for: a
filtered listing is not authorization.

```python
TENANT_SCOPED_METHODS = frozenset(
    {
        "tools/list", "tools/call", "resources/list", "resources/read",
        "resources/templates/list", "prompts/list", "prompts/get",
        "completion/complete",
    }
)


def build_tenancy_middleware(registry: TenantRegistry) -> Any:
    async def tenancy_middleware(ctx: Any, call_next: Any) -> Any:
        if ctx.method not in TENANT_SCOPED_METHODS:
            return await call_next(ctx)

        tenant = current_tenant(registry)
        if tenant is None:
            # Unauthenticated here means no verifier was wired: fail closed
            # rather than serve unscoped data.
            raise PermissionError("no authenticated tenant for a tenant-scoped method")

        if ctx.method == "tools/call":                 # BEFORE the handler runs
            name = (ctx.params or {}).get("name")
            if isinstance(name, str) and not tenant.grants_tool(name):
                return _unknown_tool_result(name)

        result = await call_next(ctx)

        if ctx.method == "tools/list":                 # AFTER: discovery only
            return _filter_listing(result, "tools", "name", tenant.grants_tool)
        if ctx.method == "resources/list":
            return _filter_listing(result, "resources", "uri", tenant.grants_resource)
        return result

    return tenancy_middleware
```

The two checks sit on opposite sides of `call_next`, and that is the shape to
copy. The `tools/call` branch runs *before*, so an ungranted handler never
executes; the list branches run *after*, because they edit a result. A server
missing the first branch demos perfectly — every client-driven path respects
the filter — and is not a boundary.

`TENANT_SCOPED_METHODS` being an explicit frozenset rather than an inferred
rule is the second decision, and it is dangerous in both directions: too narrow
and a scoped method serves unscoped data, too wide and the server demands a
credential for `server/discover`, the call a client makes to learn how to
authenticate. Note how much longer the set is than the obvious four.

The `tenant is None` branch raises rather than falling through. The transport
already rejected unauthenticated requests, so reaching here means the server
was assembled without a verifier — a wiring bug whose safe answer is a refusal.

Deliberately omitted: imports; both docstrings; and the two module-level
comments, replaced by the three shorter inline comments shown. The frozenset
literal is reflowed onto fewer lines; its members are unchanged.

## The refusal, and filtering below serialization

From `src/mcp_tenancy/middleware.py`. Serves "make the refusal byte-identical
to the unknown-tool result" and "rebuild the outbound mapping".

```python
def _filter_listing(
    result: Any, collection: str, key: str, granted: Callable[[str], bool]
) -> Any:
    if not isinstance(result, dict):
        return result
    entries = result.get(collection)
    if not isinstance(entries, list):
        return result
    return {
        **result,  # carries cacheScope / ttlMs / resultType through untouched
        collection: [e for e in entries if isinstance(e, dict) and granted(str(e.get(key, "")))],
    }


def _unknown_tool_result(name: str) -> dict[str, Any]:
    return {
        "content": [{"text": f"Unknown tool: {name}", "type": "text"}],
        "isError": True,
        "resultType": "complete",
    }
```

`_unknown_tool_result` *returns* rather than raises, and that is the load-bearing
decision. A raised error becomes a JSON-RPC error — a different response shape
from a tool result, and therefore distinguishable on its own however carefully
the message is worded. Matching the text is not enough if the envelope differs.

`_filter_listing` shows what middleware actually receives. It runs below model
serialization, so `result` is the outbound dict — `{"tools": [...],
"cacheScope": ..., "resultType": ...}` — not a typed `ListToolsResult`. The
`**result` spread is why the protocol fields survive; a rewrite that returns
`{collection: filtered}` drops the cache hints, and losing `ttlMs` costs
performance while losing `cacheScope` is a leak.

Both guards return `result` unchanged when the shape is unexpected. On a
listing that fails those checks nothing is filtered — acceptable only because
the invocation check is a separate control.

Deliberately omitted: imports, and both docstrings. The `# carries cacheScope /
ttlMs / resultType through untouched` comment is mine — the lab makes that
point in `_filter_listing`'s dropped docstring, not inline.

## Cache hints, and where every control attaches

From `src/mcp_tenancy/server.py`. Serves "never write `cacheScope: public` on a
filtered response".

```python
TENANT_SCOPED_CACHE_HINTS: dict[CacheableMethod, CacheHint] = {
    "tools/list": CacheHint(ttl_ms=60_000, scope="private"),
    "resources/list": CacheHint(ttl_ms=60_000, scope="private"),
}


def build_server(registry: TenantRegistry, *, name: str = "multi-tenant-mcp-server",
                 issuer_url: str = "https://issuer.example.com",
                 resource_server_url: str = "https://mcp.example.com") -> MCPServer:
    server: MCPServer = MCPServer(
        name=name,
        version="0.1.0",
        instructions="A multi-tenant MCP server. Each request authenticates on its own.",
        token_verifier=TenantTokenVerifier(registry),   # before any handler
        auth=AuthSettings(
            issuer_url=issuer_url,  # type: ignore[arg-type]
            resource_server_url=resource_server_url,  # type: ignore[arg-type]
            required_scopes=[REQUIRED_SCOPE],
        ),
        middleware=[build_tenancy_middleware(registry)],
        cache_hints=TENANT_SCOPED_CACHE_HINTS,
    )
    return server
```

`scope="private"` with a positive `ttl_ms` is the correct pair: the responses
are genuinely cacheable, they are simply never shareable across callers.
Marking them `public` would tell every cache on the path that one tenant's
filtered list may be served to another, with no symptom on the server.

Two things this shape does not buy you, both read out of `mcp` 2.0.0's
`server/caching.py`. The map is a *default*: `apply_cache_hint` fills each
field only where the handler left it unset, so a handler that sets the scope
itself overrides this entry. And the map covers only the two methods listed,
where the SDK's `CacheableMethod` set also holds `prompts/list`,
`resources/templates/list`, `resources/read`, and `server/discover` — those
fall back to the `CacheHint` defaults of `ttl_ms=0` and `scope="private"`,
safe but immediately stale.

A factory, not a module-level singleton: a stateless server has no reason to be
one, and tests that share it share a registry.

Deliberately omitted: the docstring; the three `@server.tool()` demo handlers
plus the `_tenant_id()` helper registered between the constructor and the
`return`; and the ten-line comment above `TENANT_SCOPED_CACHE_HINTS` carrying
the SEP-2549 rationale, whose content is the first paragraph above. The
`# before any handler` comment is mine — the lab has none on that line. The
signature is reflowed onto fewer lines; parameters are unchanged.

## The two tests that would have caught the two silent failures

From `tests/test_tenant_isolation.py` and `tests/test_protocol_and_auth.py`,
composed into one block; each is verbatim from its own file.

```python
# tests/test_tenant_isolation.py
@pytest.mark.asyncio
async def test_calling_an_ungranted_tool_is_refused_even_though_it_exists(
    server: MCPServer,
) -> None:
    async with connect(server, GLOBEX_TOKEN) as globex:
        result = await globex.call_tool(
            "issue_refund", {"order_id": "42", "amount_cents": 500}
        )

    assert result.is_error


@pytest.mark.asyncio
async def test_a_refusal_does_not_reveal_that_the_tool_exists(server: MCPServer) -> None:
    async with connect(server, GLOBEX_TOKEN) as globex:
        forbidden = await globex.call_tool("issue_refund", {"order_id": "1", "amount_cents": 1})
        nonexistent = await globex.call_tool("no_such_tool", {})

    forbidden_text = str(forbidden.content[0].text)  # type: ignore[union-attr]
    nonexistent_text = str(nonexistent.content[0].text)  # type: ignore[union-attr]
    assert forbidden.is_error and nonexistent.is_error
    assert forbidden_text.replace("issue_refund", "X") == nonexistent_text.replace(
        "no_such_tool", "X"
    )


# tests/test_protocol_and_auth.py
def test_tenant_scoped_listings_are_never_advertised_as_shareable() -> None:
    for method, hint in TENANT_SCOPED_CACHE_HINTS.items():
        assert hint.scope == "private", f"{method} must not be advertised as shareable"
        assert hint.ttl_ms > 0, f"{method} should still be cacheable per-caller"
```

The first test is the decisive one, and it is the one a normal suite omits:
`issue_refund` is registered on the server and callable by `acme`, so filtering
the listing alone would not have stopped `globex`. A suite that only
lists-then-calls can never fail this way, because it never names a tool it did
not just receive.

The second turns "indistinguishable" into an assertion. Substituting each tool's
own name with a common placeholder and comparing the strings fails the moment
someone adds a helpful "you do not have access to" prefix — which is how this
regresses.

The third asserts a one-word setting with no local symptom. It is worth its
three lines precisely because there is nothing else that can catch it: the
server behaves correctly whichever value is set, and the consequence appears in
a cache nobody on the team operates.

Deliberately omitted: imports and the `server`/`connect` fixtures from
`conftest.py`; and, from the first two tests, the explanatory comments that
stand in the lab file — their content is in the commentary above instead.

**Source:** [Lab: Multi-Tenant MCP Server](https://handbook.vinodspattar.in/build/labs/multi-tenant-mcp-server/), [Architecture: Enterprise MCP Platform](https://handbook.vinodspattar.in/architecture/systems/enterprise-mcp-platform/), [`labs/multi-tenant-mcp-server`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/multi-tenant-mcp-server)
