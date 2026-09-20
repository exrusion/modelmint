# Routers

Next.js / TypeScript marketplace with an Express OpenAI-compatible gateway, PostgreSQL accounting and Redis enforcement. Payments use native SOL on Solana mainnet, or ETH on Ethereum (chain 1) and Robinhood (chain 4663). There is no Stripe integration.

One Routers API key and the `https://routers.markets/v1` base URL work across every enabled model allowed for that key. OpenAI-compatible refers to the request format; customers select GPT, Claude, Gemini, Grok, DeepSeek, Qwen and other available families by changing the `model` ID.

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
- `SOLANA_RPC_URL`, `SOLANA_TREASURY_ADDRESS`: Solana mainnet server RPC and public SOL receiving address. The app never needs a wallet private key.

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
7. Run real-provider compatibility checks and a user-approved payment before opening purchases.
8. Complete operator contact and jurisdiction policy details.

The $5/$10, $10/$20, $25/$50 and $50/$100 packages are offered as usage credit. Effective discounts depend on verified model rates. Do not advertise a guaranteed discount for an unverified model.

## Accounting

Dollar amounts use integer microdollars. Decimal rate multiplication uses integer arithmetic and rounds upward. Base-token consumption is actual model tokens multiplied by the supplier ratio, rounded upward. Cached tokens are a subset of prompt tokens and reasoning tokens are a subset of completion tokens; neither is counted twice.

The gateway locks platform settings, then the user and key, and reserves dollar credit and weighted tokens in one PostgreSQL transaction. Daily capacity, user daily limits, key lifetime/daily/monthly spending caps and physical inventory are checked inside that transaction. Redis rate and concurrency guards are atomic; the durable PostgreSQL reservation remains authoritative across crashes. Promotions are spent before purchased balances, only on allowed models.

Successful usage reconciles exactly once. Requests with ambiguous provider completion or missing usage retain their reservation in `review`. They are never automatically refunded as free usage. A verified-usage admin reconciliation releases the unused reservation. A provider reporting usage above the reserved bound triggers the circuit breaker.

Pending invoices retain their inventory commitment until settled or manually investigated. An expired quote is not proof that no transaction was sent. Late or mismatched transfers require manual treasury review; they do not automatically credit an account. Blockchain refunds require a separately signed treasury transaction.

## Gift API credit

Authenticated users can transfer purchased API credit from the Gift Credit workspace to an existing X account, a verified-email account, or a cryptographically random claim link. The selected base-token allowance and its matching purchased microdollar balance always move together in one PostgreSQL transaction. Promotional signup credit and holder rewards never enter the gift flow.

Existing recipients are credited immediately. Otherwise, the sender's balances are debited into a pending gift liability. Claim tokens are returned once and stored only as SHA-256 hashes. A row lock makes every claim single-use under concurrency. Senders can cancel pending gifts; unclaimed gifts expire after the configured period and restore both balances atomically. Pending gifts remain included in platform inventory and liability checks.

Email delivery uses the existing optional Resend configuration. The raw recipient email is used for lookup and delivery but is not stored on a pending gift; only a masked label is retained. If delivery is unavailable, the sender can copy the claim link directly. Claim links are bearer capabilities and should be shared privately.

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

`test:integration` needs PostgreSQL and optionally Redis. It creates a uniquely named schema, uses isolated fixtures and drops only that schema after completion. It checks concurrent reservations, reconciliation, promotion priority, revocation, global limits, idempotent backed credits, atomic single-use gift claims, gift cancellation and expiry refunds, Redis rate/concurrency limits, and local fixture-provider gateway streams/tool passthrough. Fixture-provider tests do not verify RelayModels or any real model.

Live X login, real upstream usage/capabilities, real wallet receipt verification, provider fallback against actual suppliers and mobile browser interactions remain release gates until exercised with configured credentials. Do not represent an unconfigured preview as a fully operating marketplace.

## Sources used

- Orbio visual reference: https://www.orbio.so/
- Robinhood network configuration: https://docs.robinhood.com/chain/connecting/
- X PKCE flow: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- Coinbase spot price API: https://docs.cdp.coinbase.com/coinbase-app/track-apis/prices
- Railway volume requirements: https://docs.railway.com/volumes/reference

## Current deployment delivery

GitHub `exrusion/modelmint`, branch `main`, now drives Railway deployments through the included Dockerfile. The web service runs `npm start`; its pre-deploy command is `node server/predeploy.mjs`. The old `MINT_SOURCE_*` variables are no longer used.

The pre-deploy runner executes isolated database/Redis integration checks, provider authentication, and bounded synthetic live-provider checks. Live checks are recorded once per diagnostic version in the audit table; only usage and verification metadata are retained. They never enable models, mint balances, or change physical inventory.

### $ROUTERS holder rewards

