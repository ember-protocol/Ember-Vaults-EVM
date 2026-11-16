# Setting up a CCIP bridge for a vault

How to bring up a Chainlink CCIP lane for an Ember vault's receipt token, on any pair of
CCIP-supported chains.

- Design rationale and open questions: `docs/RFC-CCIP-MIGRATION.md`
- Recorded Sepolia ↔ Pharos Atlantic rehearsal, with measured results: `docs/CCIP-TESTNET-RUNBOOK.md`

## What a working lane consists of

Five things must all be true. Each command below establishes exactly one of them, and
`yarn ccip:verify-config` reports on all five.

1. An `EmberTokenPool` is deployed on **each** chain, bound to that chain's vault.
2. Each pool has a **lane entry** naming the remote chain's selector, pool and token.
3. The token is registered in each chain's **`TokenAdminRegistry`**, pointing at that pool.
4. Each vault's **`bridgeAdapter`** is that chain's pool — this is what makes it live.
5. The CCIP **lane itself** is enabled by Chainlink, in both directions.

Point 5 is not yours to configure. Verify it before doing any work: a Router with no OnRamp for
the destination selector means the lane does not exist, and nothing you deploy will move.

The pool is a per-(token, chain) contract, not a proxy. It burns on send and mints on receive
through the vault's `IBridgeable` hooks, and it can only do so while it is the vault's
`bridgeAdapter`. Everything else it inherits from Chainlink's `TokenPool`.

## Prerequisites

- **A bridge-capable vault on both chains.** The vault must expose `bridgeAdapter()`,
  `bridgeMint` and `bridgeBurn`. Bridge support landed in `ae58e01`; vaults deployed from earlier
  implementations revert on `bridgeAdapter()` and cannot host a pool. Check with
  `yarn ccip:verify-config`.
- **Matching decimals**, or a deliberate decision to exercise CCIP's decimals conversion. The pool
  validates its configured decimals against `token.decimals()` at construction and will not deploy
  on a mismatch.
