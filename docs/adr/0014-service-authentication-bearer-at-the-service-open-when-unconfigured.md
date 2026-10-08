# 0014 · Service authentication: bearer credentials at the service, open when unconfigured

**Status:** accepted
**Date:** 2026-10-08

## Context

Until P5-A nothing checked who was calling. `POST /runs` answered any caller, and
`app.enableCors()` with no options sent `Access-Control-Allow-Origin: *` to any origin. The
gateway mounted JSON parsing, a correlation id and the proxy and nothing else, and it was
not the only door: compose publishes the service's own port on the host. P4-A recorded this
as CTL-ACC-01 and left it `planned` under P5-A.

P5-A adds a second agent-facing surface, A2A, whose Agent Card declares the security a
caller must present, and since P3-D and P3-E the service also takes prior-authorization
requests and clinicians' determinations. Four questions had to be answered together: what
credential, where it is checked, what happens when none is configured, and what a caller is
allowed to see once it is through.

## Decision

**A bearer token, checked at the service, on every route but discovery and health, and
open — loudly — when no credential is configured.**

- **The credential is an opaque bearer token (RFC 6750).** `SERVICE_CREDENTIALS` lists
  `principal:sha256hex` pairs, so the service holds digests and never a token. A presented
  token is hashed and compared with every digest in constant time, with no early exit. The
  card declares an HTTP `Bearer` scheme and a requirement naming the role `agent.invoke`.
  Replacing the opaque token with a JWT later changes neither the header nor the scheme.
- **It is checked at the service, not the gateway.** A check at the gateway alone would
  leave the resource it protects reachable on the service's published port. The gateway and
  the console forward a credential; they do not decide anything.
- **The rule is deny by default.** Every request needs a token except `GET /health`,
  `GET /.well-known/agent-card.json` and `GET /.well-known/jwks.json`: a caller has to be
  able to read the card to learn that it needs a credential. `/runs`, `/a2a`, `/fhir` and
  `/review` are covered without being named, and so is any route added later.
- **The mode follows the repository's axis rule.** Unset runs open: every caller is the
  principal `anonymous`, boot logs `auth.open` at `warn`, and the card declares no security,
  so it tells the truth about the endpoint. Malformed exits 1 naming the variable. Set
  requires a token on every covered route. The compose stack runs authenticated.
- **Ownership is per principal on the A2A surface.** A task belongs to the principal that
  created it, through the SDK's owner-scoped task store, and a context's session id is
  derived from principal and context, so two principals using one context id have two
  conversations.

Encryption in transit is not part of this decision. Nothing here is deployed, and TLS
terminates at the deploying organization's ingress; A2A §7.1 makes HTTPS a MUST in
production, and CTL-ACC-03 records it as `not-applicable` on that ground (ADR 0003).

## Alternatives rejected

- **Refuse to boot without credentials.** It is the safer default in isolation. It makes the
  no-`.env` quickstart, which P0-A made a requirement, the one configuration in the
  repository where an unconfigured axis does not run. Decided at P5-A's review: open mode
  stays, with the `warn` line and the authenticated compose stack as what a reader sees.
- **A built-in default token.** A default credential (CWE-1392) is worse than an explicit
  open mode: it looks authenticated and is not.
- **Authentication at the gateway.** See above; the service's port is published.
- **OAuth 2.0 client credentials, OpenID Connect or mTLS.** A local demo cannot exercise any
  of them without adding an authorization server or a CA. Bearer keeps the header and the
  card's scheme stable if one of them replaces the opaque token.

## Consequences

**What it buys.** CTL-ACC-01 and CTL-ACC-02 are implemented, with service-tier tests on
every covered route and on cross-principal access, and the compose stack exercises the real
path: the console's nginx adds its token, the gateway forwards it, and the A2A conformance
kit runs through a proxy that adds one.

**What remains, stated as residuals.**

- **`POST /runs` is not scoped per session.** Its contract lets the client name its
  `sessionId`, so an authenticated caller can still name any session. Scoping it would change
  the ids the evaluation harness and the inspector read. The A2A surface derives its session
  ids instead, and no PRD owns changing `/runs`.
- **The console has no user login.** Its nginx holds a service credential, and anyone who
  reaches its port uses it. No PRD owns this.
- **Open mode collapses every caller into one principal.** Task ownership and session
  scoping are then one namespace. The card, which declares no security, is what tells a
  caller so.
- **One process.** The task store and the per-session lock that keeps two messages in one
  context from racing on a turn index live in memory. Two replicas would need a design.

**Revisit when** the service is deployed anywhere a caller other than its own console and
the conformance kit can reach, or when a second organization's agent calls it: that is
where token issuance, rotation and per-session authorization on `/runs` stop being
residuals.
