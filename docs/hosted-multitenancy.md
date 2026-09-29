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
- Google Drive authorization and the Drive store
- the Drive writer lease
- the Sendblue connection and webhook secret
- operator Routine preferences and the outbox
- the secret namespace (Sendblue, Google refresh token, Routine key)
- audit and exports

Railway remains the runtime. Google Drive remains canonical business storage
for each installation. Secrets stay out of Drive. A volume, if still used,
is partitioned by installation id.

Not in this design: billing, a landlord account system, an admin console, or
a second messaging provider. Marketplace publication waits until the
boundary above is implemented and tested, including a test that two
installations cannot read each other's records.