The holder-reward page verifies the token at `0xf1498261e22d5232361f5188b5238e495abdaecf` on Robinhood Chain (chain ID 4663). The default tiers are a continuous 12-hour hold of 2,000,000 tokens for 500,000 promotional API base tokens, or 10,000,000 tokens for 5,000,000 promotional API base tokens. These values, the claim switch and reward expiry are operator-configurable in platform settings.

Claims require X authentication plus an EIP-191 wallet signature over a five-minute, account-bound nonce. The signature is not a transaction or token approval. The server reads the current balance at a near-finalized block and reconstructs the most recent threshold crossing from the verified ERC-20 Transfer log, so a transfer below a tier resets that tier's clock. Database uniqueness enforces one claim per X account and one claim per wallet. A holder wallet is stored separately and never replaces the user's payment wallet.

Rewards are promotional service credit, not transferable assets or cash. They expire after the configured period, can be spent only on promotional models, and are issued only when uncommitted inventory can back the grant. Never enable claims without a healthy archival-capable `ROBINHOOD_RPC_URL`, sufficient inventory and verified promotional models.

### Verified on Railway

Deployment `41b26eb8-4bf3-4137-a4a5-9426574bffc6` passed the production build, health check, and all isolated integration checks, including SSE CRLF delimiters split between network chunks. Provider authentication discovered 78 model IDs. Claude Haiku returned a real response and usage; GPT-5.4 Mini returned HTTP 503 on all four attempted capabilities. Deployment `361957b9-fd7c-46d3-99fa-6f3a6f0d989f` then passed real GPT-5.6 Sol non-streaming, streaming, forced tool calling, JSON output, usage reporting, and a second Claude Haiku request. These checks do not establish availability or pricing of other catalogue models. Customer gateway accounting was verified separately using isolated fixtures; the live customer purchase, API-key and model-request flow has since been verified with a paid Solana checkout.

X OAuth2 setup was saved with user confirmation, read-only permissions and the production callback URL. Credentials are server environment variables. Wallet checkout still requires a public treasury address and production RPC configuration. Physical inventory and model prices must reflect verified supplier/account data before purchases are opened.

### Reference UI update

The landing page has a compact credit calculator, bold lime-highlighted headline, announcement bar, three trust cards, and original marble framing. Desktop browser review and calculator interaction passed. Mobile browser interaction remains unverified.

### Solana payments

Solana wallets sign a single-use ownership challenge. Each server-generated transaction transfers the quoted lamports and includes the invoice ID as a memo. Credit issuance requires a successful finalized mainnet transaction with the exact signer, recipient, amount and invoice memo, within the quote window. Signatures retain case and the database enforces one claim per network/signature. Unit fixtures verify failures and signature binding; a real wallet purchase remains untested until the receiving address and inventory are configured. Phantom-compatible browser providers are supported; mobile users can use the wallet’s in-app browser.

Checkout supports two coexisting methods. Connected-wallet checkout keeps the signed ownership challenge and memo-bound transaction flow. Direct-address checkout does not connect a wallet: it assigns the invoice a unique exact native-token amount, displays the treasury address and amount, and watches finalized Solana, Ethereum and Robinhood blocks for a matching transfer. Exact recipient, amount, invoice window, canonical finality and one-time ledger settlement are still enforced. Users must send the exact displayed amount before the quote expires.

Sources: https://solana.com/docs/rpc/http/gettransaction and https://docs.phantom.com/solana/sending-a-transaction

### Artwork

Asset: `public/marble-column.webp`, generated using the built-in image generator and optimized for web delivery.

Prompt: Use case: stylized-concept. Asset for the outer edge of an AI credits website. Create one very tall slim classical ivory marble pilaster, front elevation, complete column from ornate ionic scroll capital at top through long fluted shaft to a small square plinth bottom. Elegant weathered white marble with subtle charcoal veining, carved scrolls and very thin vivid fluorescent chartreuse lime green metal rings just below capital and above plinth. Sophisticated photorealistic 3D architectural render, diffuse daylight, gentle soft shadows. Isolated on a flat pure warm white #f7f7f2 backdrop. Portrait composition approximately 1:5 ratio; column centered, almost full height with very little empty margin. No text, no logos, no extra objects, no scene, no perspective tilt. This is an original decorative architectural website asset.

## Owner-authorized double-credit launch

The owner authorized $10 payments to issue $20 purchased credit for all models, without requiring supplier purchase-cost disclosure. The launch rate is $1 usage credit per million weighted base tokens; model input and output rates equal their base-token multiplier in credit dollars per million actual tokens. This is Routers pricing, not a verified comparison against vendor list prices. The launch migration records the user's rounded 1,049M supplier balance conservatively as 1,048M available inventory and never resets it on redeploy. It probes every mapped chat model and enables successful responses with valid usage. Failed suppliers stay unavailable; customer paid credit has no premium-family restriction. Supplier profit cannot be inferred while acquisition cost is undisclosed.
