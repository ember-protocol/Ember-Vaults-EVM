# Deploy Scripts

UUPS-proxy deployment scripts for the Ember vault system. Each appends/updates `deployments/<network>-deployment.json` with the deployed addresses.

## Order for a fresh chain

1. **`deploy:protocol-config`** — `protocol-config.ts` — deploys `EmberProtocolConfig` (the registry that owns admin / fee config across all vaults).
2. **`deploy:vault-validator`** — `vault-validator.ts` — deploys `EmberVaultValidator`. Reads the protocol config from the deployment file.
3. **`deploy:deposit-token`** — `deposit-token.ts` — optional; deploys an ERC20 deposit token if you don't have one already (`TOKEN_NAME`, `TOKEN_SYMBOL`, `TOKEN_DECIMALS`).
4. **`deploy:vault`** — `ember-vault.ts` — deploys an `EmberVault` proxy for an ERC20 collateral.
   - Required: `VAULT_NAME`, `VAULT_RECEIPT_TOKEN_SYMBOL`, `VAULT_COLLATERAL_TOKEN`, `VAULT_ADMIN`, `VAULT_OPERATOR`, `VAULT_RATE_MANAGER`
5. **`deploy:eth-vault`** — `ember-eth-vault.ts` — same as above but for an `EmberETHVault` (collateral must be a WETH contract).
6. **`deploy:oft-adapter`** — `oft-adapter.ts` — deploys the LayerZero OFT adapter for a vault. Required: `VAULT_KEY`. After deploy, see [`scripts/bridge/README.md`](../bridge/README.md) for wiring.

### Test-only

- `mock-weth.ts` — non-upgradeable MockWETH for local / testnet use. Run via `yarn hardhat run scripts/deploy/mock-weth.ts --network <name>`.

## Conventions

- All deploy scripts append to `deployments/<network>-deployment.json` keyed by a stable name (e.g. `emberExusdcVault`). That key is what every other script (`upgrade:*`, `bridge:*`, `interact:*`) uses to look the address up later — choose carefully.
- `OWNER_ADDRESS` defaults to the deployer for every script that supports it; pass it explicitly when you want a multisig as owner from the start.
- `VAULT_MAX_RATE_CHANGE` defaults to `0.01e18` (1%) on the vault deploys; override with the env var for higher-volatility collaterals.
