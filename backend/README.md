# Backend configuration

Set these environment variables on the Render backend service:

- `SUPABASE_URL`
- `SUPABASE_KEY`
- `APP_AUTH_SECRET`: a long, random secret used to sign API session tokens.
- `APP_AUTH_TOKEN_TTL`: optional token lifetime in seconds; defaults to 2592000 (30 days).

The frontend stores vocabulary locally per exact username and language. Online API
requests require the bearer token returned by `/login`. Offline login verifies the
entered password against a PBKDF2 verifier stored locally; it does not grant API
access until the user signs in online again.

The sync endpoint performs conflict-safe upserts using the unique key
`("user", sprache, lexikon, wort)`. The migration in `migrations/` removes duplicate
snapshots while retaining the most recently updated row, then creates that index.