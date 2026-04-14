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
import "./interfaces/IEmberVaultValidator.sol";
import "./interfaces/IEmberVault.sol";
import "./interfaces/IEmberProtocolConfig.sol";
import "./libraries/Math.sol";

/// @title EmberVaultValidator
/// @notice Manages withdrawal fees, deposit allow lists, and fee exemptions for Ember vaults.
///         Deployed once and shared across all vaults. Each vault stores a reference to this contract.
contract EmberVaultValidator is
  Initializable,
  UUPSUpgradeable,
  OwnableUpgradeable,
  ReentrancyGuardUpgradeable,
  IEmberVaultValidator
{
  // State: vault => config
  mapping(address => WithdrawalFee) private _withdrawalFees;
  mapping(address => mapping(address => bool)) private _feeExemptAccounts;
  mapping(address => mapping(address => bool)) private _depositAllowList;
  mapping(address => mapping(address => uint256)) private _lastDepositTimestamp;
  mapping(address => uint256) private _depositAllowListCount;

  /// @notice Protocol config contract for authorization
  IEmberProtocolConfig public protocolConfig;

  // Events
  event VaultDepositAllowListUpdated(
    address indexed vault,
    address indexed account,
    bool status,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultFeeExemptListUpdated(
    address indexed vault,
    address indexed account,
    bool status,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultPermanentFeePercentageUpdated(
    address indexed vault,
    uint256 previousPercentage,
    uint256 newPercentage,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultTimeBasedFeePercentageUpdated(
    address indexed vault,
    uint256 previousPercentage,
    uint256 newPercentage,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultTimeBasedFeeThresholdUpdated(
    address indexed vault,
    uint256 previousThreshold,
    uint256 newThreshold,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  modifier onlyProtocolConfig() {
    if (msg.sender != address(protocolConfig)) revert Unauthorized();
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(address _protocolConfig, address initialOwner) public initializer {
    __Ownable_init(initialOwner);
    __UUPSUpgradeable_init();
    __ReentrancyGuard_init();
    protocolConfig = IEmberProtocolConfig(_protocolConfig);
  }

  // ============================================
  // Getter Functions
  // ============================================

  function withdrawalFee(address vault) external view returns (WithdrawalFee memory) {
    return _withdrawalFees[vault];
  }

  function feeExemptAccounts(address vault, address account) external view returns (bool) {
    return _feeExemptAccounts[vault][account];
  }

  function depositAllowList(address vault, address account) external view returns (bool) {
    return _depositAllowList[vault][account];
  }

  function lastDepositTimestamp(address vault, address account) external view returns (uint256) {
    return _lastDepositTimestamp[vault][account];
  }

  function depositAllowListCount(address vault) external view returns (uint256) {
    return _depositAllowListCount[vault];
  }

  // ============================================
  // Vault-Called Functions
  // ============================================

  /// @notice Validates whether a depositor is allowed to deposit
  /// @dev Called by the vault during deposit. Reverts if not allowed.
  function validateDeposit(address vault, address depositor) external view {
    if (_depositAllowListCount[vault] > 0 && !_depositAllowList[vault][depositor])
      revert DepositNotAllowed();
  }

  /// @notice Records the last deposit timestamp for the receiver
  /// @dev Called by the vault after a successful deposit
  function recordDeposit(address vault, address receiver, uint256 timestamp) external {
    _lastDepositTimestamp[vault][receiver] = timestamp;
  }

  /// @notice Calculates withdrawal fees for a given owner and amount
  function calculateWithdrawalFees(
    address vault,
    address owner_,
    uint256 withdrawAmount,
    uint256 currentTime
  ) external view returns (uint256 permanentFeeCharged, uint256 timeBasedFeeCharged) {
    if (_feeExemptAccounts[vault][owner_]) return (0, 0);

    WithdrawalFee storage fee = _withdrawalFees[vault];

    uint256 permFeePercent = fee.permanentFeePercentage;
    if (permFeePercent > 0) {
      permanentFeeCharged = FixedPointMath.mul(withdrawAmount, permFeePercent);
    }

    uint256 tbFeePercent = fee.timeBasedFeePercentage;
    if (tbFeePercent > 0) {
      uint256 lastDeposit = _lastDepositTimestamp[vault][owner_];
      if (lastDeposit > 0 && lastDeposit + fee.timeBasedFeeThreshold > currentTime) {
        timeBasedFeeCharged = FixedPointMath.mul(withdrawAmount, tbFeePercent);
      }
    }
  }

  // ============================================
  // ProtocolConfig-Called Setter Functions
  // ============================================

  function setDepositAllowListStatus(
    address caller,
    address vault,
    address user,
    bool status
  ) external nonReentrant onlyProtocolConfig {
    if (caller != IEmberVault(vault).roles().operator) revert Unauthorized();
    _depositAllowList[vault][user] = status;
    if (status) {
      unchecked {
        _depositAllowListCount[vault]++;
      }
    } else {
      unchecked {
        _depositAllowListCount[vault]--;
      }
    }
    emit VaultDepositAllowListUpdated(
      vault,
      user,
      status,
      block.timestamp * 1000,
      IEmberVault(vault).sequenceNumber()
    );
  }

  function setFeeExemptionListStatus(
    address caller,
    address vault,
    address user,
    bool status
  ) external nonReentrant onlyProtocolConfig {
    if (caller != IEmberVault(vault).roles().operator) revert Unauthorized();
    _feeExemptAccounts[vault][user] = status;
    emit VaultFeeExemptListUpdated(
      vault,
      user,
      status,
      block.timestamp * 1000,
      IEmberVault(vault).sequenceNumber()
    );
  }

  function setPermanentFeePercentage(
    address caller,
    address vault,
    uint256 newPercentage
  ) external nonReentrant onlyProtocolConfig {
    if (caller != IEmberVault(vault).roles().admin) revert Unauthorized();
    uint256 previous = _withdrawalFees[vault].permanentFeePercentage;
    _withdrawalFees[vault].permanentFeePercentage = newPercentage;
    emit VaultPermanentFeePercentageUpdated(
      vault,
      previous,
      newPercentage,
      block.timestamp * 1000,
      IEmberVault(vault).sequenceNumber()
    );
  }

  function setTimeBasedFeePercentage(
    address caller,
    address vault,
    uint256 newPercentage
  ) external nonReentrant onlyProtocolConfig {
    if (caller != IEmberVault(vault).roles().admin) revert Unauthorized();
    uint256 previous = _withdrawalFees[vault].timeBasedFeePercentage;
    _withdrawalFees[vault].timeBasedFeePercentage = newPercentage;
    emit VaultTimeBasedFeePercentageUpdated(
      vault,
      previous,
      newPercentage,
      block.timestamp * 1000,
      IEmberVault(vault).sequenceNumber()
    );
  }

  function setTimeBasedFeeThreshold(
    address caller,
    address vault,
    uint256 newThreshold
  ) external nonReentrant onlyProtocolConfig {
    if (caller != IEmberVault(vault).roles().admin) revert Unauthorized();
    uint256 previous = _withdrawalFees[vault].timeBasedFeeThreshold;
    _withdrawalFees[vault].timeBasedFeeThreshold = newThreshold;
    emit VaultTimeBasedFeeThresholdUpdated(
      vault,
      previous,
      newThreshold,
      block.timestamp * 1000,
      IEmberVault(vault).sequenceNumber()
    );
  }

  function version() external pure returns (string memory) {
    return "v1.0.0";
  }

  function _authorizeUpgrade(address) internal override onlyOwner {}

  uint256[43] private __gap;
}