- **A funded deployer**, and the ability to sign as the vault `owner()` (registration) and
  `roles.admin` (cutover). On mainnet both are Timelocks — see [Mainnet](#mainnet-the-timelock-path).
- **RPC URLs in `.env`** for both chains.
- The CCIP contract addresses for both chains in `config/ccip.config.ts`.

## Step 0 — verify before deploying

```bash
yarn ccip:verify-config
```

Read-only, broadcasts nothing, checks both chains at once. It proves the Router / RMN /
TokenAdminRegistry / RegistryModuleOwnerCustom addresses are real and self-identify correctly,
resolves the OnRamp and OffRamp **from the Router** rather than from config, reports the ramp
generation, and confirms the lane is live in both directions.

Do not skip this. Addresses copied from documentation are the single easiest thing to get wrong,
and a pool constructed against a wrong Router is immutable — the token and RMN proxy are
constructor immutables, so the fix is a redeploy.

Ramps are deliberately **not** stored in `config/ccip.config.ts`. They change when Chainlink
upgrades, and a stale ramp address in indexer config fails silently: transfers keep working while
the backend stops seeing them.

## Step 1 — deploy the pool on each chain

```bash
VAULT_KEY=<vaultKey> yarn ccip:deploy-pool --network <chainA>
VAULT_KEY=<vaultKey> yarn ccip:deploy-pool --network <chainB>
```

Deploys `EmberTokenPoolFactory` if one is not already recorded, then CREATE2-deploys the pool
through it. The address is predicted before the transaction is sent, so both sides of a lane can
be planned before either exists.

Options: `POOL_OWNER` (defaults to the deployer — this is who may configure lanes and rate
limits), `FACTORY` to reuse an existing factory, `SALT` to change the CREATE2 salt, `POOL_HOOKS`
for an `IAdvancedPoolHooks` contract.

`POOL_HOOKS` defaults to `address(0)`, which means the pool declares no required CCVs and inherits
the chain's default verifier set — the Chainlink Committee Verifier DON. That is the intended
default; only supply hooks if you have decided to pin a verifier set or need a pool-level
allowlist.

Nothing is live after this step. The pool cannot mint until step 4.

## Step 2 — wire the lane

```bash
VAULT_KEY=<vaultKey> yarn ccip:apply-chain-updates --network <chainA>
VAULT_KEY=<vaultKey> yarn ccip:apply-chain-updates --network <chainB>
```

**Once per chain, not once per direction.** Each pool only ever describes the *remote* side, so
chain A's pool gets an entry pointing at chain B's pool and token, and vice versa. Running it
twice on one chain is a common mistake and achieves nothing.

Reads the remote pool address from the remote chain's deployment file, so step 1 must be complete
on both chains first. `applyChainUpdates` reverts on a duplicate selector, so the script removes
and re-adds when a lane already exists.

**Rate limits default to disabled**, which is right for a first bring-up. Set them deliberately
before mainnet with `RATE_LIMIT_CAPACITY` and `RATE_LIMIT_RATE` (token base units; rate is per
second). Chainlink applies no limits of its own — these are the only ones that will exist.

Two properties of the token bucket that catch people out: `capacity` is simultaneously the
**maximum single transfer** and the burst size, so a transfer larger than `capacity` reverts
`TokenMaxCapacityExceeded` and can never succeed; and reconfiguring **refills the bucket**. The
inbound limit is the one that matters for security — it caps what a compromised remote chain can
mint — but it is also the expensive one to hit, because an inbound rejection strands the message
in `FAILURE` until someone re-executes, whereas an outbound rejection just reverts the user's
`ccipSend`.

## Step 3 — register the token with CCIP

```bash
VAULT_KEY=<vaultKey> yarn ccip:register-admin --network <chainA>
VAULT_KEY=<vaultKey> yarn ccip:register-admin --network <chainB>
```

Three sequential calls across two Chainlink contracts:

1. `RegistryModuleOwnerCustom.registerAdminViaOwner(token)` — **must be called by `token.owner()`**;
   installs that address as pending administrator.
2. `TokenAdminRegistry.acceptAdminRole(token)` — by the pending administrator.
3. `TokenAdminRegistry.setPool(token, pool)` — by the now-accepted administrator.

When `owner()` is an EOA the script sends all three. When it is a Timelock or Safe it prints the
per-step calldata plus ready-made `targets` / `values` / `payloads` arrays for `scheduleBatch`.
Use `DRY_RUN=true` to get that output without sending.

`setPool` reverts unless the pool reports `isSupportedToken(token)`, so step 1 must be complete.
The script pre-checks this rather than letting it fail on-chain.

## Step 4 — cut over

```bash
VAULT_KEY=<vaultKey> ADAPTER_ADDRESS=<poolAddress> yarn bridge:set-adapter --network <chainA>
VAULT_KEY=<vaultKey> ADAPTER_ADDRESS=<poolAddress> yarn bridge:set-adapter --network <chainB>
```

Use `ADAPTER_ADDRESS` with the **pool** address — not the factory, and not `ADAPTER_KEY`, which
resolves against the legacy `oftAdapters` map and will not find a CCIP pool.

**This is the step that makes the bridge live**, and it must be last. The vault has a single
adapter slot, so pointing it at the pool simultaneously revokes whatever held it before. Run it
before steps 2 and 3 and you get a pool that can mint but that CCIP does not route to, or the
reverse.

Caller must be the vault's `roles.admin`.

### Migrating from an existing bridge

If the vault already has an adapter — a LayerZero OFT adapter, or an older pool — this transaction
revokes it. Any message already in flight on the old bridge will fail on arrival, because its
adapter no longer has mint rights.

Drain first:

1. Pause the old adapter (`EmberVaultMintBurnOFTAdapter` is `Pausable`).
2. Wait past the maximum observed delivery latency for that bridge.
3. Confirm nothing is in flight. For LayerZero, `bluefin-vaults-service` already tracks this —
   gate on `oft_stuck_messages == 0` on both chains.
4. Then execute the cutover.

## Step 5 — verify

```bash
yarn ccip:verify-config
```

Each chain should now report:

```
✅ token          <vault address>
✅ lane -> <remote>: configured, remote token 0x…
✅ TokenAdminRegistry: pointed at this pool
✅ vault.bridgeAdapter: pointed at this pool — LIVE
```

Anything short of all four means the lane will not move value.

## Step 6 — send and track

```bash
VAULT_KEY=<vaultKey> AMOUNT=1 DRY_RUN=true yarn ccip:send --network <chainA>   # quote only
VAULT_KEY=<vaultKey> AMOUNT=1 yarn ccip:send --network <chainA>

TX_HASH=0x… yarn ccip:track
```

There must be shares to bridge — deposit collateral first if `totalSupply` is zero — and native
(or LINK, via `FEE_TOKEN`) for the CCIP fee.

The user interacts with the **Router**, never the pool. Approvals go to the Router, which pulls
the shares straight into the pool and only then calls it. `lockOrBurn` is gated on the caller being
the Router's onRamp, so a direct call reverts.

Quote first and send exactly: paying in native, the Router keeps the entire `msg.value` with no
refund. Do not pad it the way you might a LayerZero `MessagingFee`.

`ccip:track` reads the source receipt for `EmberBridgeSent` and the OnRamp's `CCIPMessageSent`
(where the `messageId` lives — the pool events deliberately carry none), then finds the matching
`ExecutionStateChanged` on the destination OffRamp and reports `SUCCESS` or `FAILURE` with the
on-chain revert reason.

**Expect 15–20 minutes on an Ethereum source.** CCIP executes only after source-chain finality; on
Ethereum that dominates everything else. A message with no `ExecutionStateChanged` for that long is
normal, not stuck.

## Ordering constraints, and why

| Must come before | Because |
|---|---|
| Deploy both pools → wire lanes | `applyChainUpdates` needs the remote pool address |
| Deploy pool → register admin | `setPool` reverts unless the pool supports the token |
| Everything → cutover | The cutover is what grants mint rights; do it early and the bridge is half-configured while live |
| Drain old bridge → cutover | In-flight messages on the old bridge fail once its adapter is revoked |

## Faster-than-finality on mainnet

FTF is enabled on the production lanes. It trades reorg safety for latency, so the mainnet
configuration has to bound that trade rather than just permit it.

**The exposure.** An FTF transfer mints on the destination before the source chain has finalised.
If the source then reorgs past the burn, the burn is undone while the mint stands — the same
shares now exist on both chains. Nothing downstream repairs that, so the only control is how much
can cross inside the reorg window.

**Set an FTF rate limit on every lane.** The FTF bucket is *separate* from the default-finality
one and starts disabled, so an FTF-enabled lane is unthrottled on exactly the reorg-exposed path
until you set it. `ccip:apply-chain-updates` deliberately does not touch FTF limits (it would
wipe them on a re-run), so they are set explicitly:

```bash
VAULT_KEY=<vault> FTF_RATE_LIMIT_CAPACITY=<units> FTF_RATE_LIMIT_RATE=<units/s> \
  yarn ccip:set-ftf-limits --network <chain>
```

Run it on **both** chains of a lane. Size the capacity against what you are willing to see
duplicated by a deep reorg, not against normal throughput. The script skips a lane whose limits
already match, because rewriting a bucket refills it. `setRateLimitConfig` is
`onlyOwnerOrRateLimitAdmin`, so the ops multisig can tighten this mid-incident without the owner
timelock — set `rateLimitAdmin` first with `ccip:set-dynamic-config`.

**Raise the block-depth floor, and drop the safe-tag bit.** `allowedFinality` combines two
*independent* acceptance paths: the safe-tag flag (`0x00010000`) and a block-depth floor in the
low 16 bits. A request carrying the safe tag is admitted **regardless of the depth floor**, so
raising the depth while `0x00010000` is set tightens nothing. A genuine floor means dropping it:

| value | meaning |
| --- | --- |
| `0x00010001` | safe tag **or** depth >= 1 — permissive, testnet only |
| `0x00000040` | depth >= 64 only — no safe-tag path |
| `0x00000000` | FTF off, full finality |

```bash
VAULT_KEY=<vault> FINALITY=0x00000040 yarn ccip:set-finality --network <chain>
```

`ccip:verify-config` exits non-zero for a lane where FTF is permitted but no FTF rate limit is
set, compares each inbound bucket against the far side's outbound, and notes when the safe-tag
path leaves the depth floor non-binding.

## Mainnet: the Timelock path

On mainnet the two signing roles are Timelocks, so steps 3 and 4 are proposals rather than
transactions.

| Step | Required caller | Mainnet holder |
|---|---|---|
| Register admin (3 calls) | `token.owner()` | Owner Timelock — 24 h |
| Cutover (`setVaultBridgeAdapter`) | `roles.admin` | Admin Timelock — 12 h |
| Lane config, rate limits | pool `owner()` | whoever was set as `POOL_OWNER` |

The three registration calls are atomic-safe in sequence, so batch them into **one**
`scheduleBatch` proposal — one delay period instead of three. `ccip:register-admin` prints the
`targets` / `values` / `payloads` arrays for exactly this.

Choose `POOL_OWNER` deliberately at deploy time. A Timelock is the safe default for lane
configuration, but it makes every rate-limit change a delayed operation, which is wrong for
incident response. `TokenPool` separates `owner` from `rateLimitAdmin` and `feeAdmin` — consider
owner = Timelock, `rateLimitAdmin` = ops multisig.

## Adding a new chain

Worked example: Mantle Sepolia, which is already configured — use it as the template.
`ethereum-testnet-sepolia-mantle-1`, chainId 5003, selector `8236463271206331221`; the mainnet
counterpart is `ethereum-mainnet-mantle-1`, chainId 5000, selector `1556008542357238666`.

Note the Sepolia ↔ Mantle Sepolia lane runs **OnRamp/OffRamp 2.0.0**, whereas Sepolia ↔ Pharos
Atlantic runs 1.6.0. That makes it the only place we can currently exercise the 2.0 code paths —
the `IPoolV2` `lockOrBurn` entrypoint, the reshaped `CCIPMessageSent` with indexed `messageId` and
`sender`, and `ExecutionStateChanged` without `gasUsed` — which is what Pharos will move to.

1. **Confirm CCIP actually serves it.** A selector in `smartcontractkit/chain-selectors` means the
   chain has an identifier, **not** that ramps are deployed or that a lane to your partner chain
   exists. Check the [CCIP directory](https://docs.chain.link/ccip/directory) for Router, RMN
   proxy, TokenAdminRegistry and RegistryModuleOwnerCustom, then prove the lane on-chain with
   step 0.
2. **Add the network** to `hardhat.config.ts` (RPC env var, chainId, accounts), and to the
   verification providers if its explorer is not Etherscan-family.
3. **Add a `CcipNetworkConfig`** to `config/ccip.config.ts` — selector, RPC env var, and the four
   addresses — plus entries in `LANE_PARTNERS` for **both** directions.

   `LANE_PARTNERS` maps a network to a *list*, because a hub has several spokes. Where a network
   has exactly one partner the scripts resolve it automatically; where it has more than one they
   refuse and require `REMOTE_NETWORK` (or `DEST_NETWORK` for `ccip:track`) rather than guessing.
   Sepolia is now such a hub — `atlantic` and `mantle_sepolia` — so every Sepolia-side command
   needs the lane named explicitly.
4. **Add its vaults** to the `VAULTS` map in `scripts/ccip/verify-ccip-config.ts`, and the network
   name to `NETWORKS` there. Nothing else needs touching: the CCIP addresses, RPC env var and lane
   partners all come from `config/ccip.config.ts`, and `ccip:track` reads the same source.
5. **Deploy a bridge-capable vault** there, if one does not exist.
6. Run steps 0–6 above.

Note that a token already registered on the other chains needs a lane entry added on **every**
existing pool that will talk to the new one, not just on the new pool.

## Rollback and decommissioning

- **Before cutover:** the pool has no mint rights. `TokenAdminRegistry.setPool(token, address(0))`
  is sufficient; there is no user impact.
- **After cutover:** point `bridgeAdapter` back at the previous adapter, or at `address(0)` to
  disable bridging entirely (`bridge:set-adapter` with no `ADAPTER_ADDRESS`). One Timelock
  operation per chain. Drain CCIP first, symmetrically to the cutover.
- **Emergency stop, no Timelock:** blacklisting the pool address halts every bridge-out on that
  chain immediately, because `EmberVault.bridgeBurn` checks the blacklist against `from` — which
  under CCIP is the pool. The guardian can do this without a delay. Inbound is unaffected.
- **Replacing a pool:** pools are immutable, so replacement is a fresh deploy plus `setPool` plus
  `setVaultBridgeAdapter`, plus `addRemotePool` on the *remote* pool. `remotePoolAddresses` is a
  set precisely so the old and new pool can both be accepted during a migration window.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `OnRamp: none configured` in verify | The lane does not exist. Nothing you deploy will help; raise it with Chainlink. |
| `bridgeAdapter() reverted` in verify | The vault predates bridge support and cannot host a pool. Upgrade or deploy a new vault. |
| `InvalidDecimalArgs` on deploy | Configured decimals do not match `token.decimals()`. |
| Deploy aborts: contract already at predicted address | Same (deployer, salt, constructor args) as an existing pool. Change `SALT` or reuse it. |
| `setPool` reverts | Pool not deployed, or deployed for a different token. |
| `CallerIsNotARampOnRouter` on send | The pool is not registered for this lane, or the caller is not the Router's ramp. |
| Send reverts `Unauthorized` | The pool is not the vault's `bridgeAdapter` — step 4 not done. |
| Send reverts `SenderBlacklisted` | The sender is blacklisted at protocol level. Enforced pool-side on `originalSender`. |
| No `ExecutionStateChanged` after 20+ min | Still awaiting source-chain finality, or the executor has not picked it up. Check the CCIP Explorer. |
| `ExecutionStateChanged` state `FAILURE` | Read `returnData` for the on-chain revert reason. Replayable — see below. |
| Verify: constructor args not detected | Expected. CREATE2-from-factory has no top-level creation tx. Read the args off the pool with `getToken` / `getTokenDecimals` / `getAdvancedPoolHooks` / `getRmnProxy` / `getDynamicConfig`. |
| `format:check` fails after a deploy | Deploy scripts write unformatted JSON. Run `yarn format`. |

### A failed message is not a lost message

`FAILURE` means nothing was minted and the source burn already happened — the value is stranded,
not destroyed, and the message stays replayable. Fix the cause (re-authorize the adapter, wait for
a rate-limit bucket to refill, raise gas) and re-execute from
`https://ccip.chain.link/msg/<messageId>`.

On CCIP 2.0 ramps `execute` is permissionless. On 1.6 ramps manual execution needs the commit proof
reconstructed, which is impractical to script — use the Explorer.

**A message can therefore emit `ExecutionStateChanged` twice: `FAILURE`, then later `SUCCESS`.**
Any indexer must treat delivery as idempotent and credit the recipient only on `SUCCESS`.

## Script reference

| Command | Broadcasts | Purpose |
|---|---|---|
| `yarn ccip:verify-config` | no | Verify both chains: addresses, lane, ramp generation, pool and cutover state |
| `yarn ccip:deploy-pool` | yes | Deploy factory (if needed) and pool via CREATE2 |
| `yarn ccip:apply-chain-updates` | yes | Configure a lane and its default-finality rate limits |
| `yarn ccip:set-ftf-limits` | yes (owner or `rateLimitAdmin`) | Set the fast-finality rate limits, which `apply-chain-updates` leaves alone |
| `yarn ccip:register-admin` | yes / prints calldata | The three-step TokenAdminRegistry flow |
| `yarn bridge:set-adapter` | yes | Cutover: point the vault at the pool |
| `yarn ccip:send` | yes (`DRY_RUN` to quote) | Approve the Router and `ccipSend` |
| `yarn ccip:track` | no | Follow a transfer to delivery |
| `yarn verify:export-input` | no | Standard JSON Input for manual explorer verification |
