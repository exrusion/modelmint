# ModelMint

Next.js / TypeScript marketplace with an Express OpenAI-compatible gateway, PostgreSQL accounting and Redis enforcement. Payments use native ETH on Ethereum (chain 1) or Robinhood (chain 4663). There is no Stripe integration.

## Configuration

Copy `.env.example` to a private environment file for local work. On Railway, configure Variables directly. Never commit credentials.

- `DATABASE_URL`: PostgreSQL connection. Attach a persistent volume at `/var/lib/postgresql/data` to Postgres.
- `REDIS_URL`: password-protected Redis connection. Persist append-only data at `/data`.
- `APP_URL`: exact public HTTPS origin; used for OAuth and request-origin protection.
- `ENCRYPTION_KEY`: 32 random bytes encoded as base64. Preserve this across deploys; changing it without migrating provider credentials makes them unreadable.
- `ABUSE_HASH_SECRET`: stable random salt for abuse identifiers.
- `UPSTREAM_API_KEY`: RelayModels credential; imported into encrypted provider storage at startup.
- `UPSTREAM_BASE_URL`: defaults to `https://api.relaymodels.com/v1`.
- `X_CLIENT_ID`, `X_CLIENT_SECRET`: X OAuth 2 confidential application, PKCE flow. Callback: `APP_URL/api/auth/x/callback`. Scopes: `tweet.read users.read`.
- `ADMIN_X_IDS`: comma-separated numeric X account IDs for administrators.
- `PAYMENT_TREASURY_ADDRESS`: public ETH receiving address; the app never needs its private key.
- `ETHEREUM_RPC_URL`, `ROBINHOOD_RPC_URL`: server RPC endpoints on the exact requested mainnets.
- `RESEND_API_KEY`, `MAIL_FROM`: transactional email verification for the one-per-email signup reward.

Brand configuration is in `brand.json`. The public domain defaults to the current app origin; generated keys use the configured prefix.

## Run

```bash
npm ci
npm run build
npm start
```

The single Railway web service hosts frontend and backend together. PostgreSQL and Redis are separate services on the private network. `/health` is the process health check; `/api/status` reports database, Redis and provider configuration. The Dockerfile is the deployment entry point.

## Before opening purchases

1. Confirm durable Postgres and Redis volumes and backups.
2. Configure X, the receiving wallet, production RPCs, email and provider credentials.
3. Sign in with the configured administrator X account.
4. Test the provider; inspect its returned catalogue. Map each public model to an exact upstream model ID.
5. Set each model's input, cached, output and reasoning prices in **usage-credit dollars per million tokens**; verify ratio, capabilities and context/output limits before enabling.
6. Set physical inventory, actual supplier cost in microdollars per weighted token, and base tokens per usage-credit dollar. Initial physical inventory is zero. No balances or transactions are fabricated.
7. Configure promotion economics, eligibility and allowed low-cost models. Premium excluded families remain blocked for promotional usage.
8. Run real-provider compatibility checks and a user-approved payment before opening purchases.
9. Complete operator contact/jurisdiction policy details. The included policies are launch drafts.

The $5/$10, $10/$20, $25/$50 and $50/$100 packages are offered as usage credit. Effective discounts depend on verified model rates. Do not advertise a guaranteed discount for an unverified model.

## Accounting

Dollar amounts use integer microdollars. Decimal rate multiplication uses integer arithmetic and rounds upward. Base-token consumption is actual model tokens multiplied by the supplier ratio, rounded upward. Cached tokens are a subset of prompt tokens and reasoning tokens are a subset of completion tokens; neither is counted twice.

The gateway locks platform settings, then the user and key, and reserves dollar credit and weighted tokens in one PostgreSQL transaction. Daily capacity, user daily limits, key lifetime/daily/monthly spending caps and physical inventory are checked inside that transaction. Redis rate and concurrency guards are atomic; the durable PostgreSQL reservation remains authoritative across crashes. Promotions are spent before purchased balances, only on allowed models.

