// SPDX-License-Identifier: UNLICENSED
/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.
*/
pragma solidity ^0.8.22;

/// @title VaultPlatformFeeLib
/// @notice Single source of truth for the time-based platform-fee accrual shared by
///         EmberVault, EmberETHVault and AtomicLiquidity. Previously each vault inlined a
///         near-identical ~50-line copy; consolidating here removes that duplication and
///         keeps the implementations under EIP-170's 24,576-byte limit.
/// @dev External library: `charge` runs via DELEGATECALL in the calling vault's storage
///      context, so the `PlatformFee storage` reference and `address(this)` resolve to the
///      vault proxy. Each vault declares its `platformFee` storage slot as
///      `VaultPlatformFeeLib.PlatformFee` so the slot type matches this parameter.
library VaultPlatformFeeLib {
  /// @dev FEE_DENOMINATOR = 1e18 * 365 days in ms. The fee is
  ///      `tvlNet * platformFeePercentage * elapsedMs / FEE_DENOMINATOR`, where the
  ///      percentage is 1e18-scaled and the 1e18 is folded into the denominator.
  uint256 internal constant FEE_DENOMINATOR = 31_536_000_000_000_000_000_000_000_000;

  struct PlatformFee {
    // the amount of platform fee accrued on the vault
    uint256 accrued;
    // timestamp (ms) at which the platform fee was last charged
    uint256 lastChargedAt;
    // the platform fee percentage (1e18 = 100% per year)
    uint256 platformFeePercentage;
  }

  /// @notice Re-declared in each vault too. DELEGATECALL keeps `address(this)` as the proxy,
  ///         so off-chain indexers see the event emitted by the vault address.
  event VaultPlatformFeeCharged(
    address indexed vault,
    uint256 feeAmount,
    uint256 totalAccrued,
    uint256 chargedAt,
    uint256 sequenceNumber
  );

  /// @notice Settles accrued time-based platform fees for the elapsed period on the CURRENT
  ///         TVL. Callers must invoke this BEFORE any operation that mutates TVL (deposit
  ///         mint, withdrawal burn) so the elapsed interval is priced on the right TVL.
  /// @param platformFee Storage ref to the vault's platform-fee accumulator.
  /// @param tvl Current total assets under management.
  /// @param currentTimeMs Current chain time in milliseconds.
  /// @param nextSequenceIfBumped The sequence number to record on the event if a fee is
  ///        charged (the vault advances its own `sequenceNumber` to this on a `true` return).
  /// @return didCharge True iff a non-zero fee was accrued (the only case that bumps the
  ///         sequence and emits an event).
  function charge(
    PlatformFee storage platformFee,
    uint256 tvl,
    uint256 currentTimeMs,
    uint256 nextSequenceIfBumped
  ) external returns (bool didCharge) {
    uint256 lastChargedAt = platformFee.lastChargedAt;
    if (currentTimeMs <= lastChargedAt) return false;

    uint256 elapsedTimeMs;
    unchecked {
      elapsedTimeMs = currentTimeMs - lastChargedAt;
    }

    // When TVL drops to (or below) accrued, no new fee accrues — still advance
    // `lastChargedAt` so the same elapsed period isn't re-priced later.
    if (tvl == 0) {
      platformFee.lastChargedAt = currentTimeMs;
      return false;
    }

    uint256 accruedFees = platformFee.accrued;
    uint256 tvlForFeeCalc = tvl > accruedFees ? tvl - accruedFees : 0;
    if (tvlForFeeCalc == 0) {
      platformFee.lastChargedAt = currentTimeMs;
      return false;
    }

    // fee = tvlNet * pct * elapsedMs / FEE_DENOMINATOR. Multiplications could overflow
    // at extreme magnitudes — Solidity's checked arithmetic will catch.
    uint256 feeAmount = (tvlForFeeCalc * platformFee.platformFeePercentage * elapsedTimeMs) /
      FEE_DENOMINATOR;

    platformFee.lastChargedAt = currentTimeMs;
    if (feeAmount == 0) return false;

    uint256 newAccrued;
    unchecked {
      newAccrued = accruedFees + feeAmount;
      platformFee.accrued = newAccrued;
    }

    emit VaultPlatformFeeCharged(
      address(this),
      feeAmount,
      newAccrued,
      currentTimeMs,
      nextSequenceIfBumped
    );
    return true;
  }
}
