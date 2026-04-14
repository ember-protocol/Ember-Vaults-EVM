/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.

  This source code is provided for transparency and verification only.
  Use, modification, reproduction, or redeployment of this code 
  requires prior written permission from the Ember Protocol Inc.
*/

pragma solidity ^0.8.22;

// Custom errors
error Unauthorized();
error ZeroAddress();
error InvalidValue();
error SameValue();
error ProtocolPaused();
error Blacklisted();
error InvalidInterval();
error InvalidRate();
error InvalidFeePercentage();

/// @title Ember Protocol Config Interface
/// @notice Describes the functions/events exposed by `EmberProtocolConfig`
interface IEmberProtocolConfig {
  /// @dev Replicates the initializer that must be called for upgradeable proxies.
  function initialize(address initialOwner, address _platformFeeRecipient) external;

  function version() external pure returns (string memory);

  // Protocol admin functions (owner only)
  function pauseNonAdminOperations(bool pauseFlag) external;
  function updatePlatformFeeRecipient(address recipient) external;
  function updateMinRate(uint256 minRate_) external;
  function updateMaxRate(uint256 maxRate_) external;
  function updateDefaultRate(uint256 defaultRate_) external;
  function updateMaxFeePercentage(uint256 maxFeePercentage_) external;
  function updateMinRateInterval(uint256 minRateInterval_) external;
  function updateMaxRateInterval(uint256 maxRateInterval_) external;
  function setBlacklistedAccount(address account, bool blacklisted) external;

  // Vault admin functions
  function updateVaultMaxTVL(address vault, uint256 newMaxTVL) external;
  function updateVaultRateUpdateInterval(address vault, uint256 newInterval) external;
  function updateVaultMaxRateChangePerUpdate(
    address vault,
    uint256 newMaxRateChangePerUpdate
  ) external;
  function updateVaultAdmin(address vault, address newAdmin) external;
  function updateVaultOperator(address vault, address newOperator) external;
  function updateVaultRateManager(address vault, address newRateManager) external;
  function updateVaultFeePercentage(address vault, uint256 newFeePercentage) external;
  function updateVaultName(address vault, string calldata newName) external;
  function updateVaultMinWithdrawableShares(
    address vault,
    uint256 newMinWithdrawableShares
  ) external;
  function setVaultSubAccount(address vault, address account, bool isSubAccount) external;
  function setVaultPausedStatus(address vault, string calldata operation, bool paused) external;

  // Getter functions
  function isAccountBlacklisted(address account) external view returns (bool);
  function getProtocolPauseStatus() external view returns (bool);
  function getPlatformFeeRecipient() external view returns (address);
  function getMinRate() external view returns (uint256);
  function getMaxRate() external view returns (uint256);
  function getDefaultRate() external view returns (uint256);
  function getMinRateInterval() external view returns (uint256);
  function getMaxRateInterval() external view returns (uint256);
  function getMaxAllowedFeePercentage() external view returns (uint256);
  function verifyProtocolNotPaused() external view;
  function verifyAccountNotBlacklisted(address account) external view;

  // Events
  event PauseNonAdminOperations(bool paused);
  event SupportedVersionUpdated(uint256 previousVersion, uint256 newVersion);
  event PlatformFeeRecipientUpdated(address previousRecipient, address newRecipient);
  event MinRateUpdated(uint256 previousRate, uint256 newRate);
  event MaxRateUpdated(uint256 previousRate, uint256 newRate);
  event DefaultRateUpdated(uint256 previousRate, uint256 newRate);
  event MinRateIntervalUpdated(uint256 previousInterval, uint256 newInterval);
  event MaxRateIntervalUpdated(uint256 previousInterval, uint256 newInterval);
  event MaxAllowedFeePercentageUpdated(uint256 previousFee, uint256 newFee);
  event BlacklistedAccountUpdated(address indexed account, bool isBlacklisted);
}