Successful usage reconciles exactly once. Requests with ambiguous provider completion or missing usage retain their reservation in `review`. They are never automatically refunded as free usage. A verified-usage admin reconciliation releases the unused reservation. A provider reporting usage above the reserved bound triggers the circuit breaker.

Pending invoices retain their inventory commitment until settled or manually investigated. An expired quote is not proof that no transaction was sent. Late or mismatched transfers require manual treasury review; they do not automatically credit an account. Blockchain refunds require a separately signed treasury transaction.

## Compatibility

- `GET /v1/models`
- `POST /v1/chat/completions`: streaming and non-streaming, tool/JSON/vision payloads when enabled per model.
- `POST /v1/messages`: explicit 501 until a native Anthropic adapter is implemented and verified.
- Fallback retries only explicit upstream rejection statuses before streaming, within the same public model mapping. Ambiguous transport failures do not trigger duplicate upstream requests.
- No prompt/response database columns. Request bodies are not logged.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
```

`test:integration` needs PostgreSQL and optionally Redis. It creates a uniquely named schema, uses isolated fixtures and drops only that schema after completion. It checks concurrent reservations, reconciliation, promotion priority, revocation, global limits, idempotent backed credits, Redis rate/concurrency limits, and local fixture-provider gateway streams/tool passthrough. Fixture-provider tests do not verify RelayModels or any real model.

Live X login, real upstream usage/capabilities, real wallet receipt verification, provider fallback against actual suppliers and mobile browser interactions remain release gates until exercised with configured credentials. Do not represent an unconfigured preview as a fully operating marketplace.

## Sources used

- Orbio visual reference: https://www.orbio.so/
- Robinhood network configuration: https://docs.robinhood.com/chain/connecting/
- X PKCE flow: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- Coinbase spot price API: https://docs.cdp.coinbase.com/coinbase-app/track-apis/prices
- Railway volume requirements: https://docs.railway.com/volumes/reference

## Current deployment delivery

The initial Railway preview uses the official `node:22-bookworm-slim` image and a SHA-256 checked source archive split across `MINT_SOURCE_*` variables because GitHub browser controls timed out. The start command reconstructs the source, runs the isolated integration suite and builds the app. Move to the included Dockerfile and GitHub autodeploy after repository creation. The source archive contains no application credentials.

### Verified on Railway

Deployment `ef992eff-8fab-4e76-a33d-c93505785de7` reached SUCCESS. Its logs confirm all isolated integration checks passed against the deployed PostgreSQL and Redis services, followed by a successful Next.js production build. This does not verify external credentials or real model responses.

### Reference UI update

The landing page now has a compact credit calculator, bold lime-highlighted headline, announcement bar, three trust cards, and original marble framing. Build and TypeScript checks passed. Deployment `213a7dba-13de-41b5-a14b-98616c15698c` reached SUCCESS; its provider check authenticated with RelayModels and discovered 78 model IDs. Model inference and pricing have not been verified. X setup remains pending because cloud browser controls timed out. Source repository: https://github.com/exrusion/modelmint.

### Artwork

Asset: `public/marble-column.webp`, generated using the built-in image generator and optimized for web delivery.

Prompt: Use case: stylized-concept. Asset for the outer edge of an AI credits website. Create one very tall slim classical ivory marble pilaster, front elevation, complete column from ornate ionic scroll capital at top through long fluted shaft to a small square plinth bottom. Elegant weathered white marble with subtle charcoal veining, carved scrolls and very thin vivid fluorescent chartreuse lime green metal rings just below capital and above plinth. Sophisticated photorealistic 3D architectural render, diffuse daylight, gentle soft shadows. Isolated on a flat pure warm white #f7f7f2 backdrop. Portrait composition approximately 1:5 ratio; column centered, almost full height with very little empty margin. No text, no logos, no extra objects, no scene, no perspective tilt. This is an original decorative architectural website asset.
