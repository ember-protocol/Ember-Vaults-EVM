pragma solidity ^0.8.22;

error DepositNotAllowed();

/// @title Ember Vault Validator Interface
/// @notice Interface for the validator contract that manages withdrawal fees and deposit allow lists
interface IEmberVaultValidator {
  struct WithdrawalFee {
    uint256 permanentFeePercentage;
    uint256 timeBasedFeePercentage;
    uint256 timeBasedFeeThreshold;
  }

  // ============================================
  // Getter Functions
  // ============================================

  function withdrawalFee(address vault) external view returns (WithdrawalFee memory);
  function feeExemptAccounts(address vault, address account) external view returns (bool);
  function depositAllowList(address vault, address account) external view returns (bool);
  function lastDepositTimestamp(address vault, address account) external view returns (uint256);
  function depositAllowListCount(address vault) external view returns (uint256);

  // ============================================
  // Vault-Called Functions
  // ============================================

  /// @notice Validates whether a depositor is allowed to deposit
  /// @dev Called by the vault during deposit. Reverts if not allowed.
  function validateDeposit(address vault, address depositor) external view;

  /// @notice Records the last deposit timestamp for the receiver
  /// @dev Called by the vault after a successful deposit
  function recordDeposit(address vault, address receiver, uint256 timestamp) external;

  /// @notice Calculates withdrawal fees for a given owner and amount
  /// @dev Called by the vault during withdrawal processing
  /// @return permanentFeeCharged The permanent fee amount
  /// @return timeBasedFeeCharged The time-based fee amount
  function calculateWithdrawalFees(
    address vault,
    address owner,
    uint256 withdrawAmount,
    uint256 currentTime
  ) external view returns (uint256 permanentFeeCharged, uint256 timeBasedFeeCharged);

  // ============================================
  // ProtocolConfig-Called Setter Functions
  // ============================================

  function setDepositAllowListStatus(
    address caller,
    address vault,
    address user,
    bool status
  ) external;
  function setFeeExemptionListStatus(
    address caller,
    address vault,
    address user,
    bool status
  ) external;
  function setPermanentFeePercentage(address caller, address vault, uint256 newPercentage) external;
  function setTimeBasedFeePercentage(address caller, address vault, uint256 newPercentage) external;
  function setTimeBasedFeeThreshold(address caller, address vault, uint256 newThreshold) external;
}
