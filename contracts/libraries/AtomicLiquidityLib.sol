// SPDX-License-Identifier: UNLICENSED
/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.
*/
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "./Math.sol";
import "./VaultPlatformFeeLib.sol";
import "./WithdrawalQueueLib.sol";
import "../interfaces/IEmberProtocolConfig.sol";
import "../interfaces/IEmberVaultValidator.sol";

interface IEmberVaultRedeemable {
  function redeemShares(uint256 shares, address receiver) external;
}

/// @notice Reads the totalPendingWithdrawalShares scalar from a source EmberVault's public
///         `accounts` mapping. Solidity's auto-getter on a struct that contains dynamic
///         arrays returns ONLY the scalar fields, in order — so this signature matches
///         EmberVault.accounts(address) exactly. Used by the utilization view to count
///         shares AL has redeemed on the source but not yet settled.
interface IEmberVaultAccount {
  function accounts(address) external view returns (uint256 totalPendingWithdrawalShares);
}

/// @notice Reads the EmberVault pause-flag struct via Solidity's auto-getter on the
///         `PauseStatus public pauseStatus` storage var. The tuple ordering matches
///         EmberVault's struct field order: (deposits, withdrawals, privilegedOperations).
///         FIELD ORDER IS LOAD-BEARING — if EmberVault adds or reorders fields in
///         PauseStatus, this signature must be updated in lockstep.
interface IEmberVaultPauseStatus {
  function pauseStatus()
    external
    view
    returns (bool deposits, bool withdrawals, bool privilegedOperations);
}

/// @notice Reads the protocol-level account blacklist. Used by `releaseUsersHoldback` to skip
///         (and forfeit) holdback entries whose recipient has been blacklisted — mirroring the
///         skip behaviour of AtomicLiquidity._processRequest, and providing the operator a
///         resolution path when a recipient can no longer receive the collateral token.
interface IEmberConfigBlacklist {
  function isAccountBlacklisted(address account) external view returns (bool);
}

