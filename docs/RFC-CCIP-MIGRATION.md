# RFC: Migrate the vault-share bridge from LayerZero OFT to Chainlink CCIP token pools

Status: **Draft — revision 3**
Owner: Burhan (@burhanuddin)
Related: `docs/BRIDGE.md`
References: [`smartcontractkit/ember-custom-token-pool`](https://github.com/smartcontractkit/ember-custom-token-pool) @ `29d20d7` — Chainlink's implementation of the pool for our token; [Chainlink CCIP docs](https://docs.chain.link/ccip).

**Contract version this RFC targets: `contracts-ccip-v2.0.0`** — the latest release (`v2.1.0-beta.0` is tagged but not released), and the version `EmberTokenPool` imports. All contract references below are read from that tag: `chains/evm/contracts/pools/TokenPool.sol`, `onRamp/OnRamp.sol`, `offRamp/OffRamp.sol`, `libraries/Pool.sol`. Where 1.6.x behaves materially differently — and it does, in three places that changed this RFC — it is called out explicitly.

This RFC is a **proposal**. Nothing in `contracts/` or `scripts/` changes as part of this PR. The intent is to align on:

1. the target architecture,
2. the migration phasing,
3. the changes required outside this repo (backend, listener, SDK),
4. a concrete list of open questions to send to the Chainlink team

before we open any implementation PRs.

## Revision history

### Revision 3 — pinned to contracts-ccip v2.0.0

Revision 2 was written against the 1.6.x contracts. Re-reading against the v2.0.0 tag changed three conclusions and added one new question. Net effect: **the RFC got shorter.**

| Revision 2 said                                                                                                                | Revision 3                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correlating send↔receive needs either CCIP-infra indexing or a custom nonce smuggled through `destPoolData`                    | **`messageId` is indexed on both legs in 2.0.0.** No nonce hack. The `destPoolData` option is dropped entirely.                                                                                                                                                             |
| A custom pool event carrying `originalSender` is **required** to attribute bridge-outs to the real user                        | **Optional.** `CCIPMessageSent.sender` in 2.0.0 is the real user _and_ indexed. Indexing the OnRamp solves attribution with no contract change.                                                                                                                             |
| `destGasOverhead` must be measured and configured or every inbound transfer fails on arrival                                   | **Not a thing in 2.0.0.** The per-token gas budget is gone; the pool call is a plain `try/catch` with all remaining gas. Question dropped.                                                                                                                                  |
| The OffRamp asserts `balancePost - balancePre == localAmount`, so a share-minting fee model would break every inbound transfer | **1.6.x only.** 2.0.0 uses the delta to _compute_ the reported amount, not to assert. We pass either way, but the reasoning was version-specific.                                                                                                                           |
| —                                                                                                                              | **New: CCIP 2.0.0 replaces the fixed DON+RMN pipeline with pluggable Cross-Chain Verifiers (CCVs).** The pool can declare which verifiers must attest to its token — and as written, ours declares none. See [Verification](#verification-ccvs-and-what-our-pool-declares). |
| —                                                                                                                              | **New: explicit failure/replay semantics**, and the backend rule that falls out of them. See [When the mint side fails](#when-the-mint-side-fails).                                                                                                                         |

### Revision 2 — reconciled against Chainlink's shipped pool

Chainlink published `ember-custom-token-pool`, a working `EmberTokenPool` plus a CREATE2 factory written against our `bridgeMint`/`bridgeBurn` hooks. That invalidated most of revision 1: CCIP moved the extension point to the internal `_lockOrBurn`/`_releaseOrMint` hooks; cross-chain decimals are handled by the base; the pool is immutable + `Ownable2Step`; admin registration is owner-Timelock-gated with no front-running risk. Scope also shrank from four chains to **one token, one lane, two chains**, which killed the Sui argument for widening `bridgeAdapter` into a set and made the hard cutover (Option A) the right call.

## Motivation

Today the vault-share receipt tokens bridge between chains through **LayerZero V2 OFT** via
`contracts/EmberVaultMintBurnOFTAdapter.sol`. LZ has served the mint-on-receive / burn-on-send flow well, but:

- LZ's operational surface (DVN configs, enforced options, per-chain peer maps, pin-libraries) is
  large and per-chain-specific. Each new chain is a new dance of scripts.
- Some of our target chains have first-class CCIP support and better delivery guarantees.
- Standardizing on CCIP CCT gives us access to Chainlink's rate limiting, admin registry, and
  replay primitives out of the box.
- Ember shares one bridged token per vault; that's the exact use case CCT is designed for.

Goal: **replace the LZ adapter with a CCIP burn-mint token pool while keeping the vault contracts
untouched.**

Non-goals:

- Redesigning `IBridgeable`. The mint/burn hooks are already the right shape for CCIP.
- Any change to how the share token is minted at deposit time. Bridge is an orthogonal concern.
- The cross-chain vault adapter in Chainlink's phase 3 (deposits from chains the vault isn't
  deployed on). Separate product scope; explicitly out of this migration.

## Blocking dependency: is the ethereum ↔ pharos lane live?

Chainlink's README states the requirement plainly: _"Pharos must be a CCIP-supported chain (with a
Router/RMN deployed) for this to work — the pool cannot bridge to chains CCIP doesn't serve."_

Two things that are easy to conflate, and the distinction is now the whole question:

- **Pharos CCIP contracts exist.** `config/ccip.config.ts` carries Router, RMN proxy,
  TokenAdminRegistry, RegistryModule and the chain selector for Pharos mainnet, and the same for
  Pharos Atlantic testnet. The earlier statement that no Pharos address existed anywhere was true
  of Chainlink's repo when this document was first written; it is no longer true of ours.
- **The lane is not confirmed live.** Addresses being deployed is not the same as the
  ethereum ↔ pharos lane being enabled end to end — an OnRamp on ethereum for the Pharos
  selector, an OffRamp on Pharos for the ethereum selector, and RMN blessing the lane. That is
  what still has to be confirmed with Chainlink, and `yarn ccip:verify-config` reports each of
  those three directly.

What we do know empirically is that the **design works on Pharos**: the Sepolia ↔ Pharos Atlantic
lane is standing, with a confirmed transfer and a measured destination `gasUsed` of 117,780 (see
[the testnet runbook](./CCIP-TESTNET-RUNBOOK.md)). The remaining risk is mainnet lane
availability, not whether the pool and the chain are compatible.

pALPHA's only lane is ethereum ↔ pharos. **If that lane cannot be enabled, this migration cannot
ship**, and no other question in this document matters.

Second-order version question that falls out of the same conversation: **which CCIP contract
generation is deployed on each chain?** The 1.6.x and 2.0.0 ramps differ enough that our indexing
work depends on the answer (see [Correlation](#correlating-send-and-receive)). The pool itself is
fine either way — `EmberTokenPool` inherits `TokenPool`, which implements both `IPoolV1` and
`IPoolV2`, and the 2.0.0 OffRamp explicitly dispatches to whichever the pool supports.

## Current LZ surface (what has to go)

Exactly one bridged token exists in production:

|                                | Ethereum (1)                                 | Pharos (1672)                                |
| ------------------------------ | -------------------------------------------- | -------------------------------------------- |
| Vault / receipt token (pALPHA) | `0xC3AaCb558aFB635307B66FDb405188138576fc4c` | `0xE47E9bA4EA2320A6ed87246d02Fd5C38485Ed7d1` |
| `EmberVaultMintBurnOFTAdapter` | `0xC6507ef17265B4Eed37aE901D939A6b977C5CbA3` | `0x93728958821A31B59fb5DC459c94c0d6D714701D` |
| LZ endpoint                    | `0x1a44076050125825900e736c501f859c50fE728c` | `0x6F475642a6e85809B1c36Fa62763669b1b48DD5B` |
| Peer eid                       | 30407 (pharos)                               | 30101 (ethereum)                             |
| `decimalConversionRate`        | 1                                            | 1                                            |

`base-deployment.json` has vaults and parking lots but an empty `oftAdapters` — no bridge. `atlantic`
and `sepolia` likewise.

| Piece               | Location                                                                                         | Notes                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter contract    | `contracts/EmberVaultMintBurnOFTAdapter.sol`                                                     | Implements `IOFT`; calls `IBridgeable.bridgeMint` / `bridgeBurn`. LZ send/receive, DVN config, peers, enforced options, precrime, `Pausable`.                          |
| Bridgeable hook     | `contracts/interfaces/IBridgeable.sol`                                                           | `bridgeMint(to, amount)`, `bridgeBurn(from, amount)`, `min/maxBridgeAmount()`. **Keep, unchanged.**                                                                    |
| Vault-side auth     | `EmberVault.sol:193 / 532 / 1032` (mirrored in `EmberETHVault.sol`)                              | `address public bridgeAdapter` + `onlyBridgeAdapter` + `setBridgeAdapter`. Single adapter slot.                                                                        |
| Config plumbing     | `EmberProtocolConfig.sol:426` (`setVaultBridgeAdapter`)                                          | Forwards to `vault.setBridgeAdapter(msg.sender, newAdapter)`, which enforces `onlyAdmin(caller)`.                                                                      |
| Scripts             | `scripts/bridge/*.ts`, `scripts/deploy/oft-adapter.ts`                                           | `setPeer`, `setDelegate`, `setEnforcedOptions`, `setDvnConfig`, `pin-libraries`, `quote-send`, `send-tokens`, `diagnose-bridge`, `verify-peers`, `set-adapter-paused`. |
| Tests               | `test/EmberVaultMintBurnOFTAdapter.test.ts`                                                      | Full auth + edge-case coverage.                                                                                                                                        |
| Off-chain consumers | `evm-chain-events-listener`, `bluefin-vaults-service`, `ember-sdk`, `ember-vaults-ops`, frontend | See [Off-chain changes](#off-chain-changes-the-bulk-of-the-work).                                                                                                      |

## Target architecture

CCIP's Cross-Chain Token (CCT) standard uses a **token pool per (token, chain)**, registered with the
chain's `TokenAdminRegistry` and called by the Router via OnRamp / OffRamp.

```
Ethereum                                                Pharos
┌──────────────────────┐                              ┌──────────────────────┐
│      EmberVault      │                              │      EmberVault      │
│  (pALPHA ERC-20)     │                              │  (pALPHA ERC-20)     │
└──────────┬───────────┘                              └───────────┬──────────┘
           │  IBridgeable                                          │  IBridgeable
           ▼                                                      ▼
┌──────────────────────┐          CCIP Router          ┌──────────────────────┐
│    EmberTokenPool    │◄────────────────────────────►│    EmberTokenPool    │
│  (burn on send)      │   OnRamp / OffRamp / CCVs     │  (mint on receive)   │
│  (mint on receive)   │                              │                      │
└──────────────────────┘                              └──────────────────────┘
```

`IBridgeable`, `bridgeMint`, `bridgeBurn` do not change. Only the counterparty that calls them does.

### `EmberTokenPool` — what Chainlink wrote

`EmberTokenPool` extends `TokenPool` and overrides only the two internal hooks. Everything else —
ramp authorisation via the Router, RMN curse checks, remote-pool verification, decimals conversion,
per-lane rate limits — is inherited.

```solidity
function _lockOrBurn(uint64 /* remoteChainSelector */, uint256 amount) internal override {
  // The onRamp has already transferred `amount` to this pool.
  IEmberVaultToken(address(i_token)).bridgeBurn(address(this), amount);
}

function _releaseOrMint(
  address receiver,
  uint256 amount,
  uint64 /* remoteChainSelector */
) internal override {
  IEmberVaultToken(address(i_token)).bridgeMint(receiver, amount);
}
```

`EmberTokenPoolFactory` deploys via CREATE2 (salt namespaced by `msg.sender`, so no squatting) and
proposes ownership to a chosen `POOL_OWNER`, who must `acceptOwnership()`. Compiled with
`evm_version = "paris"` so the bytecode avoids PUSH0/MCOPY and runs on Pharos.

The pool is **immutable** — no proxy. Replacing it means a fresh deploy plus
`TokenAdminRegistry.setPool` plus `setVaultBridgeAdapter`. A deliberate departure from our
proxy-behind-Timelock convention, and the right call for a contract this small.

### How the pool's security model works

The pool holds almost no trust of its own. Every meaningful check lives in `_validateLockOrBurn` /
`_validateReleaseOrMint`, which is why the source calls them "essential" — overriding the external
entrypoints without calling them is the standard way to get drained.

Both legs: token binding (`isSupportedToken` against the immutable `i_token`), lane must be
configured (`isSupportedChain`), caller must be a live ramp, RMN curse check, and a per-lane
per-direction token-bucket rate limit.

The ramp check is the crux — the pool keeps no ramp allowlist of its own, it asks the **Router** on
every call (`s_router.getOnRamp(selector)` outbound, `s_router.isOffRamp(selector, msg.sender)`
inbound). So a CCIP ramp upgrade needs no pool change, and whoever controls `setRouter` (owner-only)
controls who can mint. That is the most privileged function on the contract.

Outbound only: an optional sender allowlist, whose enable flag is immutable at construction.

Inbound only, and most important: `isRemotePool(remoteChainSelector, sourcePoolAddress)`. The source
pool must be explicitly registered by the owner. Without it, a message routed from any chain could
mint. It's a _set_ per lane, so far-side pool migrations can be staged.

The pool explicitly distrusts `sourcePoolData` and `offchainTokenData`, and `_calculateLocalAmount`
reverts `OverflowDetected` rather than wrapping, rounding **down** when scaling so a remote chain can
never cause more to be minted than it sent. `LockOrBurnOutV1.destTokenAddress` is returned but never
trusted by the destination, which resolves the local pool through `TokenAdminRegistry.getPool`.

### Deltas we need on top of their pool

1. **Blacklist enforcement — required.** `EmberVault.bridgeBurn` enforces
   `protocolConfig.isAccountBlacklisted(from)`, but under CCIP `from` is the pool, so the check is
   dead: a blacklisted holder can move shares off the origin chain. The vault has no transfer-level
   blacklist (`EmberVault` has no `_update` override), so the user→pool transfer is unrestricted too.
   Fix by checking `isAccountBlacklisted(lockOrBurnIn.originalSender)` in an override of the external
   `lockOrBurn`, where the `Pool.LockOrBurnInV1` struct is in scope. This restores parity with the LZ
   adapter, where `bridgeBurn(_from = user)` caught it naturally.
2. **An event carrying `originalSender` — optional now.** Revision 2 made this required for
   attribution. On 2.0.0, `CCIPMessageSent.sender` is the real user and is indexed, so indexing the
   OnRamp gets us the same thing with no contract change. Still worth emitting if we want the pool's
   own logs to be self-sufficient; not worth blocking on.
3. **A CCV declaration — decide.** See [Verification](#verification-ccvs-and-what-our-pool-declares).

Decide explicitly: **fork vs. depend.** Vendoring `EmberTokenPool` into this repo puts it under our
CI, audit scope and deploy scripts, which is where the rest of the system lives. We're modifying it
for (1) anyway. Recommend fork, credited upstream.

### Vault-side changes

**None.** Revision 1 proposed widening `bridgeAdapter` to a mapping so LZ and CCIP could co-exist.
Revision 2 settled on **Option A, the hard cutover**, and that stands:

- Option B costs an `EmberVault` + `EmberETHVault` implementation upgrade on two chains, a UUPS
  storage-layout migration, an `EmberProtocolConfig` surface change and a re-audit — weeks, for one
  token on one lane.
- Sui was the argument for Option B. pALPHA has no Sui lane.
- Rollback under A is one `setVaultBridgeAdapter` Timelock op with the LZ adapter left
  deployed-and-paused — a 12h RTO on an already-drained bridge.
- It is also the configuration Chainlink wrote tests against.

`min/maxBridgeAmount`: **keep as defence in depth.** They now bound the per-CCIP-message amount
rather than the per-user-call amount, which is the same granularity in practice.

The cutover call is `EmberProtocolConfig.setVaultBridgeAdapter(vault, pool)`, gated by
`onlyAdmin(caller)` where `roles.admin` is the **admin Timelock
`0x3BCbDEE23B83a05464Cb8c9Bef63862aA282790c`, minDelay 43200s (12h)**. So Chainlink's "one
transaction" cutover is really a 12h queued operation, run independently per chain — **not atomic
across the lane.**

### Version bumps

- `EmberVault`, `EmberETHVault`, `EmberProtocolConfig`, `EmberDepositParkingLot`,
  `EmberVaultValidator` — **all unchanged.**
- New: `EmberTokenPool v1.0.0` (`typeAndVersion() = "EmberBurnMintTokenPool 1.0.0"`),
  `EmberTokenPoolFactory v1.0.0`.

No storage-layout work, no upgrade validation, no vault audit. That is the main practical dividend of
Option A.

## Verification: CCVs, and what our pool declares

This is the largest architectural change from 1.6.x and it needs a decision before deployment.

1.6.x had a fixed pipeline: the DON commits a merkle root, RMN blesses it, the OffRamp verifies
against it. **2.0.0 replaces that with pluggable Cross-Chain Verifiers.** `executeSingleMessage`
calls `_ensureCCVQuorumIsReached(...)` and then invokes each verifier's `verifyMessage`. The required
and optional CCV sets are sourced from the receiver _and_ **from the token pool**, via
`IPoolV2.getRequiredCCVs(token, selector, amount, finality, extraData, direction)`.

So in 2.0.0 a pool can mandate which verifiers must attest to messages carrying its token.

**Ours mandates none.** `TokenPool.getRequiredCCVs` returns an empty array when
`s_advancedPoolHooks == address(0)`, and Chainlink's deploy script passes `address(0)`. The OffRamp
then falls back to the chain's default CCV set — deliberately, per the source:

> If the pool does not specify any CCVs [...] any pool not specifying CCVs would allow any arbitrary
> CCV to mint infinite tokens by fabricating messages. Since CCVs are permissionless, this would mean
> anyone would be able to mint.

The fallback is safe, not a hole. But it means **as written, our pool inherits whatever the chain's
defaults are and cannot pin them.** For a yield-bearing vault share, "who is allowed to attest that a
mint should happen" is a question we should answer deliberately rather than inherit. Pinning a set
requires deploying an `advancedPoolHooks` contract — which is also the hook point for an
allowlist, so it may be worth having regardless.

Everything else in the OffRamp's own defence still applies: RMN curse check, source chain enabled, an
onRamp-hash allowlist (`s_allowedOnRampHashes`), the message's declared offRamp must equal the
executing contract, and `destChainSelector` must match the chain.

## Event parity: the pool is not a drop-in for the indexer

`EmberTokenPool` declares and emits **no events of its own**. It inherits `LockedOrBurned` and
`ReleasedOrMinted` from `TokenPool`, and **those two are byte-identical between 1.6.1 and 2.0.0**:

```solidity
event LockedOrBurned(
  uint64 indexed remoteChainSelector,
  address token,
  address sender,
  uint256 amount
);
event ReleasedOrMinted(
  uint64 indexed remoteChainSelector,
  address token,
  address sender,
  address recipient,
  uint256 amount
);
```

Neither carries a message id, and `sender` is `msg.sender` — the onRamp and offRamp respectively,
**never the user**. That last point is a silent-corruption trap: `sender` has the same name as
`OFTSent.fromAddress` and a completely different meaning.

| LZ field                            | CCIP pool equivalent                                | Verdict                                         |
| ----------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `OFTSent.guid` / `OFTReceived.guid` | —                                                   | Missing from the pool. Lives on the ramps.      |
| `dstEid` / `srcEid`                 | `remoteChainSelector` (indexed)                     | Present. Chain selectors, not eids.             |
| `OFTSent.fromAddress` = the user    | `LockedOrBurned.sender` = the onRamp                | **Same name, wrong value.**                     |
| `OFTReceived.toAddress`             | `ReleasedOrMinted.recipient`                        | Present and correct.                            |
| `amountSentLD` (gross)              | —                                                   | On the ramp (`tokenAmountBeforeTokenPoolFees`). |
| `amountReceivedLD`                  | `LockedOrBurned.amount` / `ReleasedOrMinted.amount` | Present.                                        |

`adapterId` in the backend comes from the log's contract address, so the pool address slots straight
in. Secondary loss: OFT indexes `guid` and the user address on the adapter; the pool events index only
`remoteChainSelector`, so per-user filtering has to move to the ramp events.

The LZ adapter's `Paused`/`Unpaused` are not indexed today, so no backend impact — but note the pool
has no pause. The CCIP kill switches are the RMN curse, per-lane rate limits, and removing the lane
via `applyChainUpdates`.

### The vault-side events also degrade

The listener subscribes to `BridgeMint` and `BridgeBurn` on every vault, and those drive per-account
share accounting. Under CCIP:

- `BridgeMint(to = receiver)` — **correct**, `to` is the real user.
- `BridgeBurn(from = pool)` — **wrong**. `_lockOrBurn` burns the pool's own balance.

`bluefin-vaults-service` `ProcessBridgeBurnEvent` writes an `account_transactions` row with
`OwnerAddress = ReceiverAddress = event.GetFromAddress()`, type `bridge_out`, and the analytics
pipeline then debits `shares_balance` / `basis_principal` from that address. With `from = pool`:

- the real user's shares are **never debited** on the origin chain;
- the destination `BridgeMint` credits the real user correctly, so **shares are double-counted
  globally**;
- a phantom account keyed to the pool address is created, hits the `shares balance is zero on
BridgeOut` branch and is flagged `OUT_OF_SYNC` on every bridge-out;
- `realized_yield_total` and `basis_principal` on that row are meaningless.

There is no fallback signal from the vault: the user→pool leg is a plain ERC-20 `Transfer`, and the
listener's config is `{contract address, event name}`-scoped with no `Transfer` subscription anywhere.

**Fix:** make `ProcessBridgeBurnEvent` pool-aware — when `from` is a configured pool address, update
`total_shares_in_circulation` only and skip the `account_transactions` insert. The user-level
`bridge_out` row comes from the OnRamp event instead.

## Correlating send and receive

The pool events can't do it. The message id and the user both live on the **ramp** contracts — and in
2.0.0 both are indexed on both legs, which is what makes this straightforward.

```solidity
// OnRamp (source), v2.0.0
event CCIPMessageSent(
  uint64 indexed destChainSelector,
  address indexed sender, // the real user
  bytes32 indexed messageId,
  address feeToken,
  uint256 tokenAmountBeforeTokenPoolFees, // gross, pre pool fee
  bytes encodedMessage,
  Receipt[] receipts,
  bytes[] verifierBlobs
);

// OffRamp (destination), v2.0.0
event ExecutionStateChanged(
  uint64 indexed sourceChainSelector,
  uint64 indexed messageNumber,
  bytes32 indexed messageId,
  Internal.MessageExecutionState state,
  bytes returnData
);
```

`messageId` is `keccak256(encodedMessage)`. **Key `ccip_messages` on `message_id`** — the direct
`guid` analog, indexed on both sides.

Three consequences worth calling out:

1. **`CCIPMessageSent.sender` is the real user, indexed.** This is what makes the custom pool event
   optional, and it is the correct source for the `bridge_out` account transaction.
2. **`tokenAmountBeforeTokenPoolFees` closes the gross/net gap.** It maps to `amountSentLD`;
   `LockedOrBurned.amount` maps to `amountReceivedLD`.
3. **`ExecutionStateChanged.state` gives explicit failure**, which LZ never did — we inferred
   stuck-ness purely from absence. See the next section.

**These are different contracts, not the pool.** `CCIPMessageSent` is emitted by the OnRamp,
`ExecutionStateChanged` by the OffRamp, `LockedOrBurned`/`ReleasedOrMinted` by the pool. Same
transaction, three different log addresses. Since the listener filters on `{address, event names}`,
subscribing to the pool alone yields no ids and no user — the ramp addresses must be added as their
own config entries.

Do **not** plan on `Router.MessageExecuted` as a destination-side fallback: `executeSingleMessage`
short-circuits before the Router for token-only transfers (empty data, zero receive gas limit, or a
receiver that isn't a contract implementing `IAny2EVMMessageReceiver`). A share transfer to an EOA
hits all three. `ExecutionStateChanged` is the only destination source of `messageId`.

Revision 2 floated smuggling a correlation nonce through `destPoolData` (and raising
`destBytesOverhead`). **Dropped** — indexing the ramps is strictly better and needs no Chainlink
sign-off.

Two operational wrinkles that make this worse than the LZ setup, where one adapter address gave both
legs:

- **Volume.** The ramps are shared per chain — one OffRamp serves every inbound lane. So
  `ExecutionStateChanged` fires for every CCIP message arriving on Ethereum, not just ours. Filter in
  the listener's mapper before Kafka: source side on whether the message's token transfer references
  the vault address, destination side by pairing against our pool's logs in the same transaction.
- **Address churn.** Ramp addresses change on CCIP upgrades, and they're per-lane from the Router's
  view (`Router.getOnRamp(destChainSelector)`, `Router.isOffRamp(...)`). Resolve them from the Router
  at deploy time rather than hardcoding, and **add a startup assertion that the configured ramp
  addresses still match what the Router reports.** This matters: under LZ, a stale peer config broke
  sends visibly. Here, a stale OffRamp address in listener config breaks nothing on-chain — transfers
  keep working while the backend silently stops seeing them.

## When the mint side fails

If `bridgeMint` reverts on the destination, the message lands in `FAILURE`, nothing is minted, the
source-chain burn has already happened — and it stays replayable indefinitely. **Funds are stranded,
not lost.**

Path: the pool call is a `try/catch` in `_releaseOrMintSingleToken`, rethrown as
`TokenHandlingError(localToken, err)`, bubbling to `executeSingleMessage`, which runs inside
`_callWithGasBuffer`. That reserves `i_maxGasBufferToUpdateState` specifically so an out-of-gas
failure can still record state. The result is
`ExecutionStateChanged(..., state = FAILURE, returnData = err)` — **the revert reason is on-chain**,
so alerting can surface _why_.

Retry in 2.0.0 is `execute(encodedMessage, ccvs, verifierResults, gasLimitOverride)`, which is
**fully permissionless** — there is no separate `manuallyExecute` any more. States live in
`s_executionStates[messageId]`; `UNTOUCHED` and `FAILURE` may execute, and retrying a `FAILURE` that
fails again reverts `NoStateProgressMade(messageId, err)` so the caller learns without consuming the
attempt.

| Cause                                                   | Recoverable?      | How                                                  |
| ------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| Pool isn't the vault's `bridgeAdapter` (cutover window) | Yes               | Re-authorize via the 12h Timelock, then re-`execute` |
| Inbound rate limit exceeded                             | Yes, self-healing | Bucket refills, then re-`execute`                    |
| RMN curse on the lane                                   | Yes               | Blocked until uncursed                               |
| Required CCV quorum not met                             | Yes               | Re-`execute` with the right attestations             |
| Out of gas                                              | Yes               | Re-`execute` with more gas                           |

**This makes the cutover strictly safer than LayerZero.** Under LZ, an in-flight `lzReceive` landing
after we repoint `bridgeAdapter` reverts in `bridgeMint` and LZ retries the same failing payload
forever. Under CCIP the message parks in `FAILURE` with the reason on-chain and replays cleanly once
the pool is re-authorized.

**The backend rule that falls out of this, and it would corrupt accounting if missed:** the same
`messageId` can emit `ExecutionStateChanged` twice — `FAILURE`, then later `SUCCESS`. The upsert must
be idempotent with last-write-wins on state, and **`bridge_in` must only be written on `SUCCESS`**.
Get that wrong and a retried transfer credits the user twice. LZ never produced this state.

### Notes on 1.6.x, if that's what's deployed

Three behaviours differ and would change the above:

- **Per-token gas budget.** 1.6.x calls the pool through `CallWithExactGas` with the message's
  `destGasAmount`, so an under-provisioned value fails every inbound transfer. Recovery is
  `manuallyExecute` with `tokenGasOverrides` (which must be **≥** the original). 2.0.0 removed this
  entirely — the pool call gets all remaining gas, and `gasLimitOverride` applies only to
  `ccipReceive`. **If the chains run 1.6.x, we must measure worst-case `bridgeMint` gas** (it is not a
  bare `_mint`: `nonReentrant` + `_chargeAccruedPlatformFees()` + external config reads + a six-field
  event) and get `destGasAmount` configured with headroom.
- **Strict balance-delta assertion.** 1.6.x reverts `ReleaseOrMintBalanceMismatch` unless
  `balancePost - balancePre == localAmount`. We pass — `_chargeAccruedPlatformFees` only increments
  `platformFee.accrued`, it does **not** mint shares, so the receiver's delta is exactly `amount`.
  Worth a regression test pinning that, because moving to a share-minting fee model would break every
  inbound transfer on 1.6.x. 2.0.0 uses the delta to _compute_ the reported amount instead of
  asserting, so the hazard is version-specific.
- **Event shapes.** 1.6.1's `CCIPMessageSent` carries `(destChainSelector, sequenceNumber, message)`
  with `messageId` unindexed inside the struct, and no `sender` or gross-amount field. On 1.6.x the
  correlation key should be `(lane, sequenceNumber)` — indexed on both events — and the real user has
  to be decoded out of `message.sender`.

## Pool configuration decisions

**Roles.** `TokenPool` separates `owner`, `rateLimitAdmin` and `feeAdmin`
(`DynamicConfigSet(router, rateLimitAdmin, feeAdmin)`). If `POOL_OWNER` is a Timelock, every
`applyChainUpdates` and rate-limit change is a delayed op — wrong for incident response. Recommend
`POOL_OWNER` = admin Timelock `0x3BCbDEE…` (12h), `rateLimitAdmin` = ops multisig. Lane config is done
pre-cutover, so a slow owner is fine there.

**Fees are charged in vault shares.** `TokenPool.lockOrBurn` in 2.0.0 computes `feeAmount` from
`s_tokenTransferFeeConfig[selector].finalityTransferFeeBps` (or the fast-finality variant) and burns
only `amount - feeAmount`. The fee **stays on the pool as a pALPHA balance**, swept later by
`withdrawFeeTokens` — a plain `Transfer` the listener doesn't index. Those shares remain in
`totalSupply`, so they are counted in `total_shares_in_circulation` and attributed to no account.

Set `finalityTransferFeeBps = fastFinalityTransferFeeBps = 0` for pALPHA on both lanes and assert it
in the deploy/verify script. (1.6.x has no pool-level fee at all, so this is a 2.0.0-only concern.)

**Fast finality.** 2.0.0 adds a fast-finality path with its own fee bps and its own inbound/outbound
rate limits. Not needed for v1; worth knowing it exists as a product lever later.

## CCIP registration and per-chain wiring

Per chain:

1. **Deploy** the pool through `EmberTokenPoolFactory`, then `acceptOwnership()` from `POOL_OWNER`.
2. **Register the administrator.** `RegistryModuleOwnerCustom.registerAdminViaOwner(token)` calls
   `_registerAdmin(token, IOwner(token).owner())` and reverts unless `admin == msg.sender`. So the
   **owner Timelock `0x12917E06b55995e7a5D73681cE491774C73b7C6a` (minDelay 86400s / 24h) must be the
   caller**, and it becomes the token admin.
3. **`TokenAdminRegistry.acceptAdminRole()`** from that admin.
4. **`TokenAdminRegistry.setPool(token, pool)`** from that admin.

Steps 2–4 are sequential but atomic-safe, so OZ `TimelockController.executeBatch` does all three in
**one 24h proposal per chain** — `ember-utils` already has a `timelock-proposal` flow. Also settles
revision 1's front-running question: `registerAdminViaOwner` can only ever install `owner()`.

5. **`pool.applyChainUpdates([...])`** per lane: `{ remoteChainSelector, outboundRateLimiterConfig,
inboundRateLimiterConfig, remotePoolAddresses, remoteTokenAddress }`. Owner-gated.
6. **Enable the lane at the Router** if it isn't already.

## Fees at send time

CCIP fees are paid **at `Router.ccipSend` time** in LINK or the destination chain's native token. A UX
change from LZ, where the adapter internally billed a `MessagingFee`.

- **User pays.** Cleanest, but assumes users hold LINK — most don't.
- **Sponsored wrapper.** Accepts shares plus a small native fee, buys LINK in-tx, forwards to
  `ccipSend`. Non-trivial slippage / oracle risk.
- **Frontend prompts a LINK top-up.** Fine for operator flows, ugly for end users.

Unresolved. See Q5.

## Off-chain changes: the bulk of the work

The contract work is a small delta on an audited pool. The real cost is off-chain, and **all of it
must ship before cutover** so the pool emits into a listener that already understands it.

| Repo                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared-libs/protobuf-messages`       | New `CcipMessageSentEvent` / `CcipExecutionStateChangedEvent` in `proto/vaults/v2/chain_events.proto` (`message_id`, `source`/`dest_chain_selector`, `message_number`, `sender`, `amount_gross`, `state`, `return_data`, `pool_id`), added to the `ChainEventsV2` oneof at new tags — 42/43 are `oft_*`, 44/45 `bridge_*`, so 46/47. `make generate`, commit stubs. Keep the OFT messages for history.       |
| `evm-chain-events-listener`           | Add ABIs and config entries for the **OnRamp** (`CCIPMessageSent`), **OffRamp** (`ExecutionStateChanged`) and **pool** (`LockedOrBurned`, `ReleasedOrMinted`) on both chains. Filter non-Ember messages in the mapper before publishing. Assert configured ramp addresses against the Router at startup. **Never map `LockedOrBurned.sender` / `ReleasedOrMinted.sender` to a user field** — they are ramps. |
| `bluefin-vaults-service` — DB         | New Liquibase changeset: `ccip_messages` keyed on `message_id`, mirroring `oft_messages`, plus an execution-state column. Prefer a new table and a union view over generalising `oft_messages`, so historical LZ rows stay untouched and the stuck-message query stays one query.                                                                                                                            |
| `bluefin-vaults-service` — service    | Handlers for the two new events. **Only write `bridge_in` on `state == SUCCESS`**, and make the upsert idempotent across `FAILURE → SUCCESS`. Make `ProcessBridgeBurnEvent` pool-aware. Split the stuck-message gauge into _in-flight past threshold_ and _state == FAILURE_, the latter being newly possible and directly actionable. Update `StuckOftMessagesDetected`, which names LayerZero in its text. |
| `bluefin-vaults-service` — config/API | Add `EvmContracts.ccipTokenPools` (pool, router, rmnProxy, onRamp, offRamp, local chain selector, remote pools/selectors, rate limits, fee token) alongside `oftAdapters`; regenerate `server.gen.go`. Add addresses to `environment-stack/*/evm-config.json` for both chains. `bridgeAdapter` / `bridgeAdapterUpdatedAt` need no schema change — just a new value.                                          |
| `ember-sdk`                           | `bridgeSendToken` approves the OFT adapter and calls `bridgeSend` on it (`src/evm-vaults/on-chain-calls/user.ts:856`, `tx-builder.ts:1310`). Add a CCIP path: approve the **Router**, `Router.getFee` for the quote, `Router.ccipSend`. Regenerate the v2 API models.                                                                                                                                        |
| `ember-vaults-ops`                    | Bridge dashboards and runbook: LZ peer/DVN checks become CCIP lane, rate-limit, RMN-curse and CCV checks. Add a "replay a FAILED message" runbook entry — `execute` is permissionless, so ops can do this unilaterally.                                                                                                                                                                                      |
| `frontend`                            | Fee UX per the section above.                                                                                                                                                                                                                                                                                                                                                                                |

What survives unchanged: `BridgeMint` handling, `total_shares_in_circulation`, the `bridge_in` /
`bridge_out` account-transaction types and all the analytics maths, and the vault-config bridge fields.

## Migration phases

**Phase 0 — unblock.** Pharos CCIP status (blocking). Which CCIP contract generation is deployed on
each chain. The CCV default question. Then the rest of the Q&A.

**Phase 1 — contracts.** Fork `EmberTokenPool` in. Add the blacklist check on `originalSender`;
decide on the `originalSender` event and the CCV declaration. Port
`test/EmberVaultMintBurnOFTAdapter.test.ts`'s scenario set. Add lane fork tests. Targeted audit of the
delta, not a full engagement.

**Phase 2 — off-chain, ahead of any deployment.** The whole table above. Verify on staging against a
testnet lane that a round trip produces exactly one `bridge_out` row keyed to the real user and one
`bridge_in`, that `shares_balance` nets to zero drift, and — deliberately force a failure — that a
`FAILURE` then `SUCCESS` on the same `messageId` produces exactly one `bridge_in`.

**Phase 3 — deploy and wire, LZ still live.** Deploy via the factory on both chains;
`acceptOwnership` from the admin Timelock; `applyChainUpdates` both directions with conservative rate
limits; set `rateLimitAdmin`; one batched 24h Timelock proposal per chain for register → accept →
`setPool`; assert zero fee bps. Nothing is live — the pool has no mint rights until phase 4.

**Phase 4 — cutover, per chain, sequential.** Queue `setVaultBridgeAdapter(vault, pool)` on the admin
Timelock (12h). Before executing: pause the LZ adapter (`EmberVaultMintBurnOFTAdapter` is `Pausable`),
wait past the maximum observed LZ delivery latency, and **gate on `oft_stuck_messages == 0` on both
chains** — `CountStuckOftMessagesByChain` is already exactly that query, wired to a gauge and an
alert. Then execute, run an operator-only test transfer, and flip the frontend/SDK to `ccipSend`.

**Phase 5 — burn-in and sunset.** Two weeks with the LZ adapter deployed and paused as the rollback
path. Then move `scripts/bridge/*.ts` to `scripts/bridge/legacy/`; drop the LZ dependency in a later
major bump. `oft_messages` stays for history.

## Rollback

- **Phase 3:** `TokenAdminRegistry.setPool(token, address(0))`. The pool never had mint rights; zero
  user impact.
- **Phase 4:** `setVaultBridgeAdapter(vault, lzAdapter)` and unpause the adapter — one queued Timelock
  op per chain, 12h. Drain CCIP first, symmetrically to the cutover.
- **Phase 5:** same as phase 4 while the adapter is still deployed. After the LZ dependency is dropped
  from the codebase, rollback means a redeploy — which is why the burn-in comes first.

## Test plan

- Port the LZ adapter test scenarios to the pool: auth failures, min/max amount, decimals,
  remote-pool checks.
- New tests for the deltas: blacklisted `originalSender` reverts; if we emit it, the event carries the
  real user on both legs.
- Lane-level fork tests, ethereum ↔ pharos both directions.
- **Failure/replay test:** force `bridgeMint` to revert (de-authorize the pool), assert `FAILURE` with
  the reason in `returnData`, re-authorize, re-`execute`, assert `SUCCESS` — and assert the backend
  wrote exactly one `bridge_in`.
- If the chains run 1.6.x: gas snapshot on worst-case `bridgeMint`, asserted against the configured
  `destGasAmount`, plus a test pinning that fee accrual does not mint shares.
- No storage-layout or upgrade-validation work — the vaults don't change.

## Open questions for Chainlink

Revision 1's Q1, Q2, Q3, Q6, Q7 and Q12 were answered by the pool repo and the contracts. Revision
2's `destGasOverhead` and `destPoolData`-nonce questions are dropped — both are moot on 2.0.0.

1. **Pharos.** Is Pharos (chainId 1672) live on CCIP — Router, RMN, and an ethereum lane? Timeline if
   not? pALPHA's only lane is ethereum ↔ pharos, so this gates everything.
2. **Deployed contract generation.** Which CCIP version is live on ethereum and pharos — 1.6.x or
   2.0.0? Our indexing design and the destination gas question both depend on it. If 1.6.x, what's the
   upgrade path and timeline?
3. **CCVs.** What is the default CCV set on each chain, who controls it, and do you recommend a token
   like this pin its own set via `advancedPoolHooks` rather than inheriting the default?
4. **Transfer fee in shares.** Confirm zero `finality`/`fastFinalityTransferFeeBps` is the right
   posture for a yield-bearing vault share.
5. **Fee UX.** Any supported paymaster / gas-abstraction pattern for users holding only the share
   token, or is a fee-sponsorship wrapper the expected build?
6. **Rate limits.** Starting `capacity` and `rate` for a pool over a vault in the $5M–$50M TVL band?
7. **Replay in practice.** `execute` is permissionless in 2.0.0 — in practice, does the Chainlink
   Executor retry a `FAILURE` automatically, or is replay entirely on us once a message has failed
   once? What's the expected operator workflow and SLA?
8. **Latency.** Typical end-to-end for ethereum ↔ pharos, both directions.
9. **Cross-chain vault adapter** (phase 3 of their README) — Chainlink-side deliverable or ours? Out
   of scope for this migration either way, but worth agreeing ownership.

## Deliverables sequence, once Q&A is resolved

1. **This RFC.**
2. **PR:** `EmberTokenPool` forked in, with the blacklist delta and the ported test suite.
   Independently reviewable.
3. **PR (protobuf-messages):** the new event pair. Unblocks the listener and the service in parallel.
4. **PR (listener) + PR (vaults-service):** ramp + pool indexing, the pool-aware `BridgeBurn` fix, the
   `ccip_messages` table with execution state, the config/API surface. Must land and be verified on
   staging before phase 3.
5. **PR (this repo):** CCIP deploy and wiring scripts — factory deploy, the batched Timelock
   registration proposal, `applyChainUpdates`, a `quote`/`send` pair, and a `verify-lanes` analogue of
   `verify-peers`.
6. **PR (ember-sdk):** the `ccipSend` path.
7. **PR:** sunset — pause the LZ adapter, move `scripts/bridge/*` to `legacy/`. Opens after the
   two-week burn-in.

## Appendix: what NOT to change

- `IBridgeable`. The interface already matches what CCIP needs.
- `EmberVault`, `EmberETHVault`, `EmberProtocolConfig` — no changes under Option A.
- The vault's mint / burn logic. Only the counterparty calling them changes.
- `EmberDepositParkingLot`, `EmberVaultValidator`, `AtomicLiquidity` — none touch the bridge.
- Sui-side receipt token modules — out of scope. pALPHA has no Sui lane; if CCIP adds Sui and we want
  one, that's a separate RFC, and it is the one case that would revive the Option B adapter-set
  proposal.
