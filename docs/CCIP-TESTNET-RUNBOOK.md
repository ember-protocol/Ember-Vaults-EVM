# CCIP testnet runbook — Sepolia ↔ Pharos Atlantic

Record of the rehearsal that validated `EmberTokenPool` against live CCIP, and the procedure to
repeat it. This is the basis for the mainnet runbook; see `docs/RFC-CCIP-MIGRATION.md` for the
design and the open questions.

Status: **first round trip completed successfully — on CCIP 1.6 ramps.**

> **This round trip no longer covers the production path.** It was executed when both chains ran
> 1.6 ramps, so it exercised the IPoolV1 `lockOrBurn`. The production Ethereum ↔ Pharos lanes now
> run 2.0 OnRamps in both directions, which take the IPoolV2 entrypoint instead — the one that can
> charge a pool fee and honour faster-than-finality. Those two behaviours are covered by unit tests
> (`CCIP 2.0 — pool fees` and `— faster than finality` in `test/EmberTokenPool.test.ts`) but have
> not been exercised against live 2.0 ramps. Re-run this round trip, or fork-test against the live
> ramps, before mainnet cutover.

## Topology

Both chains ran **CCIP 1.6.0 ramps** at the time of this run (verified via `typeAndVersion`, not
assumed). They have since moved to 2.0. Re-run `yarn ccip:verify-config` and expect the ramp event
shapes to differ from what is recorded below — the pool itself needs no change, since it resolves
ramps from the Router on every call.

|                           | Ethereum Sepolia                             | Pharos Atlantic                              |
| ------------------------- | -------------------------------------------- | -------------------------------------------- |
| chainId / selector        | 11155111 / `16015286601757825753`            | 688689 / `16098325658947243212`              |
| Vault (etCCIP, 6 dp)      | `0x7eBE31DF40e67c1a67A539a7bbc078732347dCA9` | `0xE03c31CaAc8c82B78Ae2E8482C09a6CB179F0C25` |
| `EmberTokenPool`          | `0xda1a710b7165FBC1d43cC556A25354cC501e3833` | `0x78cA3856051AD01780F0106C6124c85E063F199d` |
| Router                    | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` | `0x1E202D00714bFBcD7a5b4CF782791C38DA8BdC99` |
| RMN proxy                 | `0xba3f6251de62dED61Ff98590cB2fDf6871FbB991` | `0xB45B9eb94F25683B47e5AFb0f74A05a58be86311` |
| TokenAdminRegistry        | `0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82` | `0xAd1652471967E7FBf524245782A7f4430F6a4243` |
| RegistryModuleOwnerCustom | `0xa3c796d480638d7476792230da1E2ADa86e031b0` | `0x5370103629Fe91F28708ec4DC1A7A70DC5396EBf` |
| OnRamp                    | `0x23a5084Fa78104F3DF11C63Ae59fcac4f6AD9DeE` | `0x22af2fDb6Ec9E5AF82585Ee0efb65b5E46086841` |
| OffRamp                   | `0x0820f975ce90EE5c508657F0C58b71D1fcc85cE0` | `0x4D8785d2D1Fa810C0B39A688AEB46146e79a4569` |

Ramps are resolved from the Router rather than configured — they change on CCIP upgrades, and a
stale ramp address in indexer config fails **silently** (transfers keep working, the backend just
stops seeing them). `yarn ccip:verify-config` asserts them.

## Standing the lane up

```bash
# 1. deploy the pool on each chain (CREATE2 via the factory)
VAULT_KEY=emberTestCcipVault yarn ccip:deploy-pool --network sepolia
VAULT_KEY=emberTestCcipVault yarn ccip:deploy-pool --network atlantic

# 2. wire the lane — ONCE PER CHAIN, not once per direction.
#    Each pool only ever describes the remote side.
VAULT_KEY=emberTestCcipVault yarn ccip:apply-chain-updates --network sepolia
VAULT_KEY=emberTestCcipVault yarn ccip:apply-chain-updates --network atlantic

# 3. register with CCIP: registerAdminViaOwner -> acceptAdminRole -> setPool.
#    Sends directly when the vault owner is an EOA; prints scheduleBatch calldata otherwise.
VAULT_KEY=emberTestCcipVault yarn ccip:register-admin --network sepolia
VAULT_KEY=emberTestCcipVault yarn ccip:register-admin --network atlantic

# 4. CUTOVER — do this last. The vault has one adapter slot, so this is what goes live.
VAULT_KEY=emberTestCcipVault ADAPTER_ADDRESS=<pool> yarn bridge:set-adapter --network sepolia
VAULT_KEY=emberTestCcipVault ADAPTER_ADDRESS=<pool> yarn bridge:set-adapter --network atlantic

# 5. confirm both chains at once
yarn ccip:verify-config
```

`verify-config` should end with, on each side:

```
✅ TokenAdminRegistry: pointed at this pool
✅ vault.bridgeAdapter: pointed at this pool — LIVE
```

## Sending and tracking

```bash
VAULT_KEY=emberTestCcipVault AMOUNT=1 DRY_RUN=true yarn ccip:send --network sepolia   # quote only
VAULT_KEY=emberTestCcipVault AMOUNT=1 yarn ccip:send --network sepolia