/// @title AtomicLiquidityLib
/// @notice External library housing the heavy code paths for the AtomicLiquidity vault:
///         the cross-vault EmberShare swap, the holdback release queue, and the
///         redeem-collected forwarder. Deployed once and linked into the AtomicLiquidity
///         implementation via DELEGATECALL — keeps the implementation under EIP-170's
///         24,576-byte limit.
/// @dev Library functions execute in the calling contract's storage context. Storage refs
///      passed in are valid because Solidity wires the slots through DELEGATECALL.
library AtomicLiquidityLib {
  using SafeERC20 for IERC20;

  uint256 internal constant PERCENT_MAX = 1e18;
  uint256 internal constant EMBER_SHARE_EPOCH_DURATION = 24 hours;

  /// @notice Dust-threshold reference exponent: the auto-lift ceiling is 10^(decimals - DUST_DECIMAL_OFFSET).
  ///         `4` means "1e-4 tokens" in real-value terms — for USDC (6d) that's
  ///         100 base units (0.0001 USDC), for WETH (18d) that's 1e14 base units
  ///         (0.0001 ETH), for WBTC (8d) it's 1e4 sats (~0.0001 BTC). Sized so any
  ///         genuine sub-precision entry (e.g. an amount==1 griefing swap) still
  ///         gets settled, but never so large that a real operator-set haircut
  ///         on a real user's holdback is bypassed.
  uint256 internal constant DUST_DECIMAL_OFFSET = 4;

  /// @notice Returns the auto-lift ceiling for `collateralToken`, in the token's own
  ///         base units. See `DUST_DECIMAL_OFFSET` for the sizing rationale.
  ///
  ///         Behavior across decimals:
  ///           * `decimals ≥ 4`  → `10 ** (decimals - 4)`. Auto-lift active.
  ///           * `decimals < 4`  → `0`. Auto-lift branch is inert (no realistic
  ///                                     entry will satisfy `entryAmount ≤ 0`).
  ///                                     Acceptable because a token with fewer
  ///                                     than 4 decimals has no meaningful sub-
  ///                                     precision "dust" — a zero-payout entry
  ///                                     is treated as intentional and closed
  ///                                     without payment, exactly as it would be
  ///                                     for a non-dust entry above the ceiling.
  ///
  ///         Reads `IERC20Metadata.decimals()` on every call. `releaseUsersHoldback`
  ///         is operator-only and infrequent, so the per-call STATICCALL is
  ///         negligible; caching in vault state was considered and rejected
  ///         (it would grow AtomicLiquidity's already-tight bytecode).
  function holdbackDustUnits(address collateralToken) internal view returns (uint256) {
    uint8 d = IERC20Metadata(collateralToken).decimals();
    if (d < DUST_DECIMAL_OFFSET) return 0;
    return 10 ** (d - DUST_DECIMAL_OFFSET);
  }

  /// @dev A-10: absolute ceiling on a single EmberShare fee-multiplier tier (100×, in 1e18
  ///      fixed-point). Tiers are `>= PERCENT_MAX` (1×); this caps the top so a wild multiplier
  ///      can't overflow the `base × multiplier` fee math or be set and later brick swaps.
  uint256 internal constant MAX_FEE_MULTIPLIER = 100e18;

  /// @dev A-10: max number of tiers in a fee-multiplier curve. Bounds the O(n)
  ///      `_lookupFeeMultiplier` walk run on every swap.
  uint256 internal constant MAX_FEE_MULTIPLIER_TIERS = 20;

  // ============ Storage struct types ============
  // Defined here so AtomicLiquidity can reference them as `AtomicLiquidityLib.X`. The
  // storage layout in AtomicLiquidity uses these types directly, so library functions
  // can take `storage` references safely. (The time-based platform-fee accrual lives in
  // the shared VaultPlatformFeeLib — see `_chargeAccruedPlatformFees` in the vaults.)

  struct EmberShareConfig {
    bool whitelisted;
    uint256 feePercentage;
    uint256 maxCapacityPercentage;
    uint256 holdbackPercentage;
    uint256 epochStartedAt;
    uint256 epochUsedAmount;
    /// @notice Concentration cap on this source share, in 1e18 fixed-point (1e18 = 100%).
    ///         Checked against POST-swap utilization: a swap that would push the held value
    ///         above this cap reverts with EmberShareUtilizationCapExceeded. Utilization is
    ///         `held_share_value_in_collateral / al_total_assets`, where the held value
    ///         includes both AL-custodied shares AND shares AL has already submitted for
    ///         redemption on the source vault but not yet settled.
    uint256 maxUtilizationPercentage;
    /// @notice Minimum gross collateral value (in collateral units) a single swap must produce,
    ///         enforced against `IERC4626(share).convertToAssets(shareAmount)`. Dust floor that
    ///         prevents an attacker from spamming sub-unit swaps: such swaps round `feeAmount`
    ///         to 0 (bypassing the fee disincentive) while still queueing a 1-wei HoldbackEntry,
    ///         which both bloats the operator's `releaseUsersHoldback` gas and — at any
    ///         `unwindingPercentage < 100%` — produces a 0 payout that reverts the whole release
    ///         batch (a durable DoS on partial unwinds). 0 disables the floor.
    uint256 minSwapGross;
    /// @notice Absolute ceiling (in collateral units) on the held value of this source share —
    ///         `held_share_value_in_collateral` post-swap must not exceed it. Unlike
    ///         `maxUtilizationPercentage`, this is NOT a fraction of AL's TVL, so it cannot be
    ///         gamed by transiently inflating `totalAssets()` (e.g. deposit → swap → withdraw)
    ///         to slip a larger position past the percentage cap. 0 disables the absolute cap.
    uint256 maxHeldValueAbsolute;
    /// @notice Step-function curve of (threshold, multiplier) pairs, kept sorted ascending
    ///         by `threshold`. At swap time, the multiplier of the highest threshold ≤
    ///         current utilization is applied to the base `feePercentage`. Multipliers are
    ///         in 1e18 fixed-point: 1e18 = 1× (no scaling), 1.5e18 = 1.5×, etc. Empty curve
    ///         or no matching tier resolves to 1× (base fee unchanged). Constrained on
    ///         insert: `multiplier >= 1e18` (fees can only go UP with utilization).
    FeeMultiplierTier[] feeMultiplierCurve;
  }

  struct FeeMultiplierTier {
    /// @dev Utilization threshold in 1e18 fixed-point (1e18 = 100%).
    uint256 threshold;
    /// @dev Fee multiplier in 1e18 fixed-point. 1e18 = 1×; must be ≥ 1e18.
    uint256 multiplier;
  }

  struct HoldbackEntry {
    address recipient;
    uint256 amount;
    uint256 released;
    uint256 createdAt;
    uint256 sequenceNumber;
  }

  // ============ Errors ============

  error EmberShareCapExceeded();
  error InvalidPercentage();
  error EmptyHoldbackQueue();
  error InsufficientBalance();
  error ZeroAmount();
  error StrategyShortDelivery();
  error InvalidStrategy();
  /// @notice Source EmberVault has its withdrawals flag paused; swap refused to avoid
  ///         AL accumulating shares it cannot subsequently redeem. Same selector as
  ///         AtomicLiquidity.OperationPaused (Solidity errors are signature-keyed) so
  ///         the ABI surface matches the rest of the contract's pause vocabulary.
  error OperationPaused();
  /// @notice Post-swap utilization would exceed `EmberShareConfig.maxUtilizationPercentage`.
  error EmberShareUtilizationCapExceeded();
  /// @notice Tier insert with multiplier < 1e18 — fees cannot go BELOW the base via the curve.
  error InvalidFeeMultiplier();
  /// @notice Tier remove referenced a threshold that doesn't exist in the curve.
  error TierNotFound();
  /// @notice Swap gross collateral value is below the share's configured `minSwapGross` floor.
  error SwapAmountTooSmall();

  /// @dev A-9: swap's immediate payout fell below the caller's `minNetOut` slippage floor.
  error SlippageToleranceExceeded();
  /// @notice Post-swap held value of the source share would exceed `maxHeldValueAbsolute`.
  error EmberShareHeldValueCapExceeded();
  // Errors used by the moved-in `instantWithdraw` library function. OperationPaused is already
  // declared elsewhere in this library; ProtocolPaused, InvalidValue and Blacklisted are
  // inherited from the imported IEmberProtocolConfig — so none of those are repeated here.
  error InsufficientShares();
  error InstantWithdrawCapExceeded();

  // ============ Events ============
  // Re-declared in the main contract too. DELEGATECALL keeps `address(this)` as the
  // proxy, so off-chain indexers see events emitted by the main contract address.

  event EmberShareSwapped(
    address indexed vault,
    address indexed share,
    address indexed owner,
    address receiver,
    uint256 shareAmount,
    uint256 grossAmount,
    uint256 feeAmount,
    uint256 holdbackAmount,
    uint256 netAmount,
    uint256 epochUsedAmount,
    /// @dev Post-swap utilization (held_value / al_tvl) in 1e18 fixed-point.
    uint256 utilizationAtSwap,
    /// @dev Multiplier resolved from the curve at `utilizationAtSwap`. 1e18 = 1×.
    uint256 feeMultiplierApplied,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted on both inserts/updates AND removals; `removed = true` means the tier
  ///         at `threshold` was deleted (multiplier is reported as 0 in that case).
  event EmberShareFeeMultiplierTierUpdated(
    address indexed vault,
    address indexed share,
    uint256 threshold,
    uint256 multiplier,
    bool removed,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event HoldbackReleased(
    address indexed vault,
    address indexed share,
    uint256 unwindingPercentage,
    uint256 entriesProcessed,
    // Subset of `entriesProcessed` skipped because the recipient was blacklisted; their
    // holdback is forfeited (collateral stays in the vault) and the head advances past them.
    uint256 entriesSkipped,
    uint256 totalReleased,
    uint256 newQueueStartIndex,
    // Inclusive [from, to] swap-sequence range of the holdback entries settled by
    // this release. Both 0 when entriesProcessed is 0.
    uint256 releasedFromSequenceNumber,
    uint256 releasedToSequenceNumber,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event InstantWithdrawn(
    address indexed vault,
    address indexed owner,
    address indexed receiver,
    uint256 sharesBurnt,
    uint256 grossAmount,
    uint256 feeAmount,
    uint256 netAmount,
    uint256 cumulativeInstantWithdrawShares,
    uint256 totalShares,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event RequestProcessed(
    address indexed vault,
    address indexed owner,
    address indexed receiver,
    uint256 shares,
    uint256 withdrawAmount,
    uint256 requestTimestamp,
    uint256 processTimestamp,
    bool skipped,
    bool cancelled,
    uint256 totalShares,
    uint256 totalSharesPendingToBurn,
    uint256 sequenceNumber,
    uint256 requestSequenceNumber
  );

  event WithdrawalFeeCharged(
    address indexed vault,
    address indexed owner,
    uint256 requestSequenceNumber,
    uint256 permanentFeeCharged,
    uint256 timeBasedFeeCharged
  );

  /// @notice A holdback payout could not be delivered to `recipient` during a batch release
  ///         (e.g. a blocklisted collateral address or a reverting token hook) and was
  ///         escrowed as a claimable balance instead of reverting the whole batch.
  ///         Recoverable later via `claimHoldback` / `claimHoldbackFor`.
  event HoldbackTransferDeferred(
    address indexed vault,
    address indexed share,
    address recipient,
    uint256 index,
    uint256 amount,
    // Swap sequence number of the deferred holdback entry (== the EmberShareSwapped
    // sequenceNumber that created it). Stable cross-event key for linking the deferral
    // back to its swap and to the HoldbackReleased range — unlike `index`, which is a
    // queue position pointer that must not be compared against sequence numbers.
    uint256 swapSequenceNumber,
    uint256 timestamp,
    // Vault sequence number of the releaseUsersHoldback batch that deferred this entry.
    uint256 sequenceNumber
  );

  /// @notice An escrowed (previously undeliverable) holdback payout was delivered. Settles the
  ///         recipient's aggregate `unclaimedHoldback` balance. `to` is where the collateral
  ///         actually went: the original `recipient` for a normal claim, or a different address
  ///         for a recipient-redirect ({claimHoldbackTo}) or an owner rescue
  ///         ({recoverUnclaimedHoldback}).
  event HoldbackClaimed(
    address indexed vault,
    address indexed recipient,
    address indexed to,
    uint256 amount,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event EmberSharesRedemptionInitiated(
    address indexed vault,
    address indexed share,
    uint256 amount,
    uint256 remainingShareBalance,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event EmberShareWhitelistUpdated(
    address indexed vault,
    address indexed share,
    bool whitelisted,
    uint256 feePercentage,
    uint256 maxCapacityPercentage,
    uint256 holdbackPercentage,
    uint256 maxUtilizationPercentage,
    uint256 minSwapGross,
    uint256 maxHeldValueAbsolute,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event SwapWaiverUpdated(
    address indexed vault,
    address indexed account,
    bool feeWaived,
    bool holdbackWaived,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  // ============ Calldata bundles ============
  // Bundling args into a calldata struct keeps function signatures readable.

  struct SwapArgs {
    address share;
    uint256 shareAmount;
    address receiver;
    address shareOwner;
    address collateralToken;
    address strategy;
    uint256 sequenceNumber;
    uint256 timestamp;
    /// @dev True when shareOwner is on AtomicLiquidity.feeWaivedAddresses — fee = 0.
    bool feeWaived;
    /// @dev True when shareOwner is on AtomicLiquidity.holdbackWaivedAddresses — holdback = 0
    ///      and no HoldbackEntry is queued; user gets the full gross immediately.
    bool holdbackWaived;
    /// @dev True once AtomicLiquidity has ever called redeemCollectedEmberShares — a cheap
    ///      negative cache so swap utilization skips the cross-contract `source.accounts(...)`
    ///      read while the vault has no in-flight redemptions on any source.
    bool hasActiveRedemptionHistory;
    /// @dev AL's modeled `totalAssets()` at swap time. Caller reads on-chain and passes in
    ///      so the lib doesn't need a back-reference to the main contract.
    uint256 vaultTotalAssets;
    /// @dev A-9: minimum immediate collateral payout the caller will accept. The swap reverts
    ///      `SlippageToleranceExceeded` if `netAmount` (the amount transferred to `receiver`)
    ///      is below this, guarding against a utilization-driven fee-multiplier spike between
    ///      preview and execution. Pass 0 to disable.
    uint256 minNetOut;
  }

  struct ReleaseArgs {
    address share;
    uint256 unwindingPercentage;
    uint256 maxEntries;
    address collateralToken;
    address strategy;
    /// @dev Protocol-config address, read for the per-recipient blacklist check.
    address protocolConfig;
    uint256 sequenceNumber;
    uint256 timestamp;
  }

  struct InstantWithdrawArgs {
    address configProxy;
    bool withdrawalsPaused;
    address shareOwner;
    address receiver;
    uint256 shares;
    uint256 grossAmount;
    uint256 minWithdrawableShares;
    uint256 maxInstantWithdrawShares;
    uint256 instantWithdrawFeePercentage;
    uint256 cumulativeBefore;
    uint256 totalSharesBefore;
    address collateralToken;
    address strategy;
    uint256 timestamp;
    uint256 sequenceNumber;
  }

  struct ProcessRequestArgs {
    address owner;
    address receiver;
    uint256 shares;
    uint256 reqTimestamp;
    uint256 reqSequenceNumber;
    uint256 currentTime;
    uint256 grossWithdrawAmount;
    address configProxy;
    address vaultValidator;
    address collateralToken;
    uint256 totalShares;
    uint256 pendingBurnShares;
    uint256 sequenceNumber;
  }

  struct WhitelistArgs {
    address share;
    bool whitelisted;
    uint256 feePercentage;
    uint256 maxCapacityPercentage;
    uint256 holdbackPercentage;
    /// @dev Concentration cap, 1e18 fixed-point. Preserved across whitelist toggles only
    ///      via separate setter — the whitelist setter overwrites every other field, but
    ///      preserves the `feeMultiplierCurve` array.
    uint256 maxUtilizationPercentage;
    /// @dev Minimum gross collateral value per swap; 0 disables the dust floor.
    uint256 minSwapGross;
    /// @dev Absolute held-value ceiling (collateral units) for this share; 0 disables it.
    uint256 maxHeldValueAbsolute;
    address collateralToken;
    uint256 sequenceNumber;
    uint256 timestamp;
  }

  // ============ Public API ============

  /// @notice Executes an EmberShare swap. The caller (AtomicLiquidity) is expected to
  ///         have already validated pause/blacklist/zero-value preconditions.
  /// @return netAmount Collateral transferred to receiver immediately
  /// @return feeAmount Caller must add this to its platformFee.accrued
  function swapEmberShares(
    SwapArgs calldata a,
    EmberShareConfig storage config,
    HoldbackEntry[] storage queue
  ) external returns (uint256 netAmount, uint256 feeAmount) {
    // Note: outer contract enforces config.whitelisted with the correct error.

    // Refuse swap when the source vault has its withdrawals flag paused. Without this
    // guard, users could deposit source shares into AL even though `redeemShares` on the
    // source vault is currently disabled — AL would then accumulate those shares with
    // no way to redeem them at the source until the source unpauses. Source's
    // `deposits` and `privilegedOperations` flags are intentionally NOT checked here
    // (they don't affect AL's ability to settle the swap downstream).
    (, bool sourceWithdrawalsPaused, ) = IEmberVaultPauseStatus(a.share).pauseStatus();
    if (sourceWithdrawalsPaused) revert OperationPaused();

    uint256 grossAmount = IERC4626(a.share).convertToAssets(a.shareAmount);
    if (grossAmount == 0) revert ZeroAmount();
    // Dust floor: reject swaps whose gross is small enough to round the fee to 0 while still
    // queueing a near-zero HoldbackEntry. Such entries bloat releaseUsersHoldback gas and, at
    // any unwindingPercentage < 100%, produce a 0 payout that reverts the whole release batch.
    if (grossAmount < config.minSwapGross) revert SwapAmountTooSmall();

    _enforceCapacity(a.share, config, grossAmount);

    // Compute POST-swap utilization (concentration of this source share in AL's TVL),
    // used for BOTH the concentration cap check AND the fee-multiplier lookup. We add
    // grossAmount to the currently-held value because the share_coin is about to be
    // pulled in — the result reflects what the vault WILL hold once the swap completes.
    uint256 utilizationAtSwap;
    {
      uint256 currentHeld = _heldShareValueInCollateral(a.share, a.hasActiveRedemptionHistory);
      uint256 newHeldValue = currentHeld + grossAmount;
      // Absolute held-value ceiling. Unlike the percentage cap below, this is independent of
      // a.vaultTotalAssets, so it can't be slipped by transiently inflating AL's TVL
      // (deposit → swap → withdraw) to dilute the utilization ratio. 0 disables it.
      if (config.maxHeldValueAbsolute != 0 && newHeldValue > config.maxHeldValueAbsolute)
        revert EmberShareHeldValueCapExceeded();
      utilizationAtSwap = a.vaultTotalAssets == 0
        ? 0
        : FixedPointMath.div(newHeldValue, a.vaultTotalAssets);
      if (utilizationAtSwap > config.maxUtilizationPercentage)
        revert EmberShareUtilizationCapExceeded();
    }

    // Resolve the multiplier from the curve at the post-swap utilization. Empty curve /
    // no matching tier resolves to 1× (no scaling).
    uint256 feeMultiplier = _lookupFeeMultiplier(config.feeMultiplierCurve, utilizationAtSwap);
    uint256 effectiveFeePct = FixedPointMath.mul(config.feePercentage, feeMultiplier);
    // L-5: the effective fee (base × multiplier) alone must stay strictly below 100% so the
    // fee can never consume the entire gross (zero/negative payout). Mirrors the config-time
    // guard in updateEmberShareFeeMultiplierTier / setEmberShareWhitelist (A-10).
    if (effectiveFeePct >= PERCENT_MAX) revert InvalidPercentage();

    feeAmount = a.feeWaived ? 0 : FixedPointMath.mul(grossAmount, effectiveFeePct);
    uint256 holdbackAmount = a.holdbackWaived
      ? 0
      : FixedPointMath.mul(grossAmount, config.holdbackPercentage);
    // Defense against misconfigured curve: (base_fee × multiplier) + holdback could
    // mathematically exceed gross even though setEmberShareWhitelist enforced fee + holdback
    // <= 100% on the base. Catch here so the net subtraction can't underflow.
    if (feeAmount + holdbackAmount > grossAmount) revert InvalidPercentage();
    netAmount = grossAmount - feeAmount - holdbackAmount;

    // A-9: slippage guard — the immediate collateral actually transferred to `receiver`
    // (holdback is 0 for a holdback-waived receiver, so `netAmount` is the full payout) must
    // meet the caller's minimum. Checked before any transfer/state change.
    if (netAmount < a.minNetOut) revert SlippageToleranceExceeded();

    IERC20(a.share).safeTransferFrom(a.shareOwner, address(this), a.shareAmount);

    if (holdbackAmount > 0) {
      queue.push(
        HoldbackEntry({
          recipient: a.receiver,
          amount: holdbackAmount,
          released: 0,
          createdAt: block.timestamp,
          sequenceNumber: a.sequenceNumber
        })
      );
    }

    _ensureLiquidity(a.collateralToken, a.strategy, netAmount);
    if (netAmount > 0) {
      IERC20(a.collateralToken).safeTransfer(a.receiver, netAmount);
    }

    emit EmberShareSwapped(
      address(this),
      a.share,
      a.shareOwner,
      a.receiver,
      a.shareAmount,
      grossAmount,
      feeAmount,
      holdbackAmount,
      netAmount,
      config.epochUsedAmount,
      utilizationAtSwap,
      feeMultiplier,
      a.timestamp,
      a.sequenceNumber
    );
  }

  /// @notice One-shot FIFO release of holdback entries at the given unwinding percentage.
  /// @return entriesProcessed Number of entries visited
  /// @return totalReleased Total collateral transferred this call
  /// @return newStartIndex New head pointer (caller must persist into storage)
  function releaseUsersHoldback(
    ReleaseArgs calldata a,
    HoldbackEntry[] storage queue,
    uint256 startIndex,
    mapping(address => uint256) storage unclaimed
  ) external returns (uint256 entriesProcessed, uint256 totalReleased, uint256 newStartIndex) {
    // `unwindingPercentage == 0` is a valid operator tool: it socialises the full
    // loss — every visited entry's payout is 0, entries are dequeued, and the
    // withheld collateral stays in `vault.balance` for the benefit of remaining
    // holders. Useful when a source share is being written off entirely and the
    // operator does not want to pay any holdback out. Above PERCENT_MAX (1e18)
    // is still rejected — that would mean paying MORE than the entry.
    if (a.unwindingPercentage > PERCENT_MAX) revert InvalidPercentage();
    if (a.maxEntries == 0) revert ZeroAmount();

    uint256 queueLength = queue.length;
    if (startIndex >= queueLength) revert EmptyHoldbackQueue();

    uint256 endIndex = startIndex + a.maxEntries;
    if (endIndex > queueLength) endIndex = queueLength;
    entriesProcessed = endIndex - startIndex;

    IEmberConfigBlacklist cfg = IEmberConfigBlacklist(a.protocolConfig);

    // First pass: compute payouts. A recipient that is protocol-blacklisted is SKIPPED — its
    // payout stays 0 and no transfer is attempted. Skipping is what lets the head advance past
    // an entry whose recipient can no longer receive the collateral token (e.g. a token-level
    // blacklist); without it a single stuck recipient at the head would freeze every later
    // release for this share. A blacklisted recipient forfeits its holdback: the collateral
    // simply remains in the vault for the benefit of remaining holders.
    uint256 entriesSkipped;
    // Cache the auto-lift ceiling once for this call — derived from the collateral
    // token's decimals so it stays right-sized regardless of whether AL is deployed
    // against USDC (6d), WETH (18d), WBTC (8d), etc. See `holdbackDustUnits`.
    uint256 dustCeiling = holdbackDustUnits(a.collateralToken);
    uint256[] memory payouts = new uint256[](entriesProcessed);
    for (uint256 i = startIndex; i < endIndex; i++) {
      address recipient = queue[i].recipient;
      // Defense-in-depth invariant: swapEmberShares already rejects address(0) at the
      // call boundary, so no current code path can seed a zero-address entry. Re-asserting
      // here protects the release pass against any FUTURE call site that pushes onto the
      // queue without that guard — otherwise an undeliverable payout to address(0) would
      // escrow into unclaimedHoldback[address(0)], where _claimHoldback would revert on
      // safeTransfer(0) and the funds become permanently unrecoverable. Reverting (rather
      // than silently skipping) is intentional: a zero-address entry signals an upstream
      // bug, so we surface it loudly instead of advancing the head past it.
      if (recipient == address(0)) revert ZeroAddress();
      if (cfg.isAccountBlacklisted(recipient)) {
        entriesSkipped++;
        continue; // payouts[i - startIndex] stays 0
      }
      uint256 entryAmount = queue[i].amount;
      uint256 payout = FixedPointMath.mul(entryAmount, a.unwindingPercentage);
      // A GENUINE-DUST entry whose payout floors to zero at a non-zero unwinding
      // percentage must neither stall the queue nor be silently wiped. The head
      // pointer lives in storage and the operator cannot skip it, so reverting
      // here would let a single sub-precision entry at the head block every
      // entry behind it at any unwindingPercentage < 100% — a permissionless
      // griefing vector, since the swap path lets anyone seed amount==1 entries
      // with tiny share fragments. For entries at or below `dustCeiling` (the
      // decimals-scaled auto-lift ceiling for this vault's collateral) we settle
      // in full and advance: the over-payment relative to the intended haircut
      // is economically negligible and the user is never zeroed out.
      //
      // Two guards on the auto-lift keep it from misfiring:
      //   * `unwindingPercentage > 0` — at 0 the operator explicitly wants to
      //     pay nothing (socialise-full-loss); lifting would defeat that.
      //   * `entryAmount <= dustCeiling` — a real user's holdback that happens
      //     to floor to 0 at a very small percentage must NOT be paid in full.
      //     Above this ceiling, `payout == 0` means the operator asked for
      //     less than one unit of collateral, which is what they get.
      if (
        a.unwindingPercentage > 0 && payout == 0 && entryAmount > 0 && entryAmount <= dustCeiling
      ) {
        payout = entryAmount;
      }
      payouts[i - startIndex] = payout;
      totalReleased += payout;
    }

    // A batch that releases nothing AND skips nothing is meaningless UNLESS the
    // operator explicitly asked for a socialise-full-loss run (unwindingPercentage == 0),
    // where the whole point is to dequeue entries with zero payout. A skip-only
    // batch is also meaningful — it advances the head past blacklisted recipients.
    if (totalReleased == 0 && entriesSkipped == 0 && a.unwindingPercentage != 0)
      revert ZeroAmount();

    if (totalReleased > 0) {
      _ensureLiquidity(a.collateralToken, a.strategy, totalReleased);
    }
    IERC20 token = IERC20(a.collateralToken);
    for (uint256 i = startIndex; i < endIndex; i++) {
      HoldbackEntry storage entry = queue[i];
      uint256 payout = payouts[i - startIndex];
      entry.released = payout;
      if (payout > 0 && !_tryTransfer(token, entry.recipient, payout)) {
        // Recipient is currently unpayable (e.g. a blocklisted collateral address or a
        // reverting token hook). Escrow the payout as a claimable balance rather than
        // letting the transfer revert — otherwise a single bad recipient at the head
        // would wedge the entire FIFO tail behind it, freezing funds owed to every
        // other user. The collateral is already in this contract from _ensureLiquidity
        // above and stays put until the recipient (or anyone) calls claimHoldback(For).
        unclaimed[entry.recipient] += payout;
        emit HoldbackTransferDeferred(
          address(this),
          a.share,
          entry.recipient,
          i,
          payout,
          entry.sequenceNumber,
          a.timestamp,
          a.sequenceNumber
        );
      }
    }

    newStartIndex = endIndex;

    uint256 releasedFromSequenceNumber = queue[startIndex].sequenceNumber;
    uint256 releasedToSequenceNumber = queue[endIndex - 1].sequenceNumber;

    emit HoldbackReleased(
      address(this),
      a.share,
      a.unwindingPercentage,
      entriesProcessed,
      entriesSkipped,
      totalReleased,
      newStartIndex,
      releasedFromSequenceNumber,
      releasedToSequenceNumber,
      a.timestamp,
      a.sequenceNumber
    );
  }

  /// @notice Instant-withdraws `shares` of AL vault shares for collateral, net of the instant
  ///         fee. Holds the full body (validation, burn bookkeeping, payout, fee accrual,
  ///         event) so the AtomicLiquidity implementation stays under EIP-170.
  /// @dev Caller must `_chargeAccruedPlatformFees()` BEFORE invoking (so the time-based fee
  ///      prices the pre-burn TVL) and must persist the returned `newCumulative` /
  ///      `newTotalShares` into its storage scalars. `shareOf` and `platformFee` are mutated
  ///      in place via the passed storage refs.
  /// @return netAmount Collateral transferred to `a.receiver`.
  /// @return newCumulative Updated cumulative instant-withdraw shares (caller persists).
  /// @return newTotalShares Updated total AL shares (caller persists).
  function instantWithdraw(
    InstantWithdrawArgs calldata a,
    mapping(address => uint256) storage shareOf,
    VaultPlatformFeeLib.PlatformFee storage platformFee
  ) external returns (uint256 netAmount, uint256 newCumulative, uint256 newTotalShares) {
    IEmberProtocolConfig configProxy = IEmberProtocolConfig(a.configProxy);
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (a.withdrawalsPaused) revert OperationPaused();

    if (configProxy.isAccountBlacklisted(a.shareOwner)) revert Blacklisted();
    if (configProxy.isAccountBlacklisted(a.receiver)) revert Blacklisted();
    // Reject a null receiver (preserved from the pre-refactor inline check): a zero receiver
    // would otherwise have the net payout transferred to address(0).
    if (a.receiver == address(0)) revert ZeroAddress();

    if (a.shares == 0) revert ZeroAmount();
    if (a.shares < a.minWithdrawableShares) revert InsufficientShares();

    uint256 ownerShares = shareOf[a.shareOwner];
    if (ownerShares < a.shares) revert InsufficientShares();

    // Cumulative cap check. Reverts when the vault's lifetime instant-withdraw budget
    // would be exceeded by this call.
    newCumulative = a.cumulativeBefore + a.shares;
    if (newCumulative > a.maxInstantWithdrawShares) revert InstantWithdrawCapExceeded();

    if (a.grossAmount == 0) revert ZeroAmount();

    uint256 feeAmount = FixedPointMath.mul(a.grossAmount, a.instantWithdrawFeePercentage);
    netAmount = a.grossAmount - feeAmount;

    // Burn user shares and update cumulative bookkeeping before any external calls.
    unchecked {
      shareOf[a.shareOwner] = ownerShares - a.shares;
      newTotalShares = a.totalSharesBefore - a.shares;
    }

    _ensureLiquidity(a.collateralToken, a.strategy, netAmount);

    if (netAmount > 0) {
      IERC20(a.collateralToken).safeTransfer(a.receiver, netAmount);
    }

    // Accrue the fee so it is collected via the existing platform-fee path.
    if (feeAmount > 0) {
      unchecked {
        platformFee.accrued += feeAmount;
      }
    }

    emit InstantWithdrawn(
      address(this),
      a.shareOwner,
      a.receiver,
      a.shares,
      a.grossAmount,
      feeAmount,
      netAmount,
      newCumulative,
      newTotalShares,
      a.timestamp,
      a.sequenceNumber
    );
  }

  /// @notice Settles a single FIFO withdrawal request: pays the receiver (or skips and returns
  ///         the parked shares to the owner on blacklist/cancel/zero), updates queue
  ///         bookkeeping, and emits RequestProcessed (+ WithdrawalFeeCharged). Holds the body
  ///         so the AtomicLiquidity implementation stays under EIP-170.
  /// @dev Caller passes the current `totalShares` / `pendingBurnShares` and persists the
  ///      returned `newTotalShares` / `newPendingBurnShares`. `shareOf` and `accounts` are
  ///      mutated in place. Mirrors the previous in-contract `_processRequest` exactly.
  function processRequest(
    ProcessRequestArgs calldata a,
    mapping(address => WithdrawalQueueLib.Account) storage accounts,
    mapping(address => uint256) storage shareOf
  )
    external
    returns (
      bool skipped,
      bool cancelled,
      uint256 withdrawAmount,
      uint256 sharesBurnt,
      uint256 newTotalShares,
      uint256 newPendingBurnShares
    )
  {
    IEmberProtocolConfig configProxy = IEmberProtocolConfig(a.configProxy);
    withdrawAmount = a.grossWithdrawAmount;
    newTotalShares = a.totalShares;
    newPendingBurnShares = a.pendingBurnShares;

    uint256[] storage cancelSeqNums = accounts[a.owner].cancelWithdrawRequestSequenceNumbers;
    uint256 numCancelledRequests = cancelSeqNums.length;

    uint256 cancelIndex = type(uint256).max;
    for (uint256 i = 0; i < numCancelledRequests; ) {
      if (cancelSeqNums[i] == a.reqSequenceNumber) {
        cancelled = true;
        cancelIndex = i;
        break;
      }
      unchecked {
        i++;
      }
    }

    uint256 indexToUse = cancelled ? cancelIndex : type(uint256).max;

    bool shouldSkip = configProxy.isAccountBlacklisted(a.owner) ||
      configProxy.isAccountBlacklisted(a.receiver) ||
      cancelled ||
      withdrawAmount == 0;

    uint256 permanentFeeCharged = 0;
    uint256 timeBasedFeeCharged = 0;

    if (shouldSkip) {
      if (!cancelled) {
        indexToUse = numCancelledRequests;
      }

      skipped = true;
      withdrawAmount = 0;
      sharesBurnt = 0;

      // Return shares to owner: parked shares move back to user, totalShares unchanged.
      unchecked {
        newPendingBurnShares -= a.shares;
        shareOf[a.owner] += a.shares;
      }
    } else {
      if (a.vaultValidator != address(0)) {
        (permanentFeeCharged, timeBasedFeeCharged) = IEmberVaultValidator(a.vaultValidator)
          .calculateWithdrawalFees(address(this), a.owner, withdrawAmount, a.currentTime);
        uint256 totalFee = permanentFeeCharged + timeBasedFeeCharged;
        if (totalFee > 0) {
          withdrawAmount -= totalFee;
        }
      }

      // Burn shares: remove from pendingBurn AND from totalShares.
      unchecked {
        newPendingBurnShares -= a.shares;
        newTotalShares -= a.shares;
      }
      sharesBurnt = a.shares;

      if (IERC20(a.collateralToken).balanceOf(address(this)) < withdrawAmount)
        revert InsufficientBalance();

      IERC20(a.collateralToken).safeTransfer(a.receiver, withdrawAmount);
    }

    WithdrawalQueueLib.updateAccountState(
      accounts,
      a.owner,
      a.shares,
      a.reqSequenceNumber,
      false,
      indexToUse
    );

    emit RequestProcessed(
      address(this),
      a.owner,
      a.receiver,
      a.shares,
      withdrawAmount,
      a.reqTimestamp,
      a.currentTime,
      skipped,
      cancelled,
      newTotalShares,
      newPendingBurnShares,
      a.sequenceNumber,
      a.reqSequenceNumber
    );

    if (permanentFeeCharged > 0 || timeBasedFeeCharged > 0) {
      emit WithdrawalFeeCharged(
        address(this),
        a.owner,
        a.reqSequenceNumber,
        permanentFeeCharged,
        timeBasedFeeCharged
      );
    }
  }

  /// @notice Settle a recipient's escrowed (undeliverable) holdback balance to `to`. Shared core
  ///         for AtomicLiquidity's claim / recipient-redirect / owner-recovery wrappers — lives
  ///         here (external, DELEGATECALL) to keep the AtomicLiquidity implementation under
  ///         EIP-170. Effects (zeroing the escrow) precede the transfer; a revert on a failed
  ///         send rolls the zeroing back, so the balance stays recoverable.
  /// @param unclaimed Storage ref to the vault's `unclaimedHoldback` mapping.
  /// @param collateralToken The vault's collateral token.
  /// @param recipient The escrow key (original holdback recipient).
  /// @param to Destination for the collateral (== recipient for a plain claim).
  /// @param sequenceNumber The vault's already-incremented sequence, echoed on the event.
  /// @return amount Collateral transferred to `to`.
  function claimHoldback(
    mapping(address => uint256) storage unclaimed,
    address collateralToken,
    address recipient,
    address to,
    uint256 sequenceNumber
  ) external returns (uint256 amount) {
    amount = unclaimed[recipient];
    if (amount == 0) revert ZeroAmount();
    unclaimed[recipient] = 0;
    IERC20(collateralToken).safeTransfer(to, amount);
    emit HoldbackClaimed(
      address(this),
      recipient,
      to,
      amount,
      block.timestamp * 1000,
      sequenceNumber
    );
  }

  /// @notice Forwards collected EmberVault shares for redemption on the source EmberVault.
  /// @dev Returning `true` tells the caller to flip its `hasActiveRedemptionHistory` flag
  ///      to `true` (sticky — never cleared). The flag is a negative cache so the swap
  ///      path can skip the cross-contract `source.accounts(...)` read while the vault
  ///      has never redeemed anything from any source.
  function redeemCollectedEmberShares(
    address share,
    uint256 amount,
    uint256 sequenceNumber,
    uint256 timestamp
  ) external returns (bool) {
    if (share == address(0)) revert ZeroAddress();
    if (amount == 0) revert ZeroAmount();

    uint256 heldBalance = IERC20(share).balanceOf(address(this));
    if (heldBalance < amount) revert InsufficientBalance();

    IERC20(share).forceApprove(share, amount);
    IEmberVaultRedeemable(share).redeemShares(amount, address(this));

    emit EmberSharesRedemptionInitiated(
      address(this),
      share,
      amount,
      heldBalance - amount,
      timestamp,
      sequenceNumber
    );
    return true;
  }

  /// @notice Whitelists (or de-lists) an EmberVault share and writes its swap config.
  /// @dev Caller has already gated on the admin role. Performs the full validation
  ///      + storage write here so the main contract stays small.
  function setEmberShareWhitelist(
    WhitelistArgs calldata a,
    EmberShareConfig storage config
  ) external {
    if (a.share == address(0)) revert ZeroAddress();
    if (a.share == address(this)) revert InvalidValue();
    if (
      // L-5: base fee strictly below 100% — a 100% base fee would make every swap for this
      // source abort on the effective-fee guard, bricking it. Matches the swap-time guard.
      a.feePercentage >= PERCENT_MAX ||
      a.maxCapacityPercentage > PERCENT_MAX ||
      a.holdbackPercentage > PERCENT_MAX ||
      a.maxUtilizationPercentage > PERCENT_MAX
    ) revert InvalidPercentage();
    // fee + holdback must not exceed 100% of gross — otherwise net payout would underflow.
    if (a.feePercentage + a.holdbackPercentage > PERCENT_MAX) revert InvalidPercentage();
    // Enforce asset() match on whitelist-enable so an accidental typo can't
    // route an ETH-denominated share onto a USDC vault (catastrophic drain).
    // On de-whitelist we skip the check so a broken share can still be de-listed.
    if (a.whitelisted && IERC4626(a.share).asset() != a.collateralToken) revert InvalidStrategy();

    config.whitelisted = a.whitelisted;
    config.feePercentage = a.feePercentage;
    config.maxCapacityPercentage = a.maxCapacityPercentage;
    config.holdbackPercentage = a.holdbackPercentage;
    config.maxUtilizationPercentage = a.maxUtilizationPercentage;
    config.minSwapGross = a.minSwapGross;
    config.maxHeldValueAbsolute = a.maxHeldValueAbsolute;
    // `feeMultiplierCurve` is intentionally preserved across whitelist updates — admin
    // administers it via the dedicated tier setter so they don't accidentally wipe a
    // carefully-tuned curve by re-running the whitelist setter.
    //
    // A-10: re-validate the preserved curve against the new base + holdback. The curve is
    // monotonic (enforced at tier-set time), so its top (last) tier carries the largest
    // multiplier — if that tier still leaves a positive payout, every tier does. Blocks raising
    // the base fee / holdback into a config that would retroactively brick high-utilization
    // swaps. Matches both swap-time guards: effective < 100% AND effective + holdback <= 100%.
    uint256 curveLen = config.feeMultiplierCurve.length;
    if (curveLen > 0) {
      uint256 topMultiplier = config.feeMultiplierCurve[curveLen - 1].multiplier;
      uint256 effectiveTop = FixedPointMath.mul(a.feePercentage, topMultiplier);
      if (effectiveTop >= PERCENT_MAX || effectiveTop + a.holdbackPercentage > PERCENT_MAX)
        revert InvalidFeeMultiplier();
    }

    emit EmberShareWhitelistUpdated(
      address(this),
      a.share,
      a.whitelisted,
      a.feePercentage,
      a.maxCapacityPercentage,
      a.holdbackPercentage,
      a.maxUtilizationPercentage,
      a.minSwapGross,
      a.maxHeldValueAbsolute,
      a.timestamp,
      a.sequenceNumber
    );
  }

  /// @notice Upserts or removes a tier on an EmberShare's fee-multiplier curve. Caller has
  ///         already gated on admin role. `remove = true` deletes the tier at `threshold`
  ///         (must exist) and ignores `multiplier`. Otherwise inserts (or updates) the tier
  ///         keeping the curve sorted ascending by threshold.
  /// @param threshold Utilization threshold in 1e18 fixed-point (1e18 = 100%). Must be ≤ 1e18.
  /// @param multiplier Fee multiplier in 1e18 fixed-point (1e18 = 1×). Must be ≥ 1e18 on insert.
  /// @param remove When true: remove the tier at `threshold`; reverts TierNotFound if missing.
  function updateEmberShareFeeMultiplierTier(
    address share,
    uint256 threshold,
    uint256 multiplier,
    bool remove,
    uint256 sequenceNumber,
    uint256 timestamp,
    EmberShareConfig storage config
  ) external {
    if (threshold > PERCENT_MAX) revert InvalidPercentage();

    if (remove) {
      if (!_removeFeeMultiplierTier(config.feeMultiplierCurve, threshold)) revert TierNotFound();
      emit EmberShareFeeMultiplierTierUpdated(
        address(this),
        share,
        threshold,
        0,
        true,
        timestamp,
        sequenceNumber
      );
    } else {
      // A-10: multiplier in [1×, MAX_FEE_MULTIPLIER] — at least 1× (a tier never discounts the
      // base fee) and bounded above so `base × multiplier` can't overflow / be absurd.
      if (multiplier < PERCENT_MAX || multiplier > MAX_FEE_MULTIPLIER)
        revert InvalidFeeMultiplier();
      // A-10: reject a tier that would brick swaps at its utilization. Match BOTH swap-time
      // guards exactly — the effective fee (base × multiplier) alone must be strictly below
      // 100%, and effective + holdback must stay within 100% — so the misconfiguration fails
      // loudly here instead of silently aborting swaps once utilization reaches this tier.
      uint256 effective = FixedPointMath.mul(config.feePercentage, multiplier);
      if (effective >= PERCENT_MAX || effective + config.holdbackPercentage > PERCENT_MAX)
        revert InvalidFeeMultiplier();
      _upsertFeeMultiplierTier(config.feeMultiplierCurve, threshold, multiplier);
      // A-10: bound the curve length (lookup is O(n) per swap) and keep multipliers
      // non-decreasing with the ascending thresholds — a higher-utilization tier must not
      // charge a lower fee than a lower one.
      if (config.feeMultiplierCurve.length > MAX_FEE_MULTIPLIER_TIERS)
        revert InvalidFeeMultiplier();
      _assertFeeCurveMonotonic(config.feeMultiplierCurve);
      emit EmberShareFeeMultiplierTierUpdated(
        address(this),
        share,
        threshold,
        multiplier,
        false,
        timestamp,
        sequenceNumber
      );
    }
  }

  // `getEmberShareUtilization` removed — no caller in main contract or tests. Off-chain
  // consumers compute utilization by simulating against the on-chain swap path or by
  // reading `IERC20(share).balanceOf(vault)` + `source.accounts(vault)` directly.

  /// @notice Sets per-address fee and holdback waivers for the EmberShare cross-vault swap.
  function setSwapWaiver(
    address account,
    bool feeWaived,
    bool holdbackWaived,
    uint256 sequenceNumber,
    uint256 timestamp,
    mapping(address => bool) storage feeWaivedAddresses,
    mapping(address => bool) storage holdbackWaivedAddresses
  ) external {
    if (account == address(0)) revert ZeroAddress();
    feeWaivedAddresses[account] = feeWaived;
    holdbackWaivedAddresses[account] = holdbackWaived;
    emit SwapWaiverUpdated(
      address(this),
      account,
      feeWaived,
      holdbackWaived,
      timestamp,
      sequenceNumber
    );
  }

  /// @notice Read-only solvency signal: collateral backing minus modeled claims. See the
  ///         AtomicLiquidity.solvencyMargin wrapper for full semantics. Lives here (external,
  ///         DELEGATECALL) to keep the AtomicLiquidity implementation under EIP-170.
  function solvencyMargin(
    address collateralToken,
    address strategy,
    uint256 totalAssets,
    uint256 accrued
  ) external view returns (int256) {
    uint256 stratAssets = strategy == address(0)
      ? 0
      : IERC4626(strategy).convertToAssets(IERC4626(strategy).balanceOf(address(this)));
    uint256 backing = IERC20(collateralToken).balanceOf(address(this)) + stratAssets;
    uint256 claims = totalAssets + accrued;
    return int256(backing) - int256(claims);
  }

  /// @notice Assets currently redeemable from the strategy (0 if unset). External/DELEGATECALL
  ///         to keep the AtomicLiquidity implementation under EIP-170.
  function strategyAssets(address strategy) external view returns (uint256) {
    return
      strategy == address(0)
        ? 0
        : IERC4626(strategy).convertToAssets(IERC4626(strategy).balanceOf(address(this)));
  }

  /// @notice Current remaining per-epoch swap capacity for an EmberShare (collateral units).
  ///         See the AtomicLiquidity.availableEmberShareCapacity wrapper. Lives here to keep
  ///         the implementation under EIP-170.
  function availableEmberShareCapacity(
    address share,
    EmberShareConfig storage config
  ) external view returns (uint256) {
    if (!config.whitelisted) return 0;
    uint256 cap = FixedPointMath.mul(IERC4626(share).totalAssets(), config.maxCapacityPercentage);
    bool epochExpired = config.epochStartedAt > 0 &&
      block.timestamp >= config.epochStartedAt + EMBER_SHARE_EPOCH_DURATION;
    uint256 used = epochExpired ? 0 : config.epochUsedAmount;
    return cap > used ? cap - used : 0;
  }

  // ============ Internal helpers ============

  /// @dev Upsert a tier in a sorted-ascending curve. Updates the multiplier in place if a
  ///      tier exists at `threshold`; otherwise inserts at the position that preserves the
  ///      ascending invariant. Caller has validated `multiplier >= 1e18`.
  function _upsertFeeMultiplierTier(
    FeeMultiplierTier[] storage curve,
    uint256 threshold,
    uint256 multiplier
  ) internal {
    uint256 len = curve.length;
    for (uint256 i = 0; i < len; i++) {
      FeeMultiplierTier storage tier = curve[i];
      if (tier.threshold == threshold) {
        tier.multiplier = multiplier;
        return;
      }
      if (tier.threshold > threshold) {
        // Insert at position i by extending the array and shifting the tail right.
        curve.push();
        for (uint256 j = len; j > i; j--) {
          curve[j] = curve[j - 1];
        }
        curve[i] = FeeMultiplierTier({ threshold: threshold, multiplier: multiplier });
        return;
      }
    }
    // Largest threshold so far — append.
    curve.push(FeeMultiplierTier({ threshold: threshold, multiplier: multiplier }));
  }

  /// @dev A-10: assert the curve's multipliers are non-decreasing across its (already
  ///      ascending) thresholds — a higher-utilization tier can never charge a lower fee than a
  ///      lower-utilization one. Keeps the "top tier = largest multiplier" invariant the
  ///      whitelist re-validation relies on.
  function _assertFeeCurveMonotonic(FeeMultiplierTier[] storage curve) internal view {
    uint256 len = curve.length;
    for (uint256 i = 1; i < len; i++) {
      if (curve[i].multiplier < curve[i - 1].multiplier) revert InvalidFeeMultiplier();
    }
  }

  /// @dev Remove the tier with the matching `threshold`. Returns whether anything was removed.
  function _removeFeeMultiplierTier(
    FeeMultiplierTier[] storage curve,
    uint256 threshold
  ) internal returns (bool) {
    uint256 len = curve.length;
    for (uint256 i = 0; i < len; i++) {
      if (curve[i].threshold == threshold) {
        // Shift the tail left by one to preserve the ascending order.
        for (uint256 j = i; j + 1 < len; j++) {
          curve[j] = curve[j + 1];
        }
        curve.pop();
        return true;
      }
    }
    return false;
  }

  /// @dev Walk a sorted-ascending curve and return the multiplier of the highest threshold
  ///      `<= utilization`. Returns `PERCENT_MAX` (1×) when empty or no tier matches.
  function _lookupFeeMultiplier(
    FeeMultiplierTier[] storage curve,
    uint256 utilization
  ) internal view returns (uint256) {
    uint256 len = curve.length;
    uint256 multiplier = PERCENT_MAX;
    for (uint256 i = 0; i < len; i++) {
      FeeMultiplierTier storage tier = curve[i];
      if (utilization >= tier.threshold) {
        multiplier = tier.multiplier;
      } else {
        // Ascending — once we pass utilization, the rest are higher.
        break;
      }
    }
    return multiplier;
  }

  /// @dev Returns the collateral-denominated value of receipt tokens AL is exposed to for
  ///      `share`. Includes custodied shares (in AL's ERC-20 balance of the source) and,
  ///      when `hasActiveRedemptionHistory` is true, shares AL has pending on the source's
  ///      withdrawal queue. Returns 0 if AL holds nothing.
  function _heldShareValueInCollateral(
    address share,
    bool hasActiveRedemptionHistory
  ) internal view returns (uint256) {
    uint256 custodied = IERC20(share).balanceOf(address(this));
    uint256 pending = 0;
    if (hasActiveRedemptionHistory) {
      pending = IEmberVaultAccount(share).accounts(address(this));
    }
    uint256 total = custodied + pending;
    if (total == 0) return 0;
    return IERC4626(share).convertToAssets(total);
  }

  /// @dev Current utilization in 1e18 fixed-point. Returns 0 if held value is 0 or TVL is 0.
  function _computeUtilization(
    address share,
    bool hasActiveRedemptionHistory,
    uint256 vaultTotalAssets
  ) internal view returns (uint256) {
    uint256 heldValue = _heldShareValueInCollateral(share, hasActiveRedemptionHistory);
    if (heldValue == 0 || vaultTotalAssets == 0) return 0;
    return FixedPointMath.div(heldValue, vaultTotalAssets);
  }

  function _enforceCapacity(
    address share,
    EmberShareConfig storage config,
    uint256 grossAmount
  ) internal {
    uint256 nowTs = block.timestamp;
    uint256 startedAt = config.epochStartedAt;
    uint256 used = config.epochUsedAmount;

    if (startedAt > 0 && nowTs >= startedAt + EMBER_SHARE_EPOCH_DURATION) {
      startedAt = 0;
      used = 0;
    }

    uint256 vaultTVL = IERC4626(share).totalAssets();
    uint256 cap = FixedPointMath.mul(vaultTVL, config.maxCapacityPercentage);

    if (used + grossAmount > cap) revert EmberShareCapExceeded();

    if (startedAt == 0) {
      config.epochStartedAt = nowTs;
    }
    unchecked {
      config.epochUsedAmount = used + grossAmount;
    }
  }

  /// @notice External entry point that AtomicLiquidity calls via DELEGATECALL when it
  ///         needs to satisfy a payout amount that may exceed the idle balance. Avoids
  ///         duplicating the helper's body in the main contract — letting it stay under
  ///         the 24,576-byte EIP-170 ceiling.
  function ensureLiquidity(address collateralToken, address strategy, uint256 needed) external {
    _ensureLiquidity(collateralToken, strategy, needed);
  }

  /// @dev Ensures the contract holds at least `needed` of collateral, pulling the deficit
  ///      from the strategy if configured.
  /// @notice Non-reverting ERC-20 transfer used inside the batch release loop.
  /// @dev INTENTIONALLY diverges from `SafeERC20.safeTransfer` — do NOT replace with it.
  ///      `safeTransfer` bubbles up the underlying revert, which is exactly what we need to
  ///      AVOID here: a single unpayable recipient (e.g. blacklisted on a USDC-style token,
  ///      a contract whose `_beforeTokenTransfer` hook reverts, an upgraded token that
  ///      added a new restriction) would otherwise abort the whole batch and freeze the
  ///      FIFO holdback queue behind it. We absorb the failure, return `false`, and let
  ///      the caller escrow the payout into `unclaimedHoldback` so the head advances and
  ///      the funds remain claimable once the recipient is payable again.
  ///
  ///      Success criteria still mirror SafeERC20 in the happy path: the low-level call
  ///      must succeed AND either return no data (USDT-style) OR a decoded `true`. A
  ///      revert with returndata, a revert without returndata, and a `false` return all
  ///      map to the same "defer" outcome. The behavior is regression-tested in
  ///      test/AtomicLiquidityHoldbackDeferral.test.ts via BlocklistableERC20.
  function _tryTransfer(IERC20 token, address to, uint256 amount) private returns (bool) {
    (bool ok, bytes memory ret) = address(token).call(
      abi.encodeCall(IERC20.transfer, (to, amount))
    );
    return ok && (ret.length == 0 || abi.decode(ret, (bool)));
  }

  function _ensureLiquidity(address collateralToken, address strategy, uint256 needed) internal {
    if (needed == 0) return;
    IERC20 token = IERC20(collateralToken);
    uint256 vaultBalance = token.balanceOf(address(this));
    if (vaultBalance >= needed) return;

    uint256 deficit;
    unchecked {
      deficit = needed - vaultBalance;
    }
    if (strategy == address(0)) revert InsufficientBalance();
    IERC4626(strategy).withdraw(deficit, address(this), address(this));
    // Defense-in-depth: ERC-4626 spec says withdraw must deliver exactly `deficit`
    // or revert, but exotic strategies (paused / rate-limited / fee-bearing) may
    // silently short. Catch that here so the calling flow fails cleanly without
    // burning user shares.
    if (token.balanceOf(address(this)) < needed) revert StrategyShortDelivery();
  }
}
