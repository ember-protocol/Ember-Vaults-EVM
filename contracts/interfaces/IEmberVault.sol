/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.

  This source code is provided for transparency and verification only.
  Use, modification, reproduction, or redeployment of this code 
  requires prior written permission from the Ember Protocol Inc.
*/

pragma solidity ^0.8.22;

import "./IEmberVaultValidator.sol";

/// @title Ember Vault Interface
/// @notice Interface for EmberVault functions called by EmberProtocolConfig
interface IEmberVault {
  // Structs (must match EmberVault)
  struct Roles {
    address admin;
    address operator;
    address rateManager;
  }

  struct PauseStatus {
    bool deposits;
    bool withdrawals;
    bool privilegedOperations;
  }

  struct Rate {
    uint256 value;
    uint256 maxRateChangePerUpdate;
    uint256 rateUpdateInterval;
    uint256 lastUpdatedAt;
  }

  struct PlatformFee {
    uint256 accrued;
    uint256 lastChargedAt;
    uint256 platformFeePercentage;
  }

  // Getter functions for authorization checks
  function roles() external view returns (Roles memory);
  function owner() external view returns (address);
  function subAccounts(address account) external view returns (bool);
  function maxTVL() external view returns (uint256);
  function minWithdrawableShares() external view returns (uint256);
  function totalAssets() external view returns (uint256);
  function rate() external view returns (Rate memory);
  function platformFee() external view returns (PlatformFee memory);
  function sequenceNumber() external view returns (uint256);
  function vaultValidator() external view returns (IEmberVaultValidator);

  // Setter functions called by EmberProtocolConfig
  // Each function receives the original caller for authorization verification
  // The vault verifies: (1) msg.sender is protocol config, (2) caller has required role

  /// @notice Sets the max TVL of the vault (requires admin role)
  function setMaxTVL(address caller, uint256 newMaxTVL) external;

  /// @notice Sets the vault rate update interval (requires admin role)
  function setRateUpdateInterval(address caller, uint256 newInterval) external;

  /// @notice Sets the maximum allowed rate change per update (requires admin role)
  function setMaxRateChangePerUpdate(address caller, uint256 newMaxRateChangePerUpdate) external;

  /// @notice Sets the vault admin (requires owner role)
  function setAdmin(address caller, address newAdmin) external;

  /// @notice Sets the vault operator (requires admin role)
  function setOperator(address caller, address newOperator) external;

  /// @notice Sets the vault rate manager (requires admin role)
  function setRateManager(address caller, address newRateManager) external;

  /// @notice Sets the vault fee percentage (requires admin role)
  function setFeePercentage(address caller, uint256 newFeePercentage) external;

  /// @notice Updates the vault name (requires admin role)
  function setVaultName(address caller, string calldata newName) external;

  /// @notice Updates the minimum withdrawable shares (requires admin role)
  function setMinWithdrawableShares(address caller, uint256 newMinWithdrawableShares) external;

  /// @notice Sets or removes a sub-account (requires admin role)
  function setSubAccountStatus(address caller, address account, bool isSubAccount) external;

  /// @notice Sets the pause status for a specific operation (requires admin role)
  function setPausedStatus(address caller, string calldata operation, bool paused) external;

  /// @notice Sets the vault validator contract address (requires admin role)
  function setVaultValidator(address caller, address _validator) external;
}