TX_HASH=0x... yarn ccip:track
```

`ccip:send` approves the **Router**, not the pool — the Router pulls shares straight into the
pool and only then calls it. It quotes with `getFee` and sends exactly that amount, because the
Router keeps the whole `msg.value` on native payment with no refund.

### Observed on the first successful transfer

|                           |                                                                      |
| ------------------------- | -------------------------------------------------------------------- |
| messageId                 | `0x884ccb2b549453dd7c8da50809902fca64b450de280103ca86a60c0c53b7bd9a` |
| Amount                    | 1.0 etCCIP (gross == burned; no pool fee on the 1.6 IPoolV1 path)    |
| Fee                       | 0.000203481607795671 native                                          |
| **Destination `gasUsed`** | **117,780**                                                          |
| End-to-end                | ~15–20 minutes                                                       |
| Result                    | `ExecutionStateChanged` → `SUCCESS`; Atlantic supply 100.0 → 101.0   |

Two things worth carrying to mainnet:

**The `destGasAmount` risk did not materialise.** 117,780 gas covers the whole destination
execution — ERC165 checks, the `balanceOf` pair, and `bridgeMint` including fee accrual. That is
the measured number to give Chainlink for the mainnet FeeQuoter config, rather than an estimate.

**Latency is dominated by source-chain finality.** CCIP executes only after the source block is
final, which on Ethereum is ~15 minutes. Nothing is wrong if a message sits with no
`ExecutionStateChanged` for that long.

## Failure and replay test

The path most likely to be mishandled by the backend is **`FAILURE` → later `SUCCESS` on the same
messageId**, because it produces two `ExecutionStateChanged` events for one transfer. LayerZero
never produced this state. Rehearse it deliberately.

The cheapest failure to arrange is also the one that mirrors the real cutover hazard — an
in-flight message landing after the destination's `bridgeAdapter` changed:

```bash
# 1. revoke the pool on the DESTINATION (no ADAPTER_ADDRESS => sets address(0))
VAULT_KEY=emberTestCcipVault yarn bridge:set-adapter --network atlantic

# 2. send from the source; it will burn fine and fail on arrival
VAULT_KEY=emberTestCcipVault AMOUNT=1 yarn ccip:send --network sepolia

# 3. after ~15 min, confirm the failure and read the on-chain revert reason
TX_HASH=0x... yarn ccip:track       # expect state: FAILURE, with returnData

# 4. restore the adapter
VAULT_KEY=emberTestCcipVault ADAPTER_ADDRESS=<pool> yarn bridge:set-adapter --network atlantic

# 5. re-execute from https://ccip.chain.link/msg/<messageId> (manual execution), then
TX_HASH=0x... yarn ccip:track       # expect a second event, state: SUCCESS
```

**Backend acceptance criteria for this test:** exactly **one** `bridge_in` account transaction,
written on `SUCCESS` only, with an idempotent upsert across the two events. Crediting on
`FAILURE` — or crediting twice — is the bug this test exists to catch.

A second, complementary variant exercises the rate limiter: set a small inbound `capacity` via
`RATE_LIMIT_CAPACITY` / `RATE_LIMIT_RATE` on `ccip:apply-chain-updates`, drain it, and send again.
Note `capacity` is simultaneously the **maximum single transfer** and the burst size — a transfer
larger than `capacity` reverts `TokenMaxCapacityExceeded` and can never succeed, whereas a drained
bucket reverts `TokenRateLimitReached` and is replayable once it refills. Only the second is a
useful replay test.

## Environment gotchas

Things that cost time in this rehearsal and will recur.

**Atlantic caps `eth_getLogs` at 1,000 blocks**, and produces ~19 blocks/second — under a minute
of history per query. `ccip:track` walks the range backwards in chunks. This is a real design
constraint for `evm-chain-events-listener` on that chain.

**Explorer verification on Atlantic is unreliable.** Two independent problems: the OZ ERC1967
proxy is precompiled by `@openzeppelin/upgrades-core` at solc 0.8.29 and so cannot be verified
against this repo's compilers; and SocialScan returns Etherscan-shaped JSON with the payload in
`message` instead of `result`, which makes `hardhat-verify` throw a TypeError that masks the real
error. Both are handled as warnings now. Use `CONTRACT=<name> yarn verify:export-input` and the
explorer's Standard JSON Input form instead.

**Pool constructor args cannot be auto-detected**, because the pool is CREATE2-deployed from
inside the factory — there is no top-level creation transaction to scrape. Read them off the
deployed contract (`getToken`, `getTokenDecimals`, `getAdvancedPoolHooks`, `getRmnProxy`,
`getDynamicConfig`) rather than reconstructing them.

**The CCIP pool compiles under a per-file solc override** (0.8.26, `evmVersion: paris`), not the
repo default of 0.8.22. Verification must use those settings. Do not add 0.8.26 to the `compilers`
array to "fix" anything — hardhat picks the highest matching version, which silently moves every
`^0.8.22` contract onto it and changes deployed bytecode.

**Deploy scripts write JSON that fails `format:check`.** Run `yarn format` before committing
deployment manifests.

## What this rehearsal does NOT prove

The contracts work. The accounting is untested.

`bluefin-vaults-service` and `evm-chain-events-listener` were not in the loop for any of the
above, so none of the following has been exercised: attributing a bridge-out to the real user via
`EmberBridgeSent` rather than `BridgeBurn` (whose `from` is the pool), the `ccip_messages`
correlation on `messageId`, or the `FAILURE` → `SUCCESS` idempotency rule. Those are the
migration's real risk, and they need the backend work before a rerun.
