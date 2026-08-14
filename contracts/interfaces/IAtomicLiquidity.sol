/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.

  This source code is provided for transparency and verification only.
  Use, modification, reproduction, or redeployment of this code
  requires prior written permission from the Ember Protocol Inc.
*/

pragma solidity ^0.8.22;

/// @title Atomic Liquidity Vault Interface
/// @notice Subset of AtomicLiquidity's external surface that EmberProtocolConfig calls
///         when forwarding admin operations. Mirrors the `caller`-as-first-arg pattern
///         used by IEmberVault — the vault re-verifies the caller's role on its side.
interface IAtomicLiquidity {
  /// @notice Sets (or clears) the external ERC-4626 strategy.
  function setStrategy(address caller, address newStrategy) external;

  /// @notice Sets the cumulative cap (in shares) for instantWithdraw redemptions.
  function setMaxInstantWithdrawShares(address caller, uint256 newMax) external;

  /// @notice Sets the fee percentage charged on instant withdrawals (1e18 = 100%).
  function setInstantWithdrawFeePercentage(address caller, uint256 newFeePercentage) external;

  /// @notice Whitelists (or de-lists) an EmberVault share for the cross-vault instant swap.
  function setEmberShareWhitelist(
    address caller,
    address share,
    bool whitelisted,
    uint256 feePercentage,
    uint256 maxCapacityPercentage,
    uint256 holdbackPercentage,
    uint256 maxUtilizationPercentage,
    uint256 minSwapGross,
    uint256 maxHeldValueAbsolute
  ) external;

  /// @notice Sets per-address fee and holdback waivers for the EmberShare cross-vault swap.
  function setSwapWaiver(
    address caller,
    address account,
    bool feeWaived,
    bool holdbackWaived
  ) external;

  /// @notice Adds, updates, or removes a fee-multiplier curve tier for an EmberShare.
  function updateEmberShareFeeMultiplierTier(
    address caller,
    address share,
    uint256 threshold,
    uint256 multiplier,
    bool remove
  ) external;
}
