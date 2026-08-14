# Upgrade Scripts

Scripts for upgrading the UUPS-proxy contracts. Each reads `deployments/<network>-deployment.json` to find the proxy and writes the new implementation back to it.

## Scripts

### `upgrade:vaults` — `vault.ts`
Deploys a new `EmberVault` (or `EmberETHVault`) implementation and upgrades the requested vault proxies to it. Updates the deployment JSON in place.
- **Optional:** `VAULT_KEYS` (comma-separated; omit to upgrade **all** vaults), `IS_ETH_VAULT=true` (target ETH vaults instead)
- **Example:** `VAULT_KEYS=emberErcusdcVault,emberErcethVault yarn upgrade:vaults --network sepolia`

### `upgrade:protocol-config` — `protocol-config.ts`
Upgrades the `EmberProtocolConfig` proxy.
- **Optional:** `PROTOCOL_CONFIG_PROXY` (override the address from the deployment file)
- **Example:** `yarn upgrade:protocol-config --network sepolia`

### `upgrade:vault-implement-address` — `vault-implement-address.ts`
Variant of `upgrade:vaults` that takes `VAULT_KEY` (singular) and resolves the contract type via `IS_ETH_VAULT` rather than the typed factories. Useful when upgrading a single vault and you want the script to print the new implementation address.
- **Optional:** `VAULT_KEY` (single key; omit to upgrade all), `IS_ETH_VAULT=true`
- **Example:** `VAULT_KEY=emberUdl yarn upgrade:vault-implement-address --network mainnet`

### `upgrade:vault-validator` — `vault-validator.ts`
Upgrades the `EmberVaultValidator` proxy.
- **Optional:** `VAULT_VALIDATOR_PROXY` (override the address from the deployment file)
- **Example:** `yarn upgrade:vault-validator --network sepolia`

### `upgrade:deposit-parking-lot` — `deposit-parking-lot.ts`
Deploys a new `EmberDepositParkingLot` implementation and upgrades the requested parking-lot proxies to it. Because these contracts custody live user escrow, the script prints each proxy's owner, vault, operator, pause flag, live pending-request count and escrowed collateral before touching anything, and re-checks `totalPendingAssets` / `getLivePendingDepositsCount` after each upgrade — a change there aborts rather than reporting success. Escrow lives in the proxy's own balance and storage, so the upgrade itself can't move or strand it; the queue depth is reported because already-accepted requests will settle under the new implementation's rules.
- **Optional:** `PARKING_LOT_KEYS` (comma-separated keys under `contracts.depositParkingLots`; omit to upgrade **all**), `PARKING_LOT_PROXY` (single ad-hoc proxy, takes precedence over `PARKING_LOT_KEYS`)
- **Example:** `PARKING_LOT_KEYS=emberHilbert,emberHilbertBtc yarn upgrade:deposit-parking-lot --network mainnet`
- `_authorizeUpgrade` is owner-gated. When the owner is a Timelock (the production setup) the script aborts up front and prints the `admin:gen-timelock-upgrade` command to use instead.

### `verify:permit` — `verify-permit.ts`
Sanity-checks that the freshly compiled `EmberVault` bytecode still exposes `depositWithPermit` / `mintWithPermit` after a build. Useful before an upgrade.
- **Example:** `yarn verify:permit`

## Notes

- Every upgrade script calls `upgrades.validateUpgrade(proxy, Factory, { kind: "uups" })` for each proxy **before** deploying the new implementation. If the new source would corrupt the existing storage layout (reordered/renamed/removed state variables, changed inheritance, unsafe ops), the script aborts and no tx is sent.
- New implementations are deployed via `upgrades.deployImplementation(...)` so `.openzeppelin/<network>.json` stays in sync. Commit any changes to that file alongside the upgrade.
- If validation fails with "The proxy ... is not registered" or "implementation ... is not registered", the manifest has drifted (likely from a past upgrade that bypassed the plugin). Reconcile it once with `upgrades.forceImport(proxyAddress, Factory, { kind: "uups" })` against the currently-deployed implementation source, commit the regenerated manifest, then retry. Do **not** bypass the check.
- The upgrader must be the proxy admin / owner. Run `scripts/transfer-ownership.ts` (or the multisig flow) if you need to hand the role over before upgrading.
- For mainnet, run `scripts/test/test-mainnet-upgrade.ts` first against a fork to validate the upgrade end-to-end.
- CI runs `yarn ci:validate-upgrades --network <name>` against every proxy in `deployments/<name>-deployment.json`. See `scripts/ci/validate-upgrades.ts`.
