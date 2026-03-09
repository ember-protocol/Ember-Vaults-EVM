/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.

  This source code is provided for transparency and verification only.
  Use, modification, reproduction, or redeployment of this code 
  requires prior written permission from the Ember Protocol Inc.
*/

pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IEmberProtocolConfig.sol";
import "./interfaces/IEmberVault.sol";

/// @title Ember Protocol Configuration
/// @notice Stores configuration parameters that govern the vault system and manages vault admin operations
contract EmberProtocolConfig is
  Initializable,
  UUPSUpgradeable,
  OwnableUpgradeable,
  ReentrancyGuardUpgradeable,
  IEmberProtocolConfig
{
  // Constants
  uint256 public constant MIN_RATE = 250_000_000_000_000_000;
  uint256 public constant MAX_RATE = 5_000_000_000_000_000_000;
  uint256 public constant DEFAULT_RATE = 1_000_000_000_000_000_000;
  uint256 public constant MIN_RATE_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
  uint256 public constant MAX_RATE_INTERVAL = 24 * 60 * 60 * 1000; // 1 day in milliseconds
  uint256 public constant MAX_FEE_PERCENTAGE = 100_000_000_000_000_000;

  // Structs
  struct ProtocolConfig {
    bool pause;
    address platformFeeRecipient;
    uint256 minRate;
    uint256 maxRate;
    uint256 defaultRate;
    uint256 minRateInterval;
    uint256 maxRateInterval;
    uint256 maxFeePercentage;
  }

  // State variables
  ProtocolConfig public protocolConfig;

  /// @notice list of all blacklisted addresses
  mapping(address => bool) public blacklistedAccounts;

  /**
   * @dev Reserved storage gap for future upgrades.
   * This allows adding new state variables without shifting storage slots.
   * See: https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable#storage-gaps
   */
  uint256[50] private __gap;

  // Events are inherited from IEmberProtocolConfig

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /// @param _platformFeeRecipient Recipient for all platform fees
  /**
   * @dev Initialize function replaces constructor for upgradeable contracts
   * @param initialOwner Address of the contract owner
   * @param _platformFeeRecipient Recipient for all platform fees
   */
  function initialize(address initialOwner, address _platformFeeRecipient) public initializer {
    __Ownable_init(initialOwner);
    __UUPSUpgradeable_init();
    __ReentrancyGuard_init();

    if (_platformFeeRecipient == address(0)) revert ZeroAddress();

    protocolConfig = ProtocolConfig({
      pause: false,
      platformFeeRecipient: _platformFeeRecipient,
      minRate: MIN_RATE,
      maxRate: MAX_RATE,
      defaultRate: DEFAULT_RATE,
      minRateInterval: MIN_RATE_INTERVAL,
      maxRateInterval: MAX_RATE_INTERVAL,
      maxFeePercentage: MAX_FEE_PERCENTAGE
    });
  }

  /// @notice Pauses or unpauses non-admin operations
  /// @param pauseFlag True to pause, false to resume
  function pauseNonAdminOperations(bool pauseFlag) external nonReentrant onlyOwner {
    if (pauseFlag == protocolConfig.pause) revert SameValue();
    protocolConfig.pause = pauseFlag;
    emit PauseNonAdminOperations(pauseFlag);
  }

  /// @notice Updates where platform fees are sent
  function updatePlatformFeeRecipient(address recipient) external nonReentrant onlyOwner {
    if (recipient == address(0)) revert ZeroAddress();
    if (recipient == protocolConfig.platformFeeRecipient) revert SameValue();
    address previous = protocolConfig.platformFeeRecipient;
    protocolConfig.platformFeeRecipient = recipient;
    emit PlatformFeeRecipientUpdated(previous, recipient);
  }

  /// @notice Updates the minimum allowable rate
  function updateMinRate(uint256 minRate_) external nonReentrant onlyOwner {
    if (minRate_ == 0 || minRate_ > protocolConfig.maxRate || minRate_ > protocolConfig.defaultRate)
      revert InvalidRate();
    if (minRate_ == protocolConfig.minRate) revert SameValue();
    uint256 previous = protocolConfig.minRate;
    protocolConfig.minRate = minRate_;
    emit MinRateUpdated(previous, minRate_);
  }

  /// @notice Updates the maximum allowable rate
  function updateMaxRate(uint256 maxRate_) external nonReentrant onlyOwner {
    if (maxRate_ < protocolConfig.minRate || maxRate_ < protocolConfig.defaultRate)
      revert InvalidRate();
    if (maxRate_ == protocolConfig.maxRate) revert SameValue();
    uint256 previous = protocolConfig.maxRate;
    protocolConfig.maxRate = maxRate_;
    emit MaxRateUpdated(previous, maxRate_);
  }

  /// @notice Updates the default rate applied to new vaults
  function updateDefaultRate(uint256 defaultRate_) external nonReentrant onlyOwner {
    if (defaultRate_ < protocolConfig.minRate || defaultRate_ > protocolConfig.maxRate)
      revert InvalidRate();
    if (defaultRate_ == protocolConfig.defaultRate) revert SameValue();
    uint256 previous = protocolConfig.defaultRate;
    protocolConfig.defaultRate = defaultRate_;
    emit DefaultRateUpdated(previous, defaultRate_);
  }

  /// @notice Updates the maximum fee percentage
  function updateMaxFeePercentage(uint256 maxFeePercentage_) external nonReentrant onlyOwner {
    if (maxFeePercentage_ > MAX_FEE_PERCENTAGE) revert InvalidFeePercentage();
    if (maxFeePercentage_ == protocolConfig.maxFeePercentage) revert SameValue();
    uint256 previous = protocolConfig.maxFeePercentage;
    protocolConfig.maxFeePercentage = maxFeePercentage_;
    emit MaxAllowedFeePercentageUpdated(previous, maxFeePercentage_);
  }

  /// @notice Updates the minimum interval for rate changes
  function updateMinRateInterval(uint256 minRateInterval_) external nonReentrant onlyOwner {
    if (minRateInterval_ < 60 * 1_000 || minRateInterval_ > protocolConfig.maxRateInterval)
      revert InvalidInterval();
    if (minRateInterval_ == protocolConfig.minRateInterval) revert SameValue();
    uint256 previous = protocolConfig.minRateInterval;
    protocolConfig.minRateInterval = minRateInterval_;
    emit MinRateIntervalUpdated(previous, minRateInterval_);
  }

  /// @notice Updates the maximum interval for rate changes
  function updateMaxRateInterval(uint256 maxRateInterval_) external nonReentrant onlyOwner {
    if (maxRateInterval_ < protocolConfig.minRateInterval || maxRateInterval_ > MAX_RATE_INTERVAL)
      revert InvalidInterval();
    if (maxRateInterval_ == protocolConfig.maxRateInterval) revert SameValue();
    uint256 previous = protocolConfig.maxRateInterval;
    protocolConfig.maxRateInterval = maxRateInterval_;
    emit MaxRateIntervalUpdated(previous, maxRateInterval_);
  }

  /// @notice Adds or removes an account from the blacklist
  function setBlacklistedAccount(
    address account,
    bool blacklisted
  ) external nonReentrant onlyOwner {
    if (account == address(0)) revert ZeroAddress();
    if (blacklistedAccounts[account] == blacklisted) revert SameValue();
    blacklistedAccounts[account] = blacklisted;
    emit BlacklistedAccountUpdated(account, blacklisted);
  }

  // ============================================
  // Vault Admin Functions
  // ============================================
  // These functions validate parameters then forward to the vault with the original caller.
  // The vault verifies the caller has the required role (admin/owner).

  /// @notice Updates the max TVL of a vault
  /// @dev Validates parameters, then forwards to vault which verifies caller is admin
  /// @param vault The vault address
  /// @param newMaxTVL The new maximum total value locked
  function updateVaultMaxTVL(address vault, uint256 newMaxTVL) external nonReentrant {
    if (newMaxTVL == 0) revert InvalidValue();
    if (newMaxTVL == IEmberVault(vault).maxTVL()) revert SameValue();

    uint256 currentTVL = IEmberVault(vault).totalAssets();
    if (currentTVL > newMaxTVL) revert InvalidValue();

    IEmberVault(vault).setMaxTVL(msg.sender, newMaxTVL);
  }

  /// @notice Changes the vault rate update interval
  /// @dev Validates parameters, then forwards to vault which verifies caller is admin
  /// @param vault The vault address
  /// @param newInterval The new rate update interval (in milliseconds)
  function updateVaultRateUpdateInterval(address vault, uint256 newInterval) external nonReentrant {
    if (
      newInterval < protocolConfig.minRateInterval || newInterval > protocolConfig.maxRateInterval
    ) revert InvalidInterval();
    if (newInterval == IEmberVault(vault).rate().rateUpdateInterval) revert SameValue();

    IEmberVault(vault).setRateUpdateInterval(msg.sender, newInterval);
  }

  /// @notice Changes the vault admin
  /// @dev Validates parameters, then forwards to vault which verifies caller is owner
  /// @param vault The vault address
  /// @param newAdmin The new admin address
  function updateVaultAdmin(address vault, address newAdmin) external nonReentrant {
    if (newAdmin == address(0)) revert ZeroAddress();

    IEmberVault.Roles memory vaultRoles = IEmberVault(vault).roles();
    if (newAdmin == vaultRoles.admin) revert SameValue();
    if (newAdmin == vaultRoles.rateManager || newAdmin == vaultRoles.operator)
      revert InvalidValue();
    if (IEmberVault(vault).subAccounts(newAdmin)) revert InvalidValue();
    if (blacklistedAccounts[newAdmin]) revert Blacklisted();

    IEmberVault(vault).setAdmin(msg.sender, newAdmin);
  }

  /// @notice Changes the vault operator
  /// @dev Validates parameters, then forwards to vault which verifies caller is admin
  /// @param vault The vault address
  /// @param newOperator The new operator address
  function updateVaultOperator(address vault, address newOperator) external nonReentrant {
    if (newOperator == address(0)) revert ZeroAddress();

    IEmberVault.Roles memory vaultRoles = IEmberVault(vault).roles();
    if (newOperator == vaultRoles.operator) revert SameValue();
    if (newOperator == vaultRoles.rateManager || newOperator == vaultRoles.admin)
      revert InvalidValue();
    if (IEmberVault(vault).subAccounts(newOperator)) revert InvalidValue();
    if (blacklistedAccounts[newOperator]) revert Blacklisted();

    IEmberVault(vault).setOperator(msg.sender, newOperator);
  }

  /// @notice Updates the address of the vault rate manager
  /// @dev Validates parameters, then forwards to vault which verifies caller is admin
  /// @param vault The vault address
  /// @param newRateManager The new rate manager address
  function updateVaultRateManager(address vault, address newRateManager) external nonReentrant {
    if (newRateManager == address(0)) revert ZeroAddress();

    IEmberVault.Roles memory vaultRoles = IEmberVault(vault).roles();
    if (newRateManager == vaultRoles.rateManager) revert SameValue();
    if (newRateManager == vaultRoles.admin || newRateManager == vaultRoles.operator)
      revert InvalidValue();
    if (IEmberVault(vault).subAccounts(newRateManager)) revert InvalidValue();
    if (blacklistedAccounts[newRateManager]) revert Blacklisted();

    IEmberVault(vault).setRateManager(msg.sender, newRateManager);
  }

  /// @notice Updates the vault fee percentage
  /// @dev Validates parameters, then forwards to vault which verifies caller is admin
  /// @param vault The vault address  
  /// @param newFeePercentage The new fee percentage
  function updateVaultFeePercentage(address vault, uint256 newFeePercentage) external nonReentrant {
    if (newFeePercentage > protocolConfig.maxFeePercentage) {
      revert InvalidFeePercentage();
    }
    if (newFeePercentage == IEmberVault(vault).platformFee().platformFeePercentage) {
      revert SameValue();
    }
    IEmberVault(vault).setFeePercentage(msg.sender, newFeePercentage);
  }

  /// @notice Updates the vault name
  /// @dev Validates parameters, then forwards to vault which verifies caller is admin
  /// @param vault The vault address
  /// @param newName The new vault name
  function updateVaultName(address vault, string calldata newName) external nonReentrant {
    if (bytes(newName).length == 0) revert InvalidValue();

    IEmberVault(vault).setVaultName(msg.sender, newName);
  }

  /// @notice Updates the minimum withdrawable shares
  /// @dev Validates parameters, then forwards to vault which verifies caller is admin
  /// @param vault The vault address
  /// @param newMinWithdrawableShares The new minimum withdrawable shares amount
  function updateVaultMinWithdrawableShares(
    address vault,
    uint256 newMinWithdrawableShares
  ) external nonReentrant {
    if (newMinWithdrawableShares == 0) revert InvalidValue();
    if (newMinWithdrawableShares == IEmberVault(vault).minWithdrawableShares()) revert SameValue();

    IEmberVault(vault).setMinWithdrawableShares(msg.sender, newMinWithdrawableShares);
  }

  /// @notice Sets or removes a sub-account for a vault
  /// @dev Validates parameters, then forwards to vault which verifies caller is admin
  /// @param vault The vault address
  /// @param account The account address to set or remove
  /// @param isSubAccount True to add as sub-account, false to remove
  function setVaultSubAccount(
    address vault,
    address account,
    bool isSubAccount
  ) external nonReentrant {
    if (account == address(0)) revert ZeroAddress();

    if (isSubAccount) {
      // Adding sub-account
      if (IEmberVault(vault).subAccounts(account)) revert SameValue();

      // Check it's not a role
      IEmberVault.Roles memory vaultRoles = IEmberVault(vault).roles();
      if (
        account == vaultRoles.admin ||
        account == vaultRoles.operator ||
        account == vaultRoles.rateManager
      ) revert InvalidValue();

      // Check it's not blacklisted
      if (blacklistedAccounts[account]) revert Blacklisted();
    } else {
      // Removing sub-account
      if (!IEmberVault(vault).subAccounts(account)) revert InvalidValue();
    }

    IEmberVault(vault).setSubAccountStatus(msg.sender, account, isSubAccount);
  }

  /// @notice Sets the pause status for a specific operation on a vault
  /// @dev Forwards to vault which verifies caller is admin
  /// @param vault The vault address
  /// @param operation The operation to pause/unpause: "deposits", "withdrawals", or "privilegedOperations"
  /// @param paused True to pause, false to unpause
  function setVaultPausedStatus(
    address vault,
    string calldata operation,
    bool paused
  ) external nonReentrant {
    IEmberVault(vault).setPausedStatus(msg.sender, operation, paused);
  }

  // ============================================
  // Getter Functions
  // ============================================

  /// @notice Returns whether the protocol is paused for non-admins
  function getProtocolPauseStatus() external view returns (bool) {
    return protocolConfig.pause;
  }

  /// @notice Returns the current platform fee recipient
  function getPlatformFeeRecipient() external view returns (address) {
    return protocolConfig.platformFeeRecipient;
  }

  function getMinRate() external view returns (uint256) {
    return protocolConfig.minRate;
  }

  function getMaxRate() external view returns (uint256) {
    return protocolConfig.maxRate;
  }

  function getDefaultRate() external view returns (uint256) {
    return protocolConfig.defaultRate;
  }

  function getMinRateInterval() external view returns (uint256) {
    return protocolConfig.minRateInterval;
  }

  function getMaxRateInterval() external view returns (uint256) {
    return protocolConfig.maxRateInterval;
  }

  function getMaxAllowedFeePercentage() external view returns (uint256) {
    return protocolConfig.maxFeePercentage;
  }

  /// @notice Checks if an account is blacklisted
  function isAccountBlacklisted(address account) external view returns (bool) {
    return blacklistedAccounts[account];
  }

  /**
   * @dev Get the contract version
   * @return Version number
   */
  function version() external pure virtual returns (string memory) {
    return "v1.1.1";
  }

  /// @notice Verifies that the protocol is not paused
  ///
  /// Aborts with:
  /// - ProtocolPaused: If the protocol is paused.
  function verifyProtocolNotPaused() external view {
    if (protocolConfig.pause) revert ProtocolPaused();
  }

  /// @notice Verifies that an account is not blacklisted
  /// @param account The account to verify
  ///
  /// Aborts with:
  /// - Blacklisted: If the account is blacklisted.
  function verifyAccountNotBlacklisted(address account) external view {
    if (blacklistedAccounts[account]) revert Blacklisted();
  }
  /**
   * @dev Function that authorizes an upgrade to a new implementation.
   *      Authorization is handled by the onlyOwner modifier.
   * @param newImplementation Address of the new implementation (unused, validated by UUPS)
   */
  function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
    // solhint-disable-next-line no-empty-blocks
    // Authorization is handled by onlyOwner modifier; no additional logic needed
  }
}
