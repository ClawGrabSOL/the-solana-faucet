# The Solana Faucet

A homage to Gavin Andresens 2010 Bitcoin Faucet, rewritten for Solana.
Same bones: a dusty page, a photo of a tap, a captcha, a box for an address, a button that says Get Some!. Not a product. Not a launch. Just a little drip so you can actually try the network.

Payout is exactly 0.01 SOL (10,000,000 lamports) per successful captcha claim. Never more, never less.

This is a homage. Gavin Andresen did not build this site.

## Run it

Copy .env.example to .env. Install packages, then start the server. Open http://127.0.0.1:3456

The site fully renders without a wallet key. Claims will say the faucet is dry until you fund it.

## Fund it

Create a wallet with solana-keygen (faucet.json). Put that JSON array into SOLANA_SECRET_KEY in the env file, one line. Base58 secrets work too.

Set RPC_URL to a real endpoint. Public mainnet RPCs are often rate-limited. For devnet use https://api.devnet.solana.com and airdrop to the faucet pubkey. On mainnet, send SOL to the faucet address.

Optional: set FAUCET_DONATE_ADDRESS to the same public key, or leave blank and the page shows the wallet pubkey when a key is loaded. Restart the server. Left nav should show available balance.

Each successful claim sends 0.01 SOL. Keep at least that plus a tiny fee (about 5000 lamports) in the wallet or the page will say the faucet is dry.

## How a claim works

1. The server draws a distorted-text captcha (no Google keys).
2. POST verifies the captcha, then checks the address is a base58 32-byte Solana pubkey.
3. Rate limit: one successful drip per IP and per address per 24 hours.
4. If SOLANA_SECRET_KEY and RPC_URL are set and the wallet has enough, it sends exactly 0.01 SOL.
5. Success shows the transaction signature, linked to https://solscan.io/tx/{sig}.

