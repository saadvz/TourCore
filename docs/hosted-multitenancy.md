# Future hosted multi-tenancy

`HOSTED_RAILWAY_P0` is one demo installation on one Railway service. It is
not the Marketplace product. A second operator client is refused. Do not
describe it as tenant isolation.

The installation id (`inst_...` in the manifest) is the tenant key. A future
hosted Tour Core should keep that id, not invent a second name for the same
boundary. Every request resolves one installation before it reads or writes
business state.

That boundary has to cover all of the following. Sharing any of them across
installations is a leak:

- MCP OAuth clients, grants, and approval sessions
- properties, prospects, tours, and exceptions
- Google Drive authorization is not shared. Each installation's backups stay in that user's Drive. Tour Core does not hold that user's Google token on the hosted path
- the Sendblue connection and webhook secret
- operator Routine preferences and the outbox
- the secret namespace (Sendblue, Google refresh token, Routine key)
- audit and exports

Railway remains the runtime. For this demo the volume holds one installation's
live operational state. A future hosted database replaces that volume as the
operational store per tenant. Grok's Google Drive connector remains the
user-owned backup and export layer. Secrets stay out of Drive and out of
backups.

Not in this design: billing, a landlord account system, an admin console, or
a second messaging provider. Marketplace publication waits until the
boundary above is implemented and tested, including a test that two
installations cannot read each other's records.

`HOSTED_RAILWAY_P0` binds the first Grok client a human approves as the owner
of this one demo. That first-approved-client rule is not the Marketplace
authentication model. A multi-tenant host should authenticate a user, resolve
that user's installation, and let that user approve Grok for that tenant.
Ordinary Marketplace users do not become owner by being first to connect.
