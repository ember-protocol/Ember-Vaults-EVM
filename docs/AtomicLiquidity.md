# AtomicLiquidity Vault

`AtomicLiquidity.sol` is a sibling vault to `EmberVault.sol` that adds two capabilities the standard vault deliberately omits:

1. **Instant exit** for the vault's own depositors (capped, fee'd).
2. **Fast-lane swap** for holders of *other* EmberVault receipt tokens — they hand AtomicLiquidity their EmberVault shares and walk away with collateral immediately, while AtomicLiquidity claims the slow settlement from that EmberVault on their behalf.

To support both, deposits can be parked in an external ERC-4626 strategy (e.g. a MetaMorpho vault on Morpho) by the operator, with auto-pull on payout when the vault's idle balance is short.

This document is the canonical reference for how the contract behaves and how to operate it.

---

## Table of Contents

- [Design at a Glance](#design-at-a-glance)
- [Differences from EmberVault](#differences-from-embervault)
- [Roles and Access Control](#roles-and-access-control)
- [State Variables](#state-variables)
- [Pricing and Rate Model](#pricing-and-rate-model)
- [Strategy Integration](#strategy-integration)
- [User Flows](#user-flows)
  - [Deposit](#deposit)
  - [Request-Based Redeem](#request-based-redeem)
  - [Instant Withdraw (own shares)](#instant-withdraw-own-shares)
  - [Cross-Vault Swap (EmberVault shares)](#cross-vault-swap-embervault-shares)
- [Operator Flows](#operator-flows)
  - [Strategy Supply / Withdraw](#strategy-supply--withdraw)
  - [Process Withdrawal Requests](#process-withdrawal-requests)
  - [Redeem Collected EmberShares](#redeem-collected-embershares)
  - [Release Users Holdback](#release-users-holdback)
  - [Supply to Sub-Account](#supply-to-sub-account)
  - [Collect Platform Fee](#collect-platform-fee)
- [Admin Flows](#admin-flows)
- [Rate Manager Flow](#rate-manager-flow)
- [API Reference](#api-reference)
- [Events](#events)
- [Errors](#errors)
- [Pause Semantics](#pause-semantics)
- [Operational Runbook](#operational-runbook)
- [Security Considerations](#security-considerations)
- [Deployment and Upgrades](#deployment-and-upgrades)

---

## Design at a Glance

```
Depositors ─── deposit ───────────────► AtomicLiquidity ─── supplyToStrategy ────► ERC-4626 Strategy
                                          │   ▲                                        │
                                          │   └──────── withdrawFromStrategy ──────────┘
                  redeemShares (queued)   │
Depositors ◄──── processWithdrawalRequests│
                                          │
                  instantWithdraw (capped)│
Depositors ◄──── (auto-pull from strategy if short)

EmberVault holders ── swapEmberShares ──► AtomicLiquidity ── redeemCollectedEmberShares ──► EmberVault
                  ◄ (immediate net pay)   │                                                    │
                                          │                                                    │
                  releaseUsersHoldback    │  ◄────────── (eventual collateral) ────────────────┘
EmberVault holders ◄────────────────────  │
```

**Two share concepts you must keep separate** when reading this doc:

- **AL shares** — internal balance on `AtomicLiquidity` itself. *Non-transferable.* No ERC-20 token. Tracked in `shareOf[user]`. Created by `deposit`. Burned by `redeemShares` (queued) or `instantWithdraw` (immediate, capped).
- **EmberVault shares** — the ERC-20 receipt token of a separate `EmberVault` contract. Whitelisted EmberVaults can have their shares swapped at AtomicLiquidity in exchange for collateral via `swapEmberShares`. AtomicLiquidity later submits these collected shares back to the originating EmberVault for redemption.

---

## Differences from EmberVault

| Aspect | `EmberVault` | `AtomicLiquidity` |
|---|---|---|
| Inheritance | `ERC4626Upgradeable`, `ERC20Upgradeable` (transferable receipt token) | No ERC-20/ERC-4626. Internal `mapping(address => uint256) shareOf`. Shares **non-transferable**. |
| Bridging (`IBridgeable`) | Yes — supports OFT mint/burn | No — there is no token to bridge |
| Strategy | None (collateral idle) | ERC-4626 strategy with operator-controlled supply/withdraw |
| Instant exit | No — request-only | `instantWithdraw` with cumulative cap and fee |
| Cross-vault swap | No | `swapEmberShares` for whitelisted EmberVaults |
| Rate-based pricing | Yes | Yes (identical math) |
| Request-based redeem | Yes | Yes (identical queue + cancel + process flow) |
| Platform-fee accrual | Time-based on TVL | Time-based on TVL **plus** instant-withdraw and EmberShare-swap fees folded into `platformFee.accrued` |
| Sub-accounts | `withdrawFromVaultWithoutRedeemingShares` | `supplyToSubAccount` (renamed; same semantics) |

---

## Roles and Access Control

| Role | Storage | Granted by | Capabilities |
|---|---|---|---|
| **Owner** | `OwnableUpgradeable` | Set in `initialize` | Authorizes UUPS upgrades. Can rotate `admin` (via protocol-config dispatch). |
| **Admin** | `roles.admin` | Set in `initialize`, rotated by Owner via protocol-config | All "configuration" setters. See [Admin Flows](#admin-flows). |
| **Operator** | `roles.operator` | Rotated by Admin via protocol-config | Strategy supply/withdraw, process withdrawal queue, sub-account transfers, redeem collected EmberShares, release holdback, collect platform fee. |
| **Rate Manager** | `roles.rateManager` | Rotated by Admin via protocol-config | `updateVaultRate(...)` only. |
| **Protocol Config** | `protocolConfig` | Set in `initialize` | The dispatcher for all admin-gated setters. Most setters are `onlyProtocolConfig onlyAdmin(caller)` — protocol config calls them with the original caller, who must be admin. |

Every privileged setter that flows through the protocol config takes the original caller as the first parameter and uses the `onlyAdmin(caller)` (or `onlyOwnerRole(caller)`) modifier to verify role. Direct `msg.sender`-gated methods are the operator and rate-manager methods.

---

## State Variables

### Identity & accounting

| Var | Type | Purpose |
|---|---|---|
| `_vaultName` | `string` | Display name. Read via `vaultName()`. |
| `collateralToken` | `address` | Underlying ERC-20 (e.g. USDC). Read via `asset()` for ERC-4626-style tooling. |
| `maxTVL` | `uint256` | Hard cap on `totalAssets()`. |
| `minWithdrawableShares` | `uint256` | Floor on `redeemShares` and `instantWithdraw`. |
| `totalShares` | `uint256` | All AL shares in existence. Includes shares parked while pending burn. |
| `shareOf[addr]` | `mapping` | Per-user AL share balance. |
| `pendingBurnShares` | `uint256` | AL shares parked by `redeemShares` awaiting processing. Mirrors EmberVault's `balanceOf(address(this))`. |
| `subAccounts[addr]` | `mapping` | Whitelist of sub-account targets for `supplyToSubAccount`. |

### Pricing, fees, and pause

| Var | Type | Purpose |
|---|---|---|
| `rate` | `Rate` struct | Current rate-based pricing (value, max change per update, update interval, last updated). |
| `platformFee` | `PlatformFee` struct | Accrued platform fee, last charge time, current fee %. |
| `pauseStatus` | `PauseStatus` struct | `deposits`, `withdrawals`, `privilegedOperations` flags. |
| `sequenceNumber` | `uint256` | Monotonic counter incremented on most state-changing actions. Indexed by event consumers. |

### Withdrawal queue

| Var | Type | Purpose |
|---|---|---|
| `pendingWithdrawals` | `WithdrawalRequest[]` | FIFO queue. |
| `withdrawalQueueStartIndex` | `uint256` (private) | Head pointer for efficient FIFO. |
| `accounts[addr]` | `mapping` | Per-user withdrawal-request bookkeeping (pending seq #s, cancelled seq #s, total pending shares). |

### Strategy

| Var | Type | Purpose |
|---|---|---|
| `strategy` | `IERC4626` | External yield destination (e.g. MetaMorpho vault). Address(0) when disabled. |

### Instant Withdraw (AL's own shares)

| Var | Type | Purpose |
|---|---|---|
| `maxInstantWithdrawShares` | `uint256` | **Cumulative** lifetime cap on shares that can be burned via `instantWithdraw`. Init 0 (feature disabled). |
| `cumulativeInstantWithdrawShares` | `uint256` | Running tally of shares burned this way. Monotonic. Headroom = `max − cumulative`. |
| `instantWithdrawFeePercentage` | `uint256` | 1e18 = 100%. Cap 1e18. |

### EmberShare Cross-Vault Swap

| Var | Type | Purpose |
|---|---|---|
| `emberShareConfigs[share]` | `EmberShareConfig` | Per-EmberVault config: `whitelisted`, `feePercentage`, `maxCapacityPercentage`, `holdbackPercentage`, `epochStartedAt`, `epochUsedAmount`, `maxUtilizationPercentage`, `minSwapGross`, `maxHeldValueAbsolute`, `feeMultiplierCurve` (sorted-ascending `FeeMultiplierTier[]`). |
| `_holdbackQueues[share]` | `HoldbackEntry[]` (internal) | FIFO queue of `{recipient, amount, released, createdAt, sequenceNumber}`. |
| `holdbackQueueStartIndex[share]` | `uint256` | FIFO head. Advances over contiguous fully-released entries. |
| `feeWaivedAddresses[account]` | `bool` | Per-share-owner exemption from the swap fee. |
| `holdbackWaivedAddresses[account]` | `bool` | Per-share-owner exemption from the swap holdback (no entry queued). |
| `hasActiveRedemptionHistory` | `bool` | Sticky cache flag — flips `false → true` on first `redeemCollectedEmberShares`. While false, swap utilization skips the cross-contract `source.accounts(this)` read. |
| `EMBER_SHARE_EPOCH_DURATION` | constant `24 hours` | Length of the per-share fixed (tumbling) capacity window, anchored to the epoch's first swap. |

### Vault validator

| Var | Type | Purpose |
|---|---|---|
| `vaultValidator` | `IEmberVaultValidator` | Optional. If set, called on `deposit` to check allow-list and timestamp the deposit (used by EmberVault for time-based withdrawal fees, but the validator hook fires here too if configured). |

---

## Pricing and Rate Model

AtomicLiquidity uses the same rate-based math as EmberVault:

- `convertToShares(assets) = assets × rate / 1e18`
- `convertToAssets(shares) = shares / rate × 1e18`  *(floor)*
- `totalAssets() = totalShares / rate × 1e18`

`rate` is **set externally by the rate manager** via `updateVaultRate(newRate)`. The rate manager is expected to run an off-chain oracle that prices the vault's actual position (idle balance + strategy holdings + outstanding EmberVault redemptions) and bumps `rate` accordingly. The rate change per update is bounded by `rate.maxRateChangePerUpdate` and only allowed every `rate.rateUpdateInterval` ms.

`totalAssets()` is therefore a *modeled* TVL, not a token-balance lookup. This is intentional: it lets the vault price itself even when collateral is held in a strategy or pending settlement from an EmberVault.

Platform-fee accrual uses this modeled TVL — see `_chargeAccruedPlatformFees()` for the formula (`fee = TVL × feePct × elapsedMs / 1e18 / (365·24·60·60·1000)`).

---

## Strategy Integration

`strategy` is a generic `IERC4626` address. Anything that implements ERC-4626 with the same `asset()` as `collateralToken` works — the canonical target is a MetaMorpho vault on Morpho.

- **Set via** `setStrategy(caller, newStrategy)` (admin via protocol-config). Validates `strategy.asset() == collateralToken`. Pass `address(0)` to disable. Before re-pointing, the setter **automatically drains the full residual position** from the previous strategy back into the vault (otherwise it would be orphaned — no on-chain helper reads it once `strategy` has changed). Reverts if the old strategy cannot service the full withdrawal at call time.
- **Supply via** `supplyToStrategy(assets)` (operator). Self-`forceApprove`s, then `strategy.deposit(assets, address(this))`.
- **Withdraw via** `withdrawFromStrategy(assets)` (operator). Calls `strategy.withdraw(assets, this, this)`.
- **Auto-pull**: `_ensureLiquidity(needed)` is called by `instantWithdraw`, `swapEmberShares`, and `releaseUsersHoldback`. If the vault's local balance is short of `needed`, it pulls the deficit from the strategy. If no strategy is set and balance is short, it reverts with `InsufficientBalance`.

`processWithdrawalRequests` does **not** auto-pull from strategy. The operator must pre-fund the vault via `withdrawFromStrategy` before processing the queue, or those requests revert with `InsufficientBalance`.

---

## User Flows

### Deposit

`deposit(uint256 assets, address receiver) → uint256 shares`
`depositWithPermit(uint256 assets, address receiver, uint256 deadline, uint8 v, bytes32 r, bytes32 s) → uint256 shares`

1. Settles accrued platform fees (against pre-deposit TVL).
2. Validates: protocol not paused, `pauseStatus.deposits` false, neither depositor nor receiver blacklisted, neither is a sub-account, optional `vaultValidator.validateDeposit` passes, `assets > 0`.
3. `IERC20(collateralToken).safeTransferFrom(msg.sender, this, assets)`.
4. Computes `shares = convertToShares(assets)`. Reverts on zero.
5. `shareOf[receiver] += shares; totalShares += shares`.
6. Reverts `MaxTVLReached` if `totalAssets()` now exceeds `maxTVL`.
7. Optional `vaultValidator.recordWeightedDeposit(this, receiver, oldWeight, newShares, currentTimeMs)` — the receiver-keyed, share-weighted anti-JIT clock update used by AL (see M-3). Unlike `recordDeposit` (used by EmberVault / EmberETHVault), a top-up blends the new deposit's timestamp into the receiver's existing clock by share weight rather than overwriting it — so a fresh top-up cannot make aged shares "look young" and a dust-sized deposit into someone else's address cannot reset a victim's clock.
8. Emits `VaultDeposit`.

`depositWithPermit` is identical except it calls `IERC20Permit(collateralToken).permit(...)` first to consume an EIP-2612 signature.

### Request-Based Redeem

The traditional path that mirrors EmberVault.

#### `redeemShares(uint256 shares, address receiver) → WithdrawalRequest`

1. Validates: protocol not paused, `pauseStatus.withdrawals` false, neither owner nor receiver blacklisted, `receiver != address(0)` (else `ZeroAddress` — a null receiver would later revert the transfer at processing and freeze the FIFO queue at the head), `shares ≥ minWithdrawableShares`, `shareOf[msg.sender] ≥ shares`.
2. **Parks the shares**: `shareOf[msg.sender] -= shares; pendingBurnShares += shares`. `totalShares` is unchanged at this stage.
3. Builds a `WithdrawalRequest{owner, receiver, shares, estimatedWithdrawAmount: convertToAssets(shares), timestamp, sequenceNumber}` and pushes onto `pendingWithdrawals`.
4. Updates the user's `Account` bookkeeping with the new request seq #.
5. Emits `RequestRedeemed`.

#### `cancelPendingWithdrawalRequest(uint256 requestSequenceNumber)`

Marks a sequence number cancelled in the user's `Account.cancelWithdrawRequestSequenceNumbers`. The shares are *not* returned yet — the cancellation is observed only when the request is later popped from the queue and skipped. Reverts if the sequence isn't in the user's pending list, or has already been cancelled.

#### `processWithdrawalRequests(uint256 numRequests)` *(operator)*

For each of up to `numRequests` head entries:

- **If owner/receiver blacklisted, request cancelled, or `convertToAssets(shares) == 0`**: skipped. Shares restored: `pendingBurnShares -= shares; shareOf[owner] += shares`.
- **Otherwise**: validator's withdrawal fees (if any) are deducted from the gross amount. Shares burned: `pendingBurnShares -= shares; totalShares -= shares`. Reverts the *whole call* with `InsufficientBalance` if the vault doesn't have enough collateral on hand. Otherwise transfers `net` to receiver.

Accrued time-based platform fees are charged **before** the burn loop (against the pre-burn TVL), since the shares being redeemed were under management for the whole elapsed window — charging after would price that window against the post-burn (smaller) TVL and under-collect. This matches the instant/redeem-now paths. Emits `RequestProcessed` per entry, optional `WithdrawalFeeCharged`, and one `ProcessRequestsSummary`.

### Instant Withdraw (own shares)

`instantWithdraw(uint256 shares, address receiver) → uint256 netAmount`

A **capped, fee'd, immediate** alternative to `redeemShares` for the user's own AL shares. No queue, no operator processing.

1. Validates: protocol not paused, `pauseStatus.withdrawals` false, neither owner nor receiver blacklisted, `receiver != address(0)` (else `ZeroAddress`), `shares ≥ minWithdrawableShares`, `shareOf[msg.sender] ≥ shares`.
2. **Cap check**: `cumulativeInstantWithdrawShares + shares ≤ maxInstantWithdrawShares`. The cap is **lifetime cumulative**: admin grants new headroom by raising `maxInstantWithdrawShares`. Reverts `InstantWithdrawCapExceeded` otherwise.
3. Settles accrued platform fees.
4. `gross = convertToAssets(shares); fee = gross × instantWithdrawFeePercentage / 1e18; net = gross - fee`.
5. Burns shares: `shareOf[msg.sender] -= shares; totalShares -= shares; cumulativeInstantWithdrawShares += shares`.
6. `_ensureLiquidity(net)` — auto-pulls from strategy if short.
7. Transfers `net` to receiver.
8. Adds `fee` to `platformFee.accrued`. The fee USDC stays in the vault until `collectPlatformFee` is called.
9. Emits `InstantWithdrawn`.

The fee accrues to the same `platformFee.accrued` bucket as time-based fees and is collected via the same `collectPlatformFee` call.

### Cross-Vault Swap (EmberVault shares)

The headline feature: a holder of *another* `EmberVault`'s receipt token (e.g. EmberUSDC) can swap into collateral immediately at AtomicLiquidity, instead of waiting on EmberVault's withdrawal queue.

**Lifecycle of a single swap, from a user perspective:**

1. User calls `swapEmberShares(share, shareAmount, receiver)`.
2. AL pulls the EmberVault shares from the user.
3. AL pays the user `gross − fee − holdback` collateral *immediately* (auto-pulling from strategy if needed).
4. AL queues `holdback` for batched release later.
5. *Time passes.*
6. Operator calls `redeemCollectedEmberShares(share, batchAmount)` — submits AL's collected EmberVault shares for redemption on the source EmberVault. EmberVault's operator processes that request in its own queue and eventually transfers collateral back to AL.
7. Once AL has enough collateral, operator calls `releaseUsersHoldback(share, percentage, maxEntries)` which pays out the holdback FIFO across users.

#### `swapEmberShares(address share, uint256 shareAmount, address receiver) → uint256 netAmount`

1. Validates: protocol not paused, `pauseStatus.withdrawals` false, neither owner nor receiver blacklisted, `receiver != 0`, `shareAmount > 0`.
2. Reverts `EmberShareNotWhitelisted` if `emberShareConfigs[share].whitelisted == false`.
3. **Settles accrued time-based platform fees first** (`_chargeAccruedPlatformFees`), so the swap fee booked in step 11 doesn't retroactively shrink the time-based fee base (`totalAssets() − accrued`) for the elapsed window. Mirrors `instantWithdraw`.
4. `gross = IERC4626(share).convertToAssets(shareAmount)`. Reverts on zero.
5. **Min-swap floor**: if `gross < minSwapGross` revert `SwapAmountTooSmall` (`minSwapGross == 0` disables). Blocks dust swaps that round the fee to 0 yet still queue a near-zero holdback entry (which would bloat `releaseUsersHoldback` and enable a partial-release DoS).
6. **Capacity check** (`_enforceCapacity`):
   - If `epochStartedAt > 0` and `now ≥ epochStartedAt + 24h`, reset epoch (`epochStartedAt = 0; epochUsedAmount = 0`). This is a **fixed (tumbling)** window anchored to the epoch's first swap — not a sliding/rolling window.
   - `cap = IERC4626(share).totalAssets() × maxCapacityPercentage / 1e18`.
   - If `epochUsedAmount + gross > cap`: revert `EmberShareCapExceeded`. *Hitting the cap blocks new redemptions until the fixed 24h window elapses and the epoch resets.* Because the window is fixed rather than sliding, usage straddling a boundary is not aggregated — up to ~2x the cap can be consumed across a reset (accepted: this is a coarse anti-drain throttle, not a hard short-term limit).
   - Otherwise: if `epochStartedAt == 0`, set it to `now`. Bump `epochUsedAmount += gross`.
7. **Concentration checks** on the post-swap held value of this source share (`newHeldValue = currentHeldValueInCollateral + gross`):
   - **Absolute cap**: if `maxHeldValueAbsolute != 0` and `newHeldValue > maxHeldValueAbsolute`, revert `EmberShareHeldValueCapExceeded`. This ceiling is **TVL-independent**, so it cannot be gamed by transiently inflating `totalAssets()` (deposit → swap → withdraw) to dilute the utilization ratio.
   - **Utilization cap**: `utilization = newHeldValue / totalAssets()`; if `> maxUtilizationPercentage`, revert `EmberShareUtilizationCapExceeded`. The fee-multiplier curve (below) is evaluated at this same `utilization`.
8. `fee = gross × effectiveFeePercentage / 1e18` (where `effectiveFeePercentage = feePercentage × curveMultiplier`; `0` if the owner is fee-waived); `holdback = gross × holdbackPercentage / 1e18` (`0` if the owner is holdback-waived); `net = gross - fee - holdback`.
9. `IERC20(share).safeTransferFrom(msg.sender, this, shareAmount)`. AL now holds the EmberVault shares — they will be sent for redemption later via `redeemCollectedEmberShares`.
10. If `holdback > 0`: pushes `HoldbackEntry{recipient: receiver, amount: holdback, released: 0, createdAt: now, sequenceNumber}` onto `_holdbackQueues[share]`.
11. `_ensureLiquidity(net)`, then transfer `net` to receiver. `platformFee.accrued += fee`.
12. Emits `EmberShareSwapped`.

**Notes:**
- AL must satisfy the source EmberVault's own constraints when the operator later submits the collected shares — most importantly its `minWithdrawableShares` floor. AL must not be blacklisted on the source EmberVault.
- The fee USDC only fully materializes once the source EmberVault settles back to AL. Practical recommendation: operate the vaults so AL's `platformFee.accrued` is collected only after source-side settlement.
- `setEmberShareWhitelist(false, ...)` flips `whitelisted` but leaves `epochUsedAmount`/`epochStartedAt` intact — a hot share remains rate-limited even after re-whitelisting until its window expires. Existing holdback entries are settled regardless of the current whitelist status.

#### Per-address waivers

Two independent admin-controlled allow-lists exempt specific share-OWNERS (i.e. `msg.sender` of `swapEmberShares`, **not** the receiver) from the swap's fee and/or holdback:

| Mapping | Effect when set for `account` |
|---|---|
| `feeWaivedAddresses[account] = true` | `swapEmberShares` charges `0` fee on swaps from `account`. The full fee portion goes to `account` as part of net. |
| `holdbackWaivedAddresses[account] = true` | `swapEmberShares` skips queuing a `HoldbackEntry` and pays `account` the full holdback portion immediately. |

The two flags are independent — an address can be on neither list, one, or both:

| `feeWaived` | `holdbackWaived` | Result for that user's swap |
|---|---|---|
| ❌ | ❌ | `net = gross − fee − holdback`; entry queued |
| ✅ | ❌ | `net = gross − holdback`; entry queued |
| ❌ | ✅ | `net = gross − fee`; **no** entry queued |
| ✅ | ✅ | `net = gross`; **no** entry queued |

Set via `setSwapWaiver(caller, account, feeWaived, holdbackWaived)` — admin-only via protocol-config. The same call updates both flags for the address; passing `(false, false)` removes them from both lists. Emits `SwapWaiverUpdated`.

**Important:** Waivers do NOT bypass the per-share 24h capacity cap (`maxCapacityPercentage`). The cap is a TVL guardrail on the *source* EmberVault — it protects that vault from accelerated drain — not a fee policy. A waived user still consumes the same `epochUsedAmount`.

#### Concentration cap (`maxUtilizationPercentage`)

A second cap on each whitelisted EmberShare, distinct from the per-source fixed 24h capacity window. Where `maxCapacityPercentage` protects the *source* vault (cap on flow), `maxUtilizationPercentage` protects *this* vault (cap on concentration). It caps the fraction of AL's TVL that can be held in a single source-share at any moment:

```
utilization = held_share_value_in_collateral / AL.totalAssets
```

Where `held_share_value_in_collateral` is the source-vault-rate-priced value of:
1. EmberShare tokens AL holds in its ERC-20 balance (custodied), PLUS
2. EmberShare tokens AL has already submitted for redemption on the source via `redeemCollectedEmberShares` but the source hasn't settled yet (in-flight).

`swapEmberShares` computes the POST-swap utilization (current held + this swap's gross) and reverts `EmberShareUtilizationCapExceeded` if it would exceed `maxUtilizationPercentage`.

#### Absolute held-value cap (`maxHeldValueAbsolute`)

Because `maxUtilizationPercentage` is a *fraction of AL's TVL* and a swap does not change `totalAssets()` (only deposits do), the percentage cap alone can be gamed: deposit a large amount to inflate the denominator, swap a larger-than-intended position past the cap, then withdraw the deposit (e.g. via `instantWithdraw`), leaving AL over-concentrated relative to its real TVL. `maxHeldValueAbsolute` closes this — it is a **TVL-independent** absolute ceiling (in collateral units) on `held_share_value_in_collateral + gross`, checked in the same step and reverting `EmberShareHeldValueCapExceeded`. Set `0` to disable; set both caps to enforce a percentage *and* a hard absolute limit.

The (2) in-flight portion is read from `IEmberVault.accounts(address(this))` — the source vault's public account state for AL. To avoid this cross-contract read on every swap when AL has never actually redeemed anything, AL maintains a sticky `hasActiveRedemptionHistory` flag that flips from `false → true` the first time `redeemCollectedEmberShares` fires. While `false`, the swap path skips the source-side read; once `true`, it's read on every swap.

#### Fee-multiplier curve

Each EmberShare config carries an admin-managed step-function `FeeMultiplierTier[]` (kept sorted ascending by `threshold`). At swap time the post-swap utilization is computed and the curve resolves to a multiplier (the entry with the highest `threshold ≤ utilization`); the effective fee is `baseFee × multiplier`. Empty curve or no matching tier resolves to 1× (no scaling).

```
FeeMultiplierTier {
  threshold:  utilization threshold in 1e18 fixed-point (≤ 1e18)
  multiplier: fee multiplier in 1e18 fixed-point (≥ 1e18 — fees can only go UP)
}
```

Set via `updateEmberShareFeeMultiplierTier(caller, share, threshold, multiplier, remove)`:
- `remove = false` upserts the tier (insert or update-in-place if threshold already exists).
- `remove = true` deletes the tier at `threshold`; reverts `TierNotFound` if missing. `multiplier` is ignored.

The curve is **preserved across `setEmberShareWhitelist` updates** — re-running the whitelist setter does not wipe the curve. To clear the curve entirely, call `updateEmberShareFeeMultiplierTier(..., remove = true)` for each tier (or de-list and re-list the share — but the curve still survives even de-listing).

**Worked example.** Source has rate=1, AL TVL = 10,000 USDC, base fee = 1%. Curve = `[(50%, 2×), (80%, 5×)]`:

| Pre-swap held | Swap gross | Post-swap util | Multiplier | Effective fee | Notes |
|---|---|---|---|---|---|
| 0 | 1,000 | 10% | 1× | 1% | Below first tier |
| 4,000 | 1,000 | 50% | 2× | 2% | Exactly the first threshold |
| 5,000 | 3,000 | 80% | 5× | 5% | Exactly the second threshold |

**Defense against misconfiguration.** Even though `setEmberShareWhitelist` enforces `feePercentage + holdbackPercentage ≤ 1e18`, a high multiplier can push `effectiveFee + holdback > gross`. The swap path explicitly checks this post-multiplier and reverts `InvalidPercentage` so the net subtraction can't underflow. Operators should curve-test thresholds during deployment.

**Curve introspection.** On-chain views for the curve are intentionally NOT exposed (bytecode-size budget). Off-chain consumers reconstruct the curve from `EmberShareFeeMultiplierTierUpdated` event logs.

---

## Operator Flows

### Strategy Supply / Withdraw

#### `supplyToStrategy(uint256 assets) → uint256 strategyShares`

Gated by protocol pause and `pauseStatus.privilegedOperations`. Reverts `StrategyNotSet` if no strategy. Reverts `InsufficientBalance` if vault balance is short. Self-`forceApprove`s the strategy for `assets`, then calls `strategy.deposit(assets, this)`. Emits `StrategySupplied`.

#### `withdrawFromStrategy(uint256 assets) → uint256 strategyShares`

Same gates. Calls `strategy.withdraw(assets, this, this)`. Emits `StrategyWithdrawn`.

### Process Withdrawal Requests

`processWithdrawalRequests(uint256 numRequests)` — see [Request-Based Redeem](#request-based-redeem). The operator should ensure adequate liquid balance (via `withdrawFromStrategy`) before calling, since this method does **not** auto-pull from the strategy.

### Redeem Collected EmberShares

`redeemCollectedEmberShares(address share, uint256 amount)` *(operator)*

Submits AL's collected EmberVault shares for redemption on the source EmberVault.

1. Gated by protocol pause and `pauseStatus.privilegedOperations`.
2. Validates `share != 0`, `amount > 0`, and `IERC20(share).balanceOf(this) ≥ amount`.
3. Self-`forceApprove`s `share` for `amount`, then calls `IEmberVaultRedeemable(share).redeemShares(amount, address(this))`.
4. The source EmberVault now holds a `WithdrawalRequest` from AL. Its operator processes it in its own queue. Eventually AL receives collateral via the source vault's `safeTransfer`.
5. Emits `EmberSharesRedemptionInitiated(vault, share, amount, remainingShareBalance, ...)`.

**Whitelist check is intentionally absent** — a share that was de-whitelisted after collection must still be redeemable, otherwise funds would be stranded. The operator should split large redemptions into chunks consistent with the source EmberVault's `minWithdrawableShares` floor.

### Release Users Holdback

`releaseUsersHoldback(address share, uint256 unwindingPercentage, uint256 maxEntries) → (uint256 entriesProcessed, uint256 totalReleased)` *(operator)*

**One-shot** settlement: pays each visited entry exactly `entry.amount × unwindingPercentage / 1e18` and closes the entry. At <100%, the residual is absorbed by the user as a haircut — there is no "second call" to recover the rest. Used after the source EmberVault has settled AL's outstanding redemptions, when the operator knows the final unwinding rate (typically 100%; lower only when AL needs to socialize a loss).

1. Gated by protocol pause and `pauseStatus.privilegedOperations`.
2. Validates `0 ≤ unwindingPercentage ≤ 1e18`, `maxEntries > 0`, queue not empty. `unwindingPercentage = 0` is intentionally accepted (see M-2): it is the operator's "socialise the full loss" tool — head entries are closed with payout 0 and the collateral remains for the surviving holders.
3. **Two-pass FIFO over up to `maxEntries` head entries:**
   - Pass 1: for each entry, if its `recipient` is **protocol-blacklisted**, it is **skipped** (counted in `entriesSkipped`, payout 0, holdback forfeited — see below); otherwise compute `payout_i = entry_i.amount × unwindingPercentage / 1e18` and sum into `totalReleased`. A non-skipped entry whose `payout` rounds to 0 while `amount > 0` is **auto-lifted to its full `entryAmount`** when `entryAmount ≤ dustCeiling` — the sub-precision residual is paid in full and the head advances. `dustCeiling` is computed per call from the collateral token's own decimals, `10 ** (decimals - 4)` (see `AtomicLiquidityLib.holdbackDustUnits`), so it stays right-sized regardless of collateral: 100 base units for USDC (6d, 0.0001 USDC), 1e14 for WETH (18d, 0.0001 ETH), 1e4 for WBTC (8d, ~0.0001 BTC). Tokens with fewer than 4 decimals produce `dustCeiling = 0`, which makes the branch inert — acceptable because such a token has no meaningful sub-precision "dust". This removes the previous `InvalidPercentage` revert that could freeze the queue whenever a dust-sized head entry combined with a small `unwindingPercentage` rounded to zero (a permissionless griefing vector, since the swap path lets anyone seed `amount == 1` entries). Above the dust ceiling, `payout == 0` means the operator asked for less than one unit of collateral and gets exactly that. `unwindingPercentage == 0` disables the auto-lift entirely so the socialise-full-loss path is preserved.
   - Pull liquidity once via `_ensureLiquidity(totalReleased)` (skipped if `totalReleased == 0`).
   - Pass 2: set `entry.released = payout`, transfer `payout` to `entry.recipient` (no transfer for skipped/zero entries).
4. **Head advance**: ALWAYS advances by `entriesProcessed` (including skipped entries). Each visited entry is closed in this single call. A *skip-only* batch (`totalReleased == 0` but `entriesSkipped > 0`) still advances rather than reverting; only a batch that releases nothing **and** skips nothing reverts `ZeroAmount`.
5. Emits `HoldbackReleased(vault, share, unwindingPercentage, entriesProcessed, entriesSkipped, totalReleased, newQueueStartIndex, releasedFromSequenceNumber, releasedToSequenceNumber, ...)`.

**Blacklisted-recipient skip / DoS resolution.** Previously, a head entry whose recipient could no longer receive the collateral token (e.g. a token-level blacklist) made the transfer revert on every retry, freezing all later releases for that share with no escape. Now `releaseUsersHoldback` checks the protocol blacklist per entry and **skips** blacklisted recipients: no transfer, the holdback is **forfeited** (the collateral stays in the vault for remaining holders), and the head advances past them. This mirrors `processWithdrawalRequests`' skip-on-blacklist and gives the operator the resolution lever — protocol-blacklist the stuck recipient, then call `releaseUsersHoldback` again and the queue unblocks. `entriesSkipped` on `HoldbackReleased` reports how many entries were forfeited.

**Behavior at boundary cases:**
- `unwindingPercentage = 1e18` (100%, normal path): every visited entry pays its full holdback.
- `unwindingPercentage = 0.9e18` (black-swan haircut): each visited entry pays 90% of its holdback; the remaining 10% is absorbed by the user.
- Calling on an empty queue reverts `EmptyHoldbackQueue`.

**Worked example** (matches the design spec):

| Step | Value |
|---|---|
| User has 1000 EmberVault shares, share price 1.1 | gross = 1100 USDC |
| `feePercentage = 0.05e18`, `holdbackPercentage = 0.10e18` | fee = 55 USDC, holdback = 110 USDC |
| User receives at swap | net = gross − fee − holdback = **935 USDC** |
| Operator later calls `releaseUsersHoldback(share, 0.9e18, ...)` | user receives `110 × 0.9` = **99 USDC** |
| User absorbs the residual | 110 − 99 = 11 USDC haircut |
| Total user received | 935 + 99 = **1034 USDC** |
| AL platform-fee accrued from this swap | 55 USDC |

### Supply to Sub-Account

`supplyToSubAccount(address subAccount, uint256 amount)` *(operator)*

Operational utility: transfers idle collateral to a whitelisted off-chain sub-account (institutional ops, hedging desk, etc.). Gated by protocol pause and `pauseStatus.privilegedOperations`. Reverts `InvalidValue` if the target isn't in `subAccounts`. Does **not** auto-pull from the strategy. Emits `VaultSupplyToSubAccount`.

### Collect Platform Fee

`collectPlatformFee(uint256 loss) → uint256 amount` *(operator)*

Settles accrued fees (so the call also picks up time-based accrual through "now") and forwards `accrued − loss` of collateral to `protocolConfig.getPlatformFeeRecipient()`. The full `platformFee.accrued` is settled to zero by this call; only the `accrued − loss` portion actually leaves the vault.

| `loss` | Behavior |
|---|---|
| `0` | Transfer everything — the ordinary path. Matches the previous (single-arg) behavior. |
| `0 < loss < accrued` | Transfer `accrued − loss`, leave `loss` worth of collateral in the vault. The `loss` portion stays as un-distributed yield to remaining shareholders. |
| `loss == accrued` | Transfer nothing; the entire accrued bucket is absorbed by the vault. |
| `loss > accrued` | Reverts `InvalidValue` — operator cannot net out more than they've accrued. |

Use the `loss` parameter to absorb an off-vault shortfall (e.g. a strategy loss the vault has already booked into its receipt-token / position holdings) against unclaimed platform fees instead of letting the loss surface as a TVL-per-share haircut. Auto-pulls from strategy if idle balance can't cover `accrued − loss`. Emits `VaultPlatformFeeCollected(recipient, amount = accrued − loss, lossAbsorbed = loss, ...)`.

---

## Admin Flows

All admin setters dispatch through `protocolConfig`: protocol-config calls the vault with the original caller, and the vault verifies the caller is admin (or owner, where noted).

| Function | Verifies | Effect |
|---|---|---|
| `setMaxTVL(caller, newMaxTVL)` | admin | Updates `maxTVL`. |
| `setRateUpdateInterval(caller, newInterval)` | admin | Updates `rate.rateUpdateInterval`. |
| `setMaxRateChangePerUpdate(caller, newMaxRateChangePerUpdate)` | admin | Updates `rate.maxRateChangePerUpdate`. |
| `setAdmin(caller, newAdmin)` | **owner** | Rotates `roles.admin`. |
| `setOperator(caller, newOperator)` | admin | Rotates `roles.operator`. |
| `setRateManager(caller, newRateManager)` | admin | Rotates `roles.rateManager`. |
| `setFeePercentage(caller, newFeePercentage)` | admin | Settles accrued at OLD %, then updates `platformFee.platformFeePercentage`. |
| `setVaultName(caller, newName)` | admin | Updates `_vaultName`. |
| `setMinWithdrawableShares(caller, newMinWithdrawableShares)` | admin | Updates `minWithdrawableShares`. |
| `setSubAccountStatus(caller, account, isSubAccount)` | admin | Adds/removes a sub-account. |
| `setPausedStatus(caller, operation, paused)` | admin | Operation must be `"deposits"`, `"withdrawals"`, or `"privilegedOperations"`. |
| `setVaultValidator(caller, validator)` | admin | Sets the optional validator. |
| `setStrategy(caller, newStrategy)` | admin | Validates `strategy.asset() == collateralToken`. **Auto-drains the previous strategy's full position** back into the vault before re-pointing (reverts if it can't service the full withdrawal). |
| `setMaxInstantWithdrawShares(caller, newMax)` | admin | Sets the lifetime cumulative cap on `instantWithdraw`. Lower than current `cumulativeInstantWithdrawShares` halts the feature; higher grants new headroom. |
| `setInstantWithdrawFeePercentage(caller, newFeePercentage)` | admin | 1e18 max. |
| `setEmberShareWhitelist(caller, share, whitelisted, feePct, maxCapPct, holdbackPct, maxUtilPct, minSwapGross, maxHeldValueAbsolute)` | admin | Percentages 1e18 max; `feePct + holdbackPct ≤ 1e18` (otherwise net would underflow). `maxUtilPct` is the concentration cap; `minSwapGross` is the per-swap dust floor (0 disables); `maxHeldValueAbsolute` is the TVL-independent absolute held-value ceiling (0 disables). De-listing leaves epoch state intact. The fee-multiplier curve is **preserved** across calls — manage it via the separate tier setter below. |
| `setSwapWaiver(caller, account, feeWaived, holdbackWaived)` | admin | Independent fee / holdback waivers per share-owner address. See [Per-address waivers](#per-address-waivers). |
| `updateEmberShareFeeMultiplierTier(caller, share, threshold, multiplier, remove)` | admin | Upserts (or removes) a tier on the per-share fee-multiplier curve. See [Fee-multiplier curve](#fee-multiplier-curve). |

---

## Rate Manager Flow

`updateVaultRate(uint256 newRate)` *(rate manager)*

1. Gated by protocol pause and `pauseStatus.privilegedOperations`.
2. Settles accrued platform fees first (so prior elapsed time is priced at the OLD rate).
3. Validates: `now ≥ lastUpdatedAt + rateUpdateInterval`, `newRate ∈ [protocolConfig.getMinRate(), protocolConfig.getMaxRate()]`, `percentChangeFrom(rate.value, newRate) ≤ rate.maxRateChangePerUpdate`, `newRate != rate.value`.
4. Updates `rate.value` and `rate.lastUpdatedAt`. Emits `VaultRateUpdated`.

---

## API Reference

### Initialization

`initialize(address protocolConfig, address initialOwner, VaultInitParams params, address[] subAccounts)`

`VaultInitParams { string name; address collateralToken; address admin; address operator; address rateManager; uint256 maxRateChangePerUpdate; uint256 feePercentage; uint256 minWithdrawableShares; uint256 rateUpdateInterval; uint256 maxTVL; }`

Validates roles distinct and non-zero, `collateralToken != 0`, name non-empty, `minWithdrawableShares > 0`, `maxTVL > 0`, `rateUpdateInterval ∈ [protocolConfig.getMinRateInterval(), getMaxRateInterval()]`, `maxRateChangePerUpdate > 0`, `feePercentage ≤ getMaxAllowedFeePercentage()`, none of the roles or sub-accounts blacklisted, `subAccounts` distinct from roles. Initial rate = `protocolConfig.getDefaultRate()`. `sequenceNumber = 0`. Emits `VaultCreated`.

### User-callable

| Function | Returns |
|---|---|
| `deposit(uint256 assets, address receiver)` | `uint256 shares` |
| `depositWithPermit(uint256 assets, address receiver, uint256 deadline, uint8 v, bytes32 r, bytes32 s)` | `uint256 shares` |
| `redeemShares(uint256 shares, address receiver)` | `WithdrawalRequest` |
| `cancelPendingWithdrawalRequest(uint256 requestSequenceNumber)` | — |
| `instantWithdraw(uint256 shares, address receiver)` | `uint256 netAmount` |
| `swapEmberShares(address share, uint256 shareAmount, address receiver)` | `uint256 netAmount` |

### Operator-callable

| Function | Returns |
|---|---|
| `supplyToStrategy(uint256 assets)` | `uint256 strategyShares` |
| `withdrawFromStrategy(uint256 assets)` | `uint256 strategyShares` |
| `processWithdrawalRequests(uint256 numRequests)` | — |
| `redeemCollectedEmberShares(address share, uint256 amount)` | — |
| `releaseUsersHoldback(address share, uint256 unwindingPercentage, uint256 maxEntries)` | `(uint256 entriesProcessed, uint256 totalReleased)` |
| `supplyToSubAccount(address subAccount, uint256 amount)` | — |
| `collectPlatformFee(uint256 loss)` | `uint256 amount` (= accrued − loss) |

### Rate-Manager-callable

| Function |
|---|
| `updateVaultRate(uint256 newRate)` |

### Admin-callable (via protocol-config)

See [Admin Flows](#admin-flows).

### Views

| Function | Returns |
|---|---|
| `balanceOf(address account)` | `uint256` (AL share balance) |
| `totalSupply()` | `uint256` (alias for `totalShares`) |
| `asset()` | `address` (alias for `collateralToken`) |
| `totalAssets()` | `uint256` (rate-based modeled TVL) |
| `convertToShares(uint256 assets)` | `uint256` |
| `convertToAssets(uint256 shares)` | `uint256` |
| `maxDeposit(address)` | `uint256` (remaining TVL headroom or 0 if paused) |
| `getPendingWithdrawal(uint256 index)` | `WithdrawalRequest` |
| `getPendingWithdrawalsLength()` | `uint256` |
| `getStrategyAssets()` | `uint256` (best-effort `strategy.convertToAssets(strategy.balanceOf(this))`) |
| `solvencyMargin()` | `int256` — monitoring signal `(idle + strategyAssets) − (totalAssets() + platformFee.accrued)`; positive = surplus, negative = under-collateralized. No on-chain enforcement (accrued fees are a soft/junior claim reconciled via `collectPlatformFee(loss)`); excludes outstanding holdback liabilities. |
| `availableInstantWithdrawShares()` | `uint256` (`max − cumulative`, clamped) |
| `availableEmberShareCapacity(address share)` | `uint256` (fixed 24h window headroom) |
| `getHoldbackQueueLength(address share)` | `uint256` |
| `getPendingHoldbackEntries(address share)` | `uint256` (`length − startIndex`) |
| `getHoldbackEntry(address share, uint256 index)` | `HoldbackEntry` |
| `getAccountState(address)` | `(uint256, uint256[], uint256[])` |
| `vaultName()` | `string` |
| `version()` | `string` |
| `getChainTimestampMs()` | `uint256` (`block.timestamp × 1000`) |

---

## Events

Every state-changing call increments `sequenceNumber` and emits at least one event. Selected high-frequency events:

| Event | When |
|---|---|
| `VaultDeposit` | `deposit` / `depositWithPermit` settled |
| `RequestRedeemed` | `redeemShares` queued |
| `RequestCancelled` | `cancelPendingWithdrawalRequest` |
| `RequestProcessed` | per-request inside `processWithdrawalRequests` |
| `ProcessRequestsSummary` | end of `processWithdrawalRequests` |
| `WithdrawalFeeCharged` | when validator deducted a fee |
| `InstantWithdrawn` | `instantWithdraw` settled |
| `InstantWithdrawLimitUpdated`, `InstantWithdrawFeeUpdated` | admin setter |
| `EmberShareSwapped` | `swapEmberShares` settled; now carries `utilizationAtSwap` + `feeMultiplierApplied` |
| `EmberShareWhitelistUpdated` | `setEmberShareWhitelist`; reports `maxUtilizationPercentage`, `minSwapGross`, and `maxHeldValueAbsolute` |
| `EmberShareFeeMultiplierTierUpdated` | `updateEmberShareFeeMultiplierTier` (both upsert and remove use this) |
| `SwapWaiverUpdated` | `setSwapWaiver` |
| `EmberSharesRedemptionInitiated` | `redeemCollectedEmberShares` |
| `HoldbackReleased` | `releaseUsersHoldback`; carries `entriesSkipped` (blacklisted recipients whose holdback was forfeited) alongside `entriesProcessed` / `totalReleased` |
| `StrategyUpdated`, `StrategySupplied`, `StrategyWithdrawn` | strategy lifecycle |
| `VaultPlatformFeeCharged` | `_chargeAccruedPlatformFees` (via various entry points) |
| `VaultPlatformFeeCollected` | `collectPlatformFee`; now also reports `lossAbsorbed` |
| `VaultPauseStatusUpdated` | `setPausedStatus` |
| `VaultRateUpdated` | `updateVaultRate` |
| `VaultCreated` | `initialize` |

---

## Errors

| Error | Cause |
|---|---|
| `ZeroAddress` | An address argument was 0 — includes a null `receiver` on `redeemShares`, `instantWithdraw`, or `swapEmberShares`. |
| `ZeroAmount` | A required amount was 0 (or computed to 0). |
| `InvalidValue` | Generic validation failure (sub-account hits owner role, unknown pause op, etc.). |
| `SameValue` | Setter called with the current value (admin operations are rejected as no-ops to keep events meaningful). |
| `Unauthorized` | Caller doesn't hold the required role. |
| `Blacklisted` | Account is blacklisted by `protocolConfig`. |
| `ProtocolPaused` | `protocolConfig.getProtocolPauseStatus() == true`. |
| `OperationPaused` | Vault-level pause (`deposits` / `withdrawals` / `privilegedOperations`). |
| `InsufficientBalance` | Vault doesn't have enough collateral on hand (and strategy can't fill the gap, or wasn't asked to). |
| `InsufficientShares` | `shares < minWithdrawableShares`, or `shareOf[user] < shares`. |
| `InvalidRequest` | Withdrawal request lookup or cancel-flow inconsistency. |
| `InvalidInterval`, `InvalidRate` | Rate-update violates protocol bounds. |
| `MaxTVLReached` | Deposit would exceed `maxTVL`. |
| `IndexOutOfBounds` | `getPendingWithdrawal` / `getHoldbackEntry` past array length. |
| `StrategyNotSet` | Strategy operation called with `strategy == 0`. |
| `InvalidStrategy` | New strategy's `asset()` doesn't match `collateralToken`. |
| `InstantWithdrawCapExceeded` | `cumulativeInstantWithdrawShares + shares > maxInstantWithdrawShares`. |
| `InstantWithdrawFeeTooHigh` | Setter received `> 1e18`. |
| `EmberShareNotWhitelisted` | `swapEmberShares` on a non-whitelisted share. |
| `EmberShareCapExceeded` | `epochUsedAmount + gross > cap`. Implements the 24h timelock. |
| `EmberShareUtilizationCapExceeded` | Post-swap utilization would exceed the per-share `maxUtilizationPercentage` concentration cap. |
| `EmberShareHeldValueCapExceeded` | Post-swap held value would exceed the per-share `maxHeldValueAbsolute` absolute cap (TVL-independent). |
| `SwapAmountTooSmall` | `swapEmberShares` gross is below the per-share `minSwapGross` dust floor. |
| `InvalidFeeMultiplier` | `updateEmberShareFeeMultiplierTier(..., remove=false)` with `multiplier < 1e18` — fees can only scale UP via the curve. |
| `TierNotFound` | `updateEmberShareFeeMultiplierTier(..., remove=true)` for a `threshold` that isn't in the curve. |
| `InvalidPercentage` | Setter or release received `> 1e18`, or `feePct + holdbackPct > 1e18`, or `releaseUsersHoldback` got `0` percentage, or the curve+holdback combination would push net below 0 at swap time. |
| `EmptyHoldbackQueue` | `releaseUsersHoldback` on an exhausted queue. |

---

## Pause Semantics

Three orthogonal vault-level pause flags, plus the protocol-wide pause from `protocolConfig.getProtocolPauseStatus()`. All four can independently halt different subsets of behavior.

| Flow | Protocol pause | `deposits` | `withdrawals` | `privilegedOperations` |
|---|---|---|---|---|
| `deposit` / `depositWithPermit` | ✋ | ✋ | — | — |
| `redeemShares` | ✋ | — | ✋ | — |
| `cancelPendingWithdrawalRequest` | ✋ | — | ✋ | — |
| `instantWithdraw` | ✋ | — | ✋ | — |
| `swapEmberShares` | ✋ | — | ✋ | — |
| `processWithdrawalRequests` | ✋ | — | — | ✋ |
| `supplyToStrategy` / `withdrawFromStrategy` | ✋ | — | — | ✋ |
| `redeemCollectedEmberShares` | ✋ | — | — | ✋ |
| `releaseUsersHoldback` | ✋ | — | — | ✋ |
| `supplyToSubAccount` | ✋ | — | — | ✋ |
| `collectPlatformFee` | ✋ | — | — | ✋ |
| `updateVaultRate` | ✋ | — | — | ✋ |
| Admin setters | ✋ in some cases (no — admin overrides are not blocked) | — | — | — |

> *"Admin operations are not paused"* — the design intent inherited from EmberVault: admin must always be able to repair or unpause.

---

## Operational Runbook

A typical operator day, in order:

1. **Top up liquidity if needed.** Check vault balance vs. expected payouts. If short, `withdrawFromStrategy(amount)`.
2. **Process the standard withdrawal queue.** `processWithdrawalRequests(N)`. Repeat until queue is drained or you've used your batch budget.
3. **Submit collected EmberShares for redemption.** For each whitelisted EmberShare with held balance, call `redeemCollectedEmberShares(share, amount)`. Stay within the source EmberVault's `minWithdrawableShares` floor.
4. **Wait for source-side settlement.** AL receives collateral when each EmberVault processes AL's request.
5. **Release holdback.** For each share whose redemptions have settled, call `releaseUsersHoldback(share, percentage, maxEntries)`. Start with smaller percentages if there's any chance of source-side haircut.
6. **Sweep idle balance.** Once near-term obligations are funded, `supplyToStrategy(idleAmount)` to put idle collateral to work.
7. **Collect platform fees.** `collectPlatformFee()` — but only after source EmberVault settlements have populated AL's collateral, so the time-based + instant-withdraw-fee + EmberShare-fee accruals are actually backed by real balance.
8. **Rate update** (rate manager, on cadence): `updateVaultRate(newRate)` driven by your off-chain pricing.

Admin one-offs:
- Onboard a new EmberShare for swap: `setEmberShareWhitelist(true, ...)`.
- Exempt an institutional partner from swap fees / holdback: `setSwapWaiver(account, feeWaived, holdbackWaived)`. Both flags are independent.
- Increase instant-withdraw capacity: `setMaxInstantWithdrawShares(newCumulative)`.
- Onboard a new strategy: `setStrategy(newAddr)` (it auto-drains the previous strategy's full position back into the vault before re-pointing).

---

## Security Considerations

- **No share token, no transfers.** AL shares are book-entry only. There is no ERC-20 surface for share transfers or approvals — eliminates a class of share-related attacks (e.g. share-token reentrancy, on-chain price-oracle manipulation via share trades).
- **Auto-pull from strategy.** `_ensureLiquidity` calls `strategy.withdraw` mid-flow on user-facing paths. The strategy contract is therefore in the trust boundary. **Only set vetted ERC-4626 strategies.** The address-validation on `setStrategy` only checks `asset()`; it does not vouch for the strategy's safety.
- **Self-allowance pattern.** When AL submits collected EmberShares for redemption, it `forceApprove`s the EmberVault to spend AL's own balance, then calls `redeemShares`. Approvals are exact and consumed by the immediate redemption.
- **EmberShare whitelist trust.** Whitelisting a share means trusting that EmberVault's `convertToAssets` and `totalAssets` are well-behaved — they directly drive AL's pricing and capacity calculation for swap. A malicious or buggy EmberVault could manipulate AL's payouts for the swap path.
- **Cap is cumulative for instant withdraw.** `maxInstantWithdrawShares` is *lifetime* cumulative. Lowering it below the current cumulative does NOT claw anything back; it just halts the feature.
- **Holdback release is one-shot.** `releaseUsersHoldback` is a final settlement at the given `unwindingPercentage` — every visited entry is closed in that single call, regardless of the percentage. At <100%, the residual is absorbed by the user as a haircut. There is no mechanism to "top up" a previously-settled entry. Operator should call with 100% as the default and only use lower values when consciously socializing a loss across users. `maxEntries` bounds per-call gas.
- **Rate manager is the source of truth on TVL.** `totalAssets()` is rate-based, not balance-based. A stale rate produces stale fee accrual and stale `availableEmberShareCapacity` (since the source EmberVault's `totalAssets` is rate-based on its side too). Synchronize off-chain rate updates with vault state changes that materially shift NAV (large strategy moves, large EmberVault settlements).
- **Validator hook is upstream-trusted.** If `vaultValidator` is set, `validateDeposit`/`recordDeposit`/`calculateWithdrawalFees` calls are trusted external calls. Set the validator only when needed.
- **Reentrancy.** All user/operator entry points use `nonReentrant`. External calls within a method are at the end of the local accounting (CEI pattern) where possible. The cross-vault swap path is the most external-call-heavy flow — read it carefully when modifying.

---

## Deployment and Upgrades

### Two artifacts, deployed separately

`AtomicLiquidity` is split into:

- **`AtomicLiquidityLib`** — an external Solidity library that holds the heavy code paths (`swapEmberShares`, `releaseUsersHoldback`, `redeemCollectedEmberShares`, the capacity helper, the strategy-pull helper). Deployed **once per network**. Plain `CREATE`-deployed bytecode at a fixed address. **Not** behind a proxy.
- **`AtomicLiquidity`** — the vault itself, deployed behind a UUPS proxy. The implementation contract is *linked* to a specific `AtomicLiquidityLib` address at compile/deploy time; the linker patches the library address into the implementation bytecode.

This split keeps the implementation under EIP-170's 24,576-byte limit. As of `v1.0.0` the implementation is ~23,278 bytes (≈1.3 KB headroom) with the library at ~3,218 bytes deployed separately.

### Storage layout invariant

The library defines `EmberShareConfig` and `HoldbackEntry` and the vault stores them in mappings. The vault's storage layout therefore depends on those struct field orderings — **never reorder or remove fields in those structs without a coordinated upgrade plan**. Adding fields to the *end* of either struct is safe because Solidity stores struct fields contiguously starting at the mapping slot, but only if the struct is not packed into adjacent storage by a later mapping (which it is not in this contract).

### Scripts

| Yarn alias | File | Purpose |
|---|---|---|
| `yarn deploy:atomic-liquidity-lib` | [scripts/deploy/atomic-liquidity-lib.ts](../scripts/deploy/atomic-liquidity-lib.ts) | Deploys `AtomicLiquidityLib` once. Records the address under `contracts.atomicLiquidityLib` in `deployments/<network>-deployment.json`. Re-running is a safe no-op unless `FORCE_REDEPLOY_LIB=true` is set. |
| `yarn deploy:atomic-liquidity` | [scripts/deploy/atomic-liquidity.ts](../scripts/deploy/atomic-liquidity.ts) | Deploys an `AtomicLiquidity` UUPS proxy, linked to the previously recorded library. Records under `contracts.atomicLiquidityVaults[<key>]`. |
| `yarn upgrade:atomic-liquidity` | [scripts/upgrade/atomic-liquidity.ts](../scripts/upgrade/atomic-liquidity.ts) | Deploys a new `AtomicLiquidity` implementation linked to the resolved library address, then `upgradeToAndCall(newImpl, "0x")` on the requested proxies. Updates each entry's `implementationAddress`, `libraryAddress`, and `version` in the deployment file. |

### Environment variables

#### `deploy:atomic-liquidity-lib`

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `FORCE_REDEPLOY_LIB` | optional | `false` | Set to `true` to deploy a fresh library even when one is already recorded. Use this when the library bytecode itself has changed (rare). |

#### `deploy:atomic-liquidity`

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `ATOMIC_LIQUIDITY_NAME` | **yes** | — | Vault display name (e.g. `"Atomic Liquidity USDC"`). Also used to derive the deployment-file key (`atomicLiquidityUsdc`). |
| `ATOMIC_LIQUIDITY_COLLATERAL_TOKEN` | **yes** | — | Underlying ERC-20 (e.g. USDC). |
| `ATOMIC_LIQUIDITY_ADMIN` | **yes** | — | Initial `roles.admin`. |
| `ATOMIC_LIQUIDITY_OPERATOR` | **yes** | — | Initial `roles.operator`. |
| `ATOMIC_LIQUIDITY_RATE_MANAGER` | **yes** | — | Initial `roles.rateManager`. |
| `ATOMIC_LIQUIDITY_OWNER` | optional | deployer address | Proxy owner (UUPS upgrade authority). |
| `ATOMIC_LIQUIDITY_MAX_RATE_CHANGE` | optional | `10000000000000000` (1%) | `rate.maxRateChangePerUpdate`. |
| `ATOMIC_LIQUIDITY_FEE_PERCENTAGE` | optional | `1000000000000000` (0.1%) | Time-based platform fee. |
| `ATOMIC_LIQUIDITY_MIN_WITHDRAWABLE` | optional | `1000000` | Min withdrawable shares (`redeemShares`/`instantWithdraw` floor). |
| `ATOMIC_LIQUIDITY_RATE_INTERVAL` | optional | `3600001` (≈1h, in ms) | `rate.rateUpdateInterval`. |
| `ATOMIC_LIQUIDITY_MAX_TVL` | optional | `1e30` | TVL cap. |
| `ATOMIC_LIQUIDITY_SUB_ACCOUNTS` | optional | `""` | Comma-separated initial sub-accounts. |
| `ATOMIC_LIQUIDITY_LIB_ADDRESS` | optional | from deployment file | Override the library address to link against. |

The deploy script enforces the on-chain init invariants up front (admin/operator/rateManager distinct, none zero, etc.) and bails with an actionable error if anything is off.

#### `upgrade:atomic-liquidity`

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `ATOMIC_LIQUIDITY_KEYS` | optional | all keys under `atomicLiquidityVaults` | Comma-separated subset of vault keys to upgrade (e.g. `atomicLiquidityUsdc,atomicLiquidityWeth`). |
| `ATOMIC_LIQUIDITY_LIB_ADDRESS` | optional | from deployment file | Library to link the new implementation against. Pass this when re-linking to a freshly deployed library. |

The script:
- Loads each requested vault entry, prints the current proxy + impl + linked library + version.
- Waits 5 seconds (Ctrl-C safety pause).
- Deploys ONE new implementation linked to the resolved library address.
- Iterates the proxies, skipping any already on the new impl, calling `upgradeToAndCall(newImpl, "0x")` on the rest.
- Verifies the new impl/version on each proxy and writes back to the deployment file.

### Library upgrades

Libraries are not behind proxies — their bytecode is fixed at the deployed address. To "upgrade" library logic, you deploy a *new* library and re-link the implementation to it:

```bash
# 1. Deploy a new library under a fresh address
FORCE_REDEPLOY_LIB=true yarn deploy:atomic-liquidity-lib --network <net>

# 2. Re-link the proxies' implementation to the new library
ATOMIC_LIQUIDITY_LIB_ADDRESS=<newLibAddress> yarn upgrade:atomic-liquidity --network <net>
```

Until step 2 runs, existing proxies still execute against the *old* library — the proxy doesn't auto-pick-up a new library deployment.

### Hardhat upgrades plugin caveat

Both deploy and upgrade scripts pass `unsafeAllowLinkedLibraries: true` to `deployProxy` / under-the-hood `upgradeToAndCall`. The OZ Upgrades plugin uses this flag to acknowledge that:

- Library bytecode is not part of the proxy's storage and so can't be tracked by the plugin's safety checks.
- A bug in the library is not automatically caught by the plugin's storage-layout diff or initializer checks.

The mitigation is process: review library changes carefully before deploying a new library, run the full test suite (which uses the live library via the same linker path), and prefer the recorded address re-use path (`yarn deploy:atomic-liquidity-lib` is idempotent unless forced).

### Typical sequence (fresh network)

```bash
# 1. Protocol config (one-time per network)
yarn deploy:protocol-config --network <net>

# 2. Library (one-time per network unless re-linking)
yarn deploy:atomic-liquidity-lib --network <net>

# 3. Vault proxy (one per logical vault — name + collateral pair)
ATOMIC_LIQUIDITY_NAME="Atomic Liquidity USDC" \
ATOMIC_LIQUIDITY_COLLATERAL_TOKEN=0x… \
ATOMIC_LIQUIDITY_ADMIN=0x… \
ATOMIC_LIQUIDITY_OPERATOR=0x… \
ATOMIC_LIQUIDITY_RATE_MANAGER=0x… \
yarn deploy:atomic-liquidity --network <net>

# 4. Post-deploy admin actions (via protocol-config dispatch or impersonation in tests):
#    - setStrategy(...)              when ready to enable yield
#    - setMaxInstantWithdrawShares  to enable instantWithdraw (default disabled)
#    - setInstantWithdrawFeePercentage
#    - setEmberShareWhitelist(...)   to onboard EmberVault shares for swap
```

### Typical sequence (logic upgrade)

```bash
# Library unchanged → just upgrade implementation logic:
yarn upgrade:atomic-liquidity --network <net>

# Library bytecode changed → redeploy lib AND re-link:
FORCE_REDEPLOY_LIB=true yarn deploy:atomic-liquidity-lib --network <net>
ATOMIC_LIQUIDITY_LIB_ADDRESS=<newLib> yarn upgrade:atomic-liquidity --network <net>

# Subset of vaults only:
ATOMIC_LIQUIDITY_KEYS=atomicLiquidityUsdc yarn upgrade:atomic-liquidity --network <net>
```

### Deployment file shape

After running both deploys, the network deployment file gains:

```jsonc
{
  "contracts": {
    "atomicLiquidityLib": {
      "address": "0x…",
      "deployerAddress": "0x…",
      "deployedAt": "2026-…",
      "deploymentBlockNumber": 1234567,
      "bytecodeSize": 3218
    },
    "atomicLiquidityVaults": {
      "atomicLiquidityUsdc": {
        "proxyAddress": "0x…",
        "implementationAddress": "0x…",
        "libraryAddress": "0x…",
        "ownerAddress": "0x…",
        "name": "Atomic Liquidity USDC",
        "collateralToken": "0x…",
        "admin": "0x…",
        "operator": "0x…",
        "rateManager": "0x…",
        "protocolConfig": "0x…",
        "maxTVL": "1000000000000000000000000000000",
        "version": "v1.0.0",
        "deployedAt": "2026-…",
        "deploymentBlockNumber": 1234568
      }
    }
  }
}
```

After an upgrade, the relevant entry gains `upgradedAt` and `upgradedInBlock` fields and `implementationAddress` / `libraryAddress` / `version` are updated in place.
