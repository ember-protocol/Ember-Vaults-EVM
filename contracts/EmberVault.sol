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
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IEmberProtocolConfig.sol";
import "./interfaces/IEmberVaultValidator.sol";
import "./libraries/Math.sol"; // FixedPointMath library

// Custom errors for gas optimization (errors not in IEmberProtocolConfig)
error OperationPaused();
error InsufficientBalance();
error InsufficientShares();
error TransferFailed();
error InvalidRequest();
error MaxTVLReached();
error ZeroAmount();
error IndexOutOfBounds();
error UseRedeemShares();

/**
 * @title EmberVault
 * @dev Upgradeable ERC-4626 compliant vault contract using UUPS proxy pattern
 * @notice This is the main vault contract. Implements ERC-4626 with request-based withdrawals.
 *         Standard withdraw/redeem are disabled - users must use requestRedeem and wait for processing.
 *
 * @dev Note: This contract does not explicitly implement IEmberVault interface to avoid
 *      struct/function conflicts. IEmberVault is used by EmberProtocolConfig for cross-contract calls.
 */
contract EmberVault is
  Initializable,
  ERC4626Upgradeable,
  UUPSUpgradeable,
  OwnableUpgradeable,
  ReentrancyGuardUpgradeable
{
  using SafeERC20 for IERC20;

  // Structs
  /// @notice platform fee struct
  struct PlatformFee {
    // the amount of platform fee accrued on the vault
    uint256 accrued;
    // timestamp (ms) at which the platform fee was last charged
    uint256 lastChargedAt;
    // the platform fee percentage
    uint256 platformFeePercentage;
  }

  /// @notice rate struct
  struct Rate {
    // the rate of the vault (1e18)
    uint256 value;
    // the max allowed change in rate per update
    uint256 maxRateChangePerUpdate;
    // the time interval that must elapse before rate can be updated (ms)
    uint256 rateUpdateInterval;
    // the last time the rate was updated (ms)
    uint256 lastUpdatedAt;
  }

  /// @notice roles struct
  struct Roles {
    // the address of the vault admin
    address admin;
    // the address of the vault operator
    address operator;
    // the address of the vault rate manager
    address rateManager;
  }

  /// @notice Pause status for different operations
  struct PauseStatus {
    bool deposits;
    bool withdrawals;
    // privileged operations are all methods controlled by vault rate manager and operator.
    //Admin operations are not paused
    bool privilegedOperations;
  }

  /// @notice Represents a withdrawal request
  struct WithdrawalRequest {
    // the address of the owner that requested the withdrawal
    address owner;
    // the address of the receiver that will get the withdrawal amount
    address receiver;
    // the number of shares to redeem
    uint256 shares;
    // the estimated amount of assets user will receive after withdrawal
    uint256 estimatedWithdrawAmount;
    // the time at which withdrawal request was made
    uint256 timestamp;
    // this is the sequence number of the vault at the time of requesting withdrawal
    uint256 sequenceNumber;
  }

  /// @notice Represents an account in the vault with pending withdrawals
  struct Account {
    // the amount of shares that the account has pending for withdrawal
    uint256 totalPendingWithdrawalShares;
    // The sequence numbers of the withdrawal requests that the account has made and are pending processing
    uint256[] pendingWithdrawalRequestSequenceNumbers;
    // The sequence numbers of the withdrawal requests that the account has cancelled
    uint256[] cancelWithdrawRequestSequenceNumbers;
  }
  /**
   * @dev Initialize function replaces constructor for upgradeable contracts
   * @param initialOwner Address of the contract owner
   */
  struct VaultInitParams {
    string name;
    string receiptTokenSymbol;
    address collateralToken;
    address admin;
    address operator;
    address rateManager;
    uint256 maxRateChangePerUpdate;
    uint256 feePercentage;
    uint256 minWithdrawableShares;
    uint256 rateUpdateInterval;
    uint256 maxTVL;
  }

  // Constants
  /// @notice Fee denominator for platform fee calculation (1e18 * 365 * 24 * 60 * 60 * 1000)
  uint256 private constant FEE_DENOMINATOR = 31_536_000_000_000_000_000_000_000_000;

  /// @notice Hash constants for pause operation comparison (computed at compile time)
  bytes32 private constant DEPOSITS_HASH = keccak256("deposits");
  bytes32 private constant WITHDRAWALS_HASH = keccak256("withdrawals");
  bytes32 private constant PRIVILEGED_OPS_HASH = keccak256("privilegedOperations");

  /// @notice name of the vault (shadows ERC20 name for custom naming)
  string private _vaultName;

  /// @notice maximum total value locked
  uint256 public maxTVL;

  /// @notice min withdrawable shares amount
  uint256 public minWithdrawableShares;

  /// @notice list of all whitelisted sub-accounts
  mapping(address => bool) public subAccounts;

  PlatformFee public platformFee;

  Rate public rate;

  Roles public roles;

  /// @notice Protocol config contract
  IEmberProtocolConfig public protocolConfig;

  /// @notice Current pause status of the vault
  PauseStatus public pauseStatus;

  /// @notice Sequence number that increments with each vault action
  uint256 public sequenceNumber;

  /// @notice queue of pending withdrawal requests
  WithdrawalRequest[] public pendingWithdrawals;

  /// @notice start index for the withdrawal queue (for efficient dequeuing)
  uint256 private withdrawalQueueStartIndex;

  /// @notice mapping of user addresses to their account state
  mapping(address => Account) public accounts;

  /// @notice Validator contract for withdrawal fees and deposit allow lists
  IEmberVaultValidator public vaultValidator;

  /**
   * @dev Reserved storage gap for future upgrades.
   * This allows adding new state variables without shifting storage slots.
   * See: https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable#storage-gaps
   */
  uint256[49] private __gap;

  // Events
  /// @notice Emitted when a vault is created
  event VaultCreated(
    address indexed vault,
    string name,
    string symbol,
    address collateralToken,
    address admin,
    address operator,
    address rateProvider,
    address[] subAccounts,
    uint256 minWithdrawableShares,
    uint256 feePercentage,
    uint256 maxRateChangePerUpdate,
    uint256 rateUpdateInterval,
    uint256 rate,
    uint256 maxTVL,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when the vault rate manager is updated
  event VaultRateManagerUpdated(
    address indexed vault,
    address indexed previousRateManager,
    address indexed newRateManager,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when the vault max TVL is updated
  event VaultMaxTVLUpdated(
    address indexed vault,
    uint256 previousMaxTVL,
    uint256 newMaxTVL,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when the vault rate update interval is changed
  event VaultRateUpdateIntervalChanged(
    address indexed vault,
    uint256 previousInterval,
    uint256 newInterval,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when vault max rate change per update is changed
  event VaultMaxRateChangePerUpdateChanged(
    address indexed vault,
    uint256 previousMaxRateChangePerUpdate,
    uint256 newMaxRateChangePerUpdate,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when the vault admin is changed
  event VaultAdminChanged(
    address indexed vault,
    address indexed previousAdmin,
    address indexed newAdmin,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when the vault operator is changed
  event VaultOperatorChanged(
    address indexed vault,
    address indexed previousOperator,
    address indexed newOperator,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when the vault fee percentage is updated
  event VaultFeePercentageUpdated(
    address indexed vault,
    uint256 previousFeePercentage,
    uint256 newFeePercentage,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when the vault name is updated
  event VaultNameUpdated(
    address indexed vault,
    string previousName,
    string newName,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultMinWithdrawableSharesUpdated(
    address indexed vault,
    uint256 previousMinWithdrawableShares,
    uint256 newMinWithdrawableShares,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when a sub-account is added or removed
  event VaultSubAccountUpdated(
    address indexed vault,
    address indexed account,
    bool isSubAccount,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when vault pause status is updated
  event VaultPauseStatusUpdated(
    address indexed vault,
    string operation,
    bool paused,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when the vault rate is updated
  event VaultRateUpdated(
    address indexed vault,
    uint256 previousRate,
    uint256 newRate,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when platform fees are charged
  event VaultPlatformFeeCharged(
    address indexed vault,
    uint256 feeAmount,
    uint256 totalAccrued,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when platform fees are collected
  event VaultPlatformFeeCollected(
    address indexed vault,
    address indexed recipient,
    uint256 amount,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when a user deposits assets into the vault
  event VaultDeposit(
    address indexed vault,
    address indexed depositor,
    address indexed receiver,
    uint256 amountDeposited,
    uint256 sharesMinted,
    uint256 totalShares,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when a user redeems shares (creates a withdrawal request)
  event RequestRedeemed(
    address indexed vault,
    address indexed owner,
    address indexed receiver,
    uint256 shares,
    uint256 timestamp,
    uint256 totalShares,
    uint256 totalSharesPendingToBurn,
    uint256 sequenceNumber
  );

  /// @notice Emitted when a user cancels a pending withdrawal request
  event RequestCancelled(
    address indexed vault,
    address indexed owner,
    uint256 requestSequenceNumber,
    uint256[] cancelWithdrawRequestSequenceNumbers,
    uint256 timestamp
  );

  /// @notice Emitted when vault operator withdraws from vault without redeeming shares
  event VaultWithdrawalWithoutRedeemingShares(
    address indexed vault,
    address indexed subAccount,
    uint256 previousBalance,
    uint256 newBalance,
    uint256 amount,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  /// @notice Emitted when a withdrawal request is processed
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

  /// @notice Emitted alongside RequestProcessed when withdrawal fees are charged
  event WithdrawalFeeCharged(
    address indexed vault,
    address indexed owner,
    uint256 requestSequenceNumber,
    uint256 permanentFeeCharged,
    uint256 timeBasedFeeCharged
  );

  /// @notice Emitted when withdrawal requests are processed (summary event)
  event ProcessRequestsSummary(
    address indexed vault,
    uint256 totalRequestProcessed,
    uint256 requestsSkipped,
    uint256 requestsCancelled,
    uint256 totalSharesBurnt,
    uint256 totalAmountWithdrawn,
    uint256 totalShares,
    uint256 totalSharesPendingToBurn,
    uint256 rate,
    uint256 sequenceNumber
  );

  // Modifiers
  /// @notice Only the vault operator can call this function
  modifier onlyOperator() {
    if (msg.sender != roles.operator) revert Unauthorized();
    _;
  }

  /// @notice Only the vault rate manager can call this function
  modifier onlyRateManager() {
    if (msg.sender != roles.rateManager) revert Unauthorized();
    _;
  }

  /// @notice Only the protocol config can call this function
  modifier onlyProtocolConfig() {
    if (msg.sender != address(protocolConfig)) revert Unauthorized();
    _;
  }

  /// @notice Verifies caller is admin (used with onlyProtocolConfig for setter functions)
  /// @param caller The original caller address passed from protocol config
  modifier onlyAdmin(address caller) {
    if (caller != roles.admin) revert Unauthorized();
    _;
  }

  /// @notice Verifies caller is owner (used with onlyProtocolConfig for setter functions)
  /// @param caller The original caller address passed from protocol config
  modifier onlyOwnerRole(address caller) {
    if (caller != owner()) revert Unauthorized();
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(
    address _protocolConfig,
    address initialOwner,
    VaultInitParams memory params,
    address[] memory _subAccounts
  ) public initializer {
    if (_protocolConfig == address(0)) revert ZeroAddress();
    if (params.admin == address(0)) revert ZeroAddress();
    if (params.operator == address(0)) revert ZeroAddress();
    if (params.rateManager == address(0)) revert ZeroAddress();
    if (
      params.admin == params.operator ||
      params.admin == params.rateManager ||
      params.operator == params.rateManager
    ) revert InvalidValue();

    if (params.collateralToken == address(0)) revert ZeroAddress();

    IEmberProtocolConfig configProxy = IEmberProtocolConfig(_protocolConfig);

    if (
      params.rateUpdateInterval < configProxy.getMinRateInterval() ||
      params.rateUpdateInterval > configProxy.getMaxRateInterval() ||
      params.rateUpdateInterval == configProxy.getMinRateInterval()
    ) revert InvalidInterval();

    if (params.feePercentage >= configProxy.getMaxAllowedFeePercentage()) revert InvalidValue();

    // Initialize ERC4626 with the collateral token as the underlying asset
    __ERC20_init(params.name, params.receiptTokenSymbol);
    __ERC4626_init(IERC20(params.collateralToken));
    __Ownable_init(initialOwner);
    __UUPSUpgradeable_init();
    __ReentrancyGuard_init();

    protocolConfig = IEmberProtocolConfig(_protocolConfig);

    if (bytes(params.name).length == 0) revert InvalidValue();
    if (params.minWithdrawableShares == 0) revert ZeroAmount();
    if (params.maxTVL == 0) revert ZeroAmount();

    _vaultName = params.name;
    maxTVL = params.maxTVL;
    minWithdrawableShares = params.minWithdrawableShares;

    uint256 currentTime = _getChainTimestampMs();

    platformFee = PlatformFee({
      accrued: 0,
      lastChargedAt: currentTime,
      platformFeePercentage: params.feePercentage
    });

    rate = Rate({
      value: configProxy.getDefaultRate(),
      maxRateChangePerUpdate: params.maxRateChangePerUpdate,
      rateUpdateInterval: params.rateUpdateInterval,
      lastUpdatedAt: currentTime
    });

    if (configProxy.isAccountBlacklisted(params.admin)) revert Blacklisted();
    if (configProxy.isAccountBlacklisted(params.operator)) revert Blacklisted();
    if (configProxy.isAccountBlacklisted(params.rateManager)) revert Blacklisted();

    roles = Roles({
      admin: params.admin,
      operator: params.operator,
      rateManager: params.rateManager
    });

    for (uint256 i = 0; i < _subAccounts.length; i++) {
      address subAccount = _subAccounts[i];
      if (subAccount == address(0)) revert ZeroAddress();
      if (
        subAccount == params.admin ||
        subAccount == params.operator ||
        subAccount == params.rateManager
      ) revert InvalidValue();
      subAccounts[subAccount] = true;
    }

    // Initialize sequence number
    sequenceNumber = 0;

    emit VaultCreated(
      address(this),
      params.name,
      params.receiptTokenSymbol,
      params.collateralToken,
      roles.admin,
      roles.operator,
      roles.rateManager,
      _subAccounts,
      minWithdrawableShares,
      platformFee.platformFeePercentage,
      rate.maxRateChangePerUpdate,
      rate.rateUpdateInterval,
      rate.value,
      maxTVL,
      currentTime,
      sequenceNumber
    );
  }

  // ============================================
  // Protocol Config Setter Functions
  // ============================================

  /// @notice Sets the max TVL of the vault
  /// @dev Only callable by protocol config, caller must be admin
  /// @param caller The original caller address (must be admin)
  /// @param newMaxTVL The new maximum total value locked
  function setMaxTVL(
    address caller,
    uint256 newMaxTVL
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    uint256 previousMaxTVL = maxTVL;
    maxTVL = newMaxTVL;
    _incrementSequence();

    emit VaultMaxTVLUpdated(
      address(this),
      previousMaxTVL,
      newMaxTVL,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Sets the vault rate update interval
  /// @dev Only callable by protocol config, caller must be admin
  /// @param caller The original caller address (must be admin)
  /// @param newInterval The new rate update interval (in milliseconds)
  function setRateUpdateInterval(
    address caller,
    uint256 newInterval
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    uint256 previousInterval = rate.rateUpdateInterval;
    rate.rateUpdateInterval = newInterval;
    _incrementSequence();

    emit VaultRateUpdateIntervalChanged(
      address(this),
      previousInterval,
      newInterval,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Sets the vault max rate change per update
  /// @dev Only callable by protocol config, caller must be admin
  /// @param caller The original caller address (must be admin)
  /// @param newMaxRateChangePerUpdate The new max rate change allowed per update
  function setMaxRateChangePerUpdate(
    address caller,
    uint256 newMaxRateChangePerUpdate
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    uint256 previousMaxRateChangePerUpdate = rate.maxRateChangePerUpdate;
    rate.maxRateChangePerUpdate = newMaxRateChangePerUpdate;
    _incrementSequence();

    emit VaultMaxRateChangePerUpdateChanged(
      address(this),
      previousMaxRateChangePerUpdate,
      newMaxRateChangePerUpdate,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Sets the vault admin
  /// @dev Only callable by protocol config, caller must be owner
  /// @param caller The original caller address (must be owner)
  /// @param newAdmin The new admin address
  function setAdmin(
    address caller,
    address newAdmin
  ) external nonReentrant onlyProtocolConfig onlyOwnerRole(caller) {
    address previousAdmin = roles.admin;
    roles.admin = newAdmin;
    _incrementSequence();

    emit VaultAdminChanged(
      address(this),
      previousAdmin,
      newAdmin,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Sets the vault operator
  /// @dev Only callable by protocol config, caller must be admin
  /// @param caller The original caller address (must be admin)
  /// @param newOperator The new operator address
  function setOperator(
    address caller,
    address newOperator
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    address previousOperator = roles.operator;
    roles.operator = newOperator;
    _incrementSequence();

    emit VaultOperatorChanged(
      address(this),
      previousOperator,
      newOperator,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Sets the vault rate manager
  /// @dev Only callable by protocol config, caller must be admin
  /// @param caller The original caller address (must be admin)
  /// @param newRateManager The new rate manager address
  function setRateManager(
    address caller,
    address newRateManager
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    address previousRateManager = roles.rateManager;
    roles.rateManager = newRateManager;
    _incrementSequence();

    emit VaultRateManagerUpdated(
      address(this),
      previousRateManager,
      newRateManager,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Sets the vault fee percentage
  /// @dev Only callable by protocol config, caller must be admin
  /// @param caller The original caller address (must be admin)
  /// @param newFeePercentage The new fee percentage
  function setFeePercentage(
    address caller,
    uint256 newFeePercentage
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    uint256 previousFeePercentage = platformFee.platformFeePercentage;
    platformFee.platformFeePercentage = newFeePercentage;
    _incrementSequence();

    emit VaultFeePercentageUpdated(
      address(this),
      previousFeePercentage,
      newFeePercentage,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Updates the vault name
  /// @dev Only callable by protocol config, caller must be admin
  /// @param caller The original caller address (must be admin)
  /// @param newName The new vault name
  function setVaultName(
    address caller,
    string calldata newName
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    string memory previousName = _vaultName;
    _vaultName = newName;
    _incrementSequence();

    emit VaultNameUpdated(
      address(this),
      previousName,
      newName,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Updates the minimum withdrawable shares
  /// @dev Only callable by protocol config, caller must be admin
  /// @param caller The original caller address (must be admin)
  /// @param newMinWithdrawableShares The new minimum withdrawable shares amount
  function setMinWithdrawableShares(
    address caller,
    uint256 newMinWithdrawableShares
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    uint256 previousMinWithdrawableShares = minWithdrawableShares;
    minWithdrawableShares = newMinWithdrawableShares;
    _incrementSequence();

    emit VaultMinWithdrawableSharesUpdated(
      address(this),
      previousMinWithdrawableShares,
      newMinWithdrawableShares,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Sets or removes a sub-account
  /// @dev Only callable by protocol config, caller must be admin
  /// @param caller The original caller address (must be admin)
  /// @param account The account address to set or remove
  /// @param isSubAccount True to add as sub-account, false to remove
  function setSubAccountStatus(
    address caller,
    address account,
    bool isSubAccount
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    subAccounts[account] = isSubAccount;

    _incrementSequence();
    emit VaultSubAccountUpdated(
      address(this),
      account,
      isSubAccount,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Updates the vault rate
  /// @dev Only the rate manager can update the rate
  /// @param newRate The new rate value (in fixed-point format, 1e18)
  function updateVaultRate(uint256 newRate) external nonReentrant onlyRateManager {
    IEmberProtocolConfig configProxy = protocolConfig;

    // Check protocol is not paused
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();

    // Check vault privileged operations are not paused
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    // Charge accrued platform fees
    _chargeAccruedPlatformFees();

    uint256 currentTime = _getChainTimestampMs();
    uint256 lastUpdatedAt = rate.lastUpdatedAt;

    // Check enough time has passed since last update
    if (currentTime < lastUpdatedAt + rate.rateUpdateInterval) revert InvalidInterval();

    // Validate rate is within bounds
    if (newRate < configProxy.getMinRate() || newRate > configProxy.getMaxRate())
      revert InvalidRate();

    // Calculate percentage change
    uint256 percentChange = FixedPointMath.percentChangeFrom(rate.value, newRate);

    // Validate rate change is within allowed limit
    if (percentChange > rate.maxRateChangePerUpdate) revert InvalidRate();

    // Check rate is different from current
    if (newRate == rate.value) revert SameValue();

    uint256 previousRate = rate.value;

    // Update rate and timestamp
    rate.value = newRate;
    rate.lastUpdatedAt = currentTime;

    _incrementSequence();
    emit VaultRateUpdated(address(this), previousRate, newRate, currentTime, sequenceNumber);
  }

  /// @notice Collects accrued platform fees and transfers them to the fee recipient
  /// @dev Only the vault operator can call this function
  /// @dev Reverts if protocol is paused, vault privileged operations are paused, no fees accrued, or insufficient balance
  /// @return amount The amount of fees collected and transferred
  function collectPlatformFee() external nonReentrant onlyOperator returns (uint256 amount) {
    IEmberProtocolConfig configProxy = protocolConfig;

    // Check protocol is not paused
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();

    // Check vault privileged operations are not paused
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    // Check that there are accrued fees
    if (platformFee.accrued == 0) revert ZeroAmount();

    amount = platformFee.accrued;

    // Check that vault has sufficient balance
    uint256 vaultBalance = IERC20(asset()).balanceOf(address(this));
    if (vaultBalance < amount) revert InsufficientBalance();

    // Get fee recipient from protocol config
    address recipient = configProxy.getPlatformFeeRecipient();
    if (recipient == address(0)) revert ZeroAddress();

    // Reset accrued fees
    platformFee.accrued = 0;

    // Transfer fees to recipient using SafeERC20
    IERC20(asset()).safeTransfer(recipient, amount);

    // Increment sequence number
    _incrementSequence();

    uint256 currentTime = _getChainTimestampMs();

    emit VaultPlatformFeeCollected(address(this), recipient, amount, currentTime, sequenceNumber);

    return amount;
  }

  /// @notice Sets the pause status for a specific operation
  /// @dev Only callable by protocol config, caller must be admin
  /// @param caller The original caller address (must be admin)
  /// @param operation The operation to pause/unpause: "deposits", "withdrawals", or "privilegedOperations"
  /// @param paused True to pause, false to unpause
  function setPausedStatus(
    address caller,
    string calldata operation,
    bool paused
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    // Compute hash once at runtime; constants are computed at compile time
    bytes32 operationHash = keccak256(bytes(operation));

    bool currentStatus;
    bool statusChanged = false;

    if (operationHash == DEPOSITS_HASH) {
      currentStatus = pauseStatus.deposits;
      if (currentStatus != paused) {
        pauseStatus.deposits = paused;
        statusChanged = true;
      }
    } else if (operationHash == WITHDRAWALS_HASH) {
      currentStatus = pauseStatus.withdrawals;
      if (currentStatus != paused) {
        pauseStatus.withdrawals = paused;
        statusChanged = true;
      }
    } else if (operationHash == PRIVILEGED_OPS_HASH) {
      currentStatus = pauseStatus.privilegedOperations;
      if (currentStatus != paused) {
        pauseStatus.privilegedOperations = paused;
        statusChanged = true;
      }
    } else {
      revert InvalidValue();
    }

    if (!statusChanged) revert SameValue();

    _incrementSequence();
    emit VaultPauseStatusUpdated(
      address(this),
      operation,
      paused,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Sets the vault validator contract address
  /// @dev Only callable by protocol config, caller must be admin
  function setVaultValidator(
    address caller,
    address _validator
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    vaultValidator = IEmberVaultValidator(_validator);
  }

  /// @notice Allows a user to redeem shares of a vault and receive underlying assets.
  /// The shares are locked into vault upon request and only when the vault operator processes
  /// the withdrawal request, the shares are burnt and the underlying asset based
  /// on the vault rate at the time of processing claim request is sent to the user.
  /// @param shares The number of shares to redeem
  /// @param receiver The address to send the underlying assets to
  /// @return request The withdrawal request that was created
  function redeemShares(
    uint256 shares,
    address receiver
  ) external nonReentrant returns (WithdrawalRequest memory request) {
    IEmberProtocolConfig configProxy = protocolConfig;

    // Check protocol is not paused
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();

    // Check vault withdrawals are not paused
    if (pauseStatus.withdrawals) revert OperationPaused();

    address shareOwner = msg.sender;

    // Verify user is not blacklisted
    if (configProxy.isAccountBlacklisted(shareOwner)) revert Blacklisted();
    if (configProxy.isAccountBlacklisted(receiver)) revert Blacklisted();

    if (shares < minWithdrawableShares) revert InsufficientShares();

    // Check allowance and transfer shares from user to vault (they will be burned when processing the withdrawal)
    // We use _spendAllowance and _transfer directly because transferFrom uses msg.sender as spender
    _spendAllowance(shareOwner, address(this), shares);
    _transfer(shareOwner, address(this), shares);

    // Calculate the estimated withdraw amount based on the current vault rate
    // using rate-based conversion with floor rounding (favors vault, matches actual processing)
    uint256 estimatedWithdrawAmount = convertToAssets(shares);

    // Increment the sequence number
    _incrementSequence();

    uint256 currentTime = _getChainTimestampMs();

    // Create withdrawal request
    request = WithdrawalRequest({
      owner: shareOwner,
      receiver: receiver,
      shares: shares,
      estimatedWithdrawAmount: estimatedWithdrawAmount,
      timestamp: currentTime,
      sequenceNumber: sequenceNumber
    });

    // Add request to queue
    pendingWithdrawals.push(request);

    // Update the shares to be redeemed for the account
    _updateAccountState(request, true, type(uint256).max); // type(uint256).max means no index (none in Move)

    uint256 totalShares = totalSupply();
    uint256 pendingSharesToBurn = balanceOf(address(this));

    emit RequestRedeemed(
      address(this),
      request.owner,
      request.receiver,
      request.shares,
      request.timestamp,
      totalShares,
      pendingSharesToBurn,
      sequenceNumber
    );

    return request;
  }

  /// @notice Allows an owner to cancel a pending withdrawal request
  /// @dev Reverts if protocol is paused, vault withdrawals are paused, user has no account, request not found, or already cancelled
  /// @param requestSequenceNumber The sequence number of the withdrawal request to cancel
  function cancelPendingWithdrawalRequest(uint256 requestSequenceNumber) external nonReentrant {
    IEmberProtocolConfig configProxy = protocolConfig;

    // Check protocol is not paused
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();

    // Check vault withdrawals are not paused
    if (pauseStatus.withdrawals) revert OperationPaused();

    address requestOwner = msg.sender;
    Account storage accountState = accounts[requestOwner];

    // Check user has an account (has pending withdrawals)
    if (accountState.totalPendingWithdrawalShares == 0) revert InvalidRequest();

    // Check if sequence number is already in cancel list
    uint256[] storage cancelList = accountState.cancelWithdrawRequestSequenceNumbers;
    for (uint256 i = 0; i < cancelList.length; i++) {
      if (cancelList[i] == requestSequenceNumber) {
        revert InvalidRequest();
      }
    }

    // Find the withdrawal request with the given sequence number
    uint256[] storage pendingList = accountState.pendingWithdrawalRequestSequenceNumbers;
    bool found = false;
    for (uint256 i = 0; i < pendingList.length; i++) {
      if (pendingList[i] == requestSequenceNumber) {
        found = true;
        break;
      }
    }
    if (!found) revert InvalidRequest();

    // Add sequence number to cancel list
    cancelList.push(requestSequenceNumber);

    // Emit event
    emit RequestCancelled(
      address(this),
      requestOwner,
      requestSequenceNumber,
      cancelList,
      _getChainTimestampMs()
    );
  }

  /// @notice Withdraws from the vault without redeeming shares
  /// @dev Only the vault operator can withdraw from the vault
  /// @dev Used to withdraw funds from the vault to one of the whitelisted sub accounts
  /// @param subAccount The sub account address to withdraw to (must be whitelisted)
  /// @param amount The amount of collateral tokens to withdraw
  function withdrawFromVaultWithoutRedeemingShares(
    address subAccount,
    uint256 amount
  ) external nonReentrant onlyOperator {
    IEmberProtocolConfig configProxy = protocolConfig;

    // Check protocol is not paused
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();

    // Check that privileged operations are not paused
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    // Check sub account is whitelisted
    if (!subAccounts[subAccount]) revert InvalidValue();

    // Check amount is valid
    if (amount == 0) revert ZeroAmount();

    // Check vault has sufficient balance
    uint256 vaultBalance = IERC20(asset()).balanceOf(address(this));
    if (amount > vaultBalance) revert InsufficientBalance();

    uint256 previousBalance = vaultBalance;

    // Transfer collateral tokens to sub account using SafeERC20
    IERC20(asset()).safeTransfer(subAccount, amount);

    uint256 newBalance = IERC20(asset()).balanceOf(address(this));

    // Increment sequence number
    _incrementSequence();

    uint256 currentTime = _getChainTimestampMs();
    uint256 currentSequenceNumber = sequenceNumber;

    emit VaultWithdrawalWithoutRedeemingShares(
      address(this),
      subAccount,
      previousBalance,
      newBalance,
      amount,
      currentTime,
      currentSequenceNumber
    );
  }

  /// @notice Processes withdrawal requests from the queue
  /// @dev Only the vault operator can call this function
  /// @param numRequests The number of requests to process
  function processWithdrawalRequests(uint256 numRequests) external nonReentrant onlyOperator {
    IEmberProtocolConfig configProxy = protocolConfig;

    // Check protocol is not paused
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();

    // Check privileged operations are not paused
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    if (numRequests == 0) revert ZeroAmount();

    // Increment sequence number
    _incrementSequence();

    // Cache storage variables
    uint256 startIndex = withdrawalQueueStartIndex;
    uint256 queueLength = pendingWithdrawals.length;

    // Limit numRequests to available requests
    {
      uint256 availableRequests = queueLength > startIndex ? queueLength - startIndex : 0;
      if (numRequests > availableRequests) {
        numRequests = availableRequests;
      }
    }

    uint256 currentTime = _getChainTimestampMs();
    uint256[5] memory counters; // [totalSharesBurnt, totalRequestProcessed, totalAmountWithdrawn, requestsSkipped, requestsCancelled]

    // Process requests
    for (uint256 i = 0; i < numRequests; ) {
      WithdrawalRequest memory request = pendingWithdrawals[startIndex];

      // Delete the processed entry to free storage and get gas refund
      delete pendingWithdrawals[startIndex];

      unchecked {
        startIndex++;
        i++;
      }

      (bool skipped, bool cancelled, uint256 withdrawAmount, uint256 sharesBurnt) = _processRequest(
        request,
        currentTime
      );

      unchecked {
        counters[1]++; // totalRequestProcessed
        counters[0] += sharesBurnt; // totalSharesBurnt
        counters[2] += withdrawAmount; // totalAmountWithdrawn
        if (skipped) counters[3]++; // requestsSkipped
        if (cancelled) counters[4]++; // requestsCancelled
      }
    }

    // Reset queue if empty (prevents unbounded growth)
    if (startIndex >= queueLength) {
      // Queue is empty - reset everything
      delete pendingWithdrawals;
      withdrawalQueueStartIndex = 0;
    } else {
      // Queue still has items - just update start index
      withdrawalQueueStartIndex = startIndex;
    }

    // Charge accrued platform fees
    _chargeAccruedPlatformFees();

    emit ProcessRequestsSummary(
      address(this),
      counters[1], // totalRequestProcessed
      counters[3], // requestsSkipped
      counters[4], // requestsCancelled
      counters[0], // totalSharesBurnt
      counters[2], // totalAmountWithdrawn
      totalSupply(),
      balanceOf(address(this)),
      rate.value,
      sequenceNumber
    );
  }

  /// @notice Get pending withdrawal request at index (accounting for start index)
  /// @param index The index of the request (0-based from start index)
  /// @return The withdrawal request at the given index
  function getPendingWithdrawal(uint256 index) external view returns (WithdrawalRequest memory) {
    uint256 startIndex = withdrawalQueueStartIndex;
    uint256 queueLength = pendingWithdrawals.length;
    if (startIndex + index >= queueLength) revert IndexOutOfBounds();
    return pendingWithdrawals[startIndex + index];
  }

  /// @notice Get the effective length of the pending withdrawals queue
  /// @return The number of unprocessed withdrawal requests
  function getPendingWithdrawalsLength() external view returns (uint256) {
    uint256 startIndex = withdrawalQueueStartIndex;
    uint256 queueLength = pendingWithdrawals.length;
    return queueLength > startIndex ? queueLength - startIndex : 0;
  }

  /**
   * @dev Get the contract version
   * @return Version number
   */
  function version() external pure virtual returns (string memory) {
    return "v2.0.0";
  }

  /// @notice Get the vault name (legacy function for backwards compatibility)
  /// @return The vault name
  function vaultName() external view returns (string memory) {
    return _vaultName;
  }

  // ============================================
  // ERC-4626 Overrides
  // ============================================

  /**
   * @notice Returns total assets under management
   * @dev Overrides ERC4626 totalAssets - calculates from total shares divided by vault rate
   * @dev Note: This is a calculated value based on the rate-based conversion system,
   *      not the actual token balance (which may differ due to operator withdrawals)
   * @return Total assets in the vault based on current rate
   */
  function totalAssets() public view virtual override returns (uint256) {
    // Calculate total assets based on total shares and vault rate
    // assets = shares / rate (using rate-based conversion)
    uint256 shares = totalSupply();
    if (shares == 0) {
      return 0;
    }
    return convertToAssets(shares);
  }

  /**
   * @notice Internal conversion function from assets to shares using rate-based conversion
   * @dev Overrides ERC4626 pool-based conversion with custom rate-based formula
   * @dev Formula: shares = assets * rate
   * @dev The rounding parameter is kept for interface compatibility but unused in rate-based conversion
   * @param assets The amount of assets to convert
   * @return The equivalent amount of shares
   */
  function _convertToShares(
    uint256 assets,
    Math.Rounding /* rounding */
  ) internal view virtual override returns (uint256) {
    // Use rate-based conversion instead of pool-based
    // shares = assets * rate
    uint256 rateValue = rate.value;
    if (rateValue == 0) {
      return 0;
    }
    return FixedPointMath.mul(assets, rateValue);
  }

  /**
   * @notice Internal conversion function from shares to assets using rate-based conversion
   * @dev Overrides ERC4626 pool-based conversion with custom rate-based formula
   * @dev Formula: assets = shares / rate (with ceiling for Ceil rounding)
   * @param shares The amount of shares to convert
   * @param rounding The rounding direction (Down or Ceil)
   * @return The equivalent amount of assets
   */
  function _convertToAssets(
    uint256 shares,
    Math.Rounding rounding
  ) internal view virtual override returns (uint256) {
    // Use rate-based conversion instead of pool-based
    // assets = shares / rate
    uint256 rateValue = rate.value;
    if (rateValue == 0 || shares == 0) {
      return 0;
    }

    // Use ceiling division for Ceil rounding (used in mint operations)
    // Use regular division for Down rounding (used in withdraw operations)
    if (rounding == Math.Rounding.Ceil) {
      return FixedPointMath.divCeil(shares, rateValue);
    } else {
      return FixedPointMath.div(shares, rateValue);
    }
  }

  /**
   * @notice Standard ERC-4626 withdraw is disabled
   * @dev Users must use redeemShares() and wait for processWithdrawalRequests()
   */
  function withdraw(uint256, address, address) public virtual override returns (uint256) {
    revert UseRedeemShares();
  }

  /**
   * @notice Standard ERC-4626 redeem is disabled
   * @dev Users must use redeemShares() and wait for processWithdrawalRequests()
   */
  function redeem(uint256, address, address) public virtual override returns (uint256) {
    revert UseRedeemShares();
  }

  /**
   * @notice Returns the maximum assets the owner would receive if they redeemed all their shares
   * @dev This is an estimate based on current rate. Actual withdrawal requires requestRedeem flow.
   *      Note: Instant withdrawals are disabled - users must use requestRedeem and wait for processing.
   * @param account The address of the share owner
   * @return Maximum assets the owner would receive at current rate
   */
  function maxWithdraw(address account) public view virtual override returns (uint256) {
    uint256 ownerShares = balanceOf(account);
    if (ownerShares == 0) {
      return 0;
    }
    // Convert shares to assets using rate-based conversion
    return convertToAssets(ownerShares);
  }

  /**
   * @notice Returns the maximum shares the owner can redeem (their full balance)
   * @dev This represents all shares the owner holds. Actual redemption requires requestRedeem flow.
   *      Note: Instant redemptions are disabled - users must use requestRedeem and wait for processing.
   * @param account The address of the share owner
   * @return Maximum shares the owner can redeem
   */
  function maxRedeem(address account) public view virtual override returns (uint256) {
    return balanceOf(account);
  }

  /**
   * @notice Returns the maximum amount that can be deposited
   * @dev Returns remaining capacity until maxTVL is reached, or 0 if deposits are paused
   */
  function maxDeposit(address) public view virtual override returns (uint256) {
    if (pauseStatus.deposits || protocolConfig.getProtocolPauseStatus()) {
      return 0;
    }
    uint256 currentTVL = totalAssets();
    if (currentTVL >= maxTVL) {
      return 0;
    }
    return maxTVL - currentTVL;
  }

  /**
   * @notice Returns the maximum shares that can be minted
   * @dev Based on remaining TVL capacity
   */
  function maxMint(address) public view virtual override returns (uint256) {
    if (pauseStatus.deposits || protocolConfig.getProtocolPauseStatus()) {
      return 0;
    }
    uint256 currentTVL = totalAssets();
    if (currentTVL >= maxTVL) {
      return 0;
    }
    uint256 remainingCapacity = maxTVL - currentTVL;
    // Convert remaining capacity to shares using rate-based conversion
    return convertToShares(remainingCapacity);
  }

  /**
   * @notice ERC-4626 deposit - deposits assets and mints shares
   * @dev Overrides base implementation with custom logic
   * @param assets Amount of assets to deposit
   * @param receiver Address to receive the shares
   * @return shares Amount of shares minted
   */
  function deposit(
    uint256 assets,
    address receiver
  ) public virtual override nonReentrant returns (uint256 shares) {
    return _deposit(assets, receiver, msg.sender);
  }

  /**
   * @notice Deposits assets using ERC20 Permit for gasless approval
   * @dev Combines permit approval and deposit in a single transaction
   * @dev Requires the underlying collateral token to support ERC20 Permit (EIP-2612)
   * @param assets Amount of assets to deposit
   * @param receiver Address to receive the shares
   * @param deadline Permit signature deadline
   * @param v Permit signature v component
   * @param r Permit signature r component
   * @param s Permit signature s component
   * @return shares Amount of shares minted
   */
  function depositWithPermit(
    uint256 assets,
    address receiver,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external nonReentrant returns (uint256 shares) {
    // Call permit on the underlying asset - reverts naturally if unsupported
    IERC20Permit(asset()).permit(msg.sender, address(this), assets, deadline, v, r, s);
    return _deposit(assets, receiver, msg.sender);
  }

  /**
   * @notice ERC-4626 mint - mints exact shares by depositing required assets
   * @dev Overrides base implementation with custom logic
   * @param shares Amount of shares to mint
   * @param receiver Address to receive the shares
   * @return assets Amount of assets deposited
   */
  function mint(
    uint256 shares,
    address receiver
  ) public virtual override nonReentrant returns (uint256 assets) {
    return _mintShares(shares, receiver, msg.sender);
  }

  /**
   * @notice Mints exact shares using ERC20 Permit for gasless approval
   * @dev Combines permit approval and mint in a single transaction
   * @dev Requires the underlying collateral token to support ERC20 Permit (EIP-2612)
   * @param shares Amount of shares to mint
   * @param receiver Address to receive the shares
   * @param deadline Permit signature deadline
   * @param v Permit signature v component
   * @param r Permit signature r component
   * @param s Permit signature s component
   * @return assets Amount of assets deposited
   */
  function mintWithPermit(
    uint256 shares,
    address receiver,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external nonReentrant returns (uint256 assets) {
    // Calculate assets required first to know the approval amount
    if (shares == 0) revert ZeroAmount();
    assets = _convertToAssets(shares, Math.Rounding.Ceil);
    if (assets == 0) revert ZeroAmount();
    // Call permit on the underlying asset - reverts naturally if unsupported
    IERC20Permit(asset()).permit(msg.sender, address(this), assets, deadline, v, r, s);
    return _mintShares(shares, receiver, msg.sender);
  }

  /// @notice Get the current chain timestamp in milliseconds
  /// @return Timestamp in milliseconds
  function getChainTimestampMs() public view returns (uint256) {
    return _getChainTimestampMs();
  }

  /// @notice Get the account state for a given address
  /// @param accountAddress The address of the account to query
  /// @return totalPendingWithdrawalShares The total amount of shares pending for withdrawal
  /// @return pendingWithdrawalRequestSequenceNumbers Array of sequence numbers for pending withdrawal requests
  /// @return cancelWithdrawRequestSequenceNumbers Array of sequence numbers for cancelled withdrawal requests
  function getAccountState(
    address accountAddress
  )
    public
    view
    returns (
      uint256 totalPendingWithdrawalShares,
      uint256[] memory pendingWithdrawalRequestSequenceNumbers,
      uint256[] memory cancelWithdrawRequestSequenceNumbers
    )
  {
    Account storage account = accounts[accountAddress];
    return (
      account.totalPendingWithdrawalShares,
      account.pendingWithdrawalRequestSequenceNumbers,
      account.cancelWithdrawRequestSequenceNumbers
    );
  }

  /// @notice Internal function to get the current chain timestamp in milliseconds
  /// @return Timestamp in milliseconds
  function _getChainTimestampMs() internal view returns (uint256) {
    return block.timestamp * 1000;
  }

  /// @notice Internal helper to increment the sequence number
  function _incrementSequence() internal {
    unchecked {
      sequenceNumber++;
    }
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

  /// @notice Internal function to charge accrued platform fees
  /// @dev Calculates fees based on TVL, fee percentage, and elapsed time
  function _chargeAccruedPlatformFees() internal {
    uint256 currentTime = _getChainTimestampMs();

    // Cache storage variables
    uint256 lastChargedAt = platformFee.lastChargedAt;
    uint256 feePercentage = platformFee.platformFeePercentage;
    uint256 accruedFees = platformFee.accrued;

    // Calculate elapsed time in milliseconds
    if (currentTime <= lastChargedAt) {
      return; // No time has passed or time went backwards
    }

    uint256 elapsedTimeMs;
    unchecked {
      elapsedTimeMs = currentTime - lastChargedAt;
    }

    // Get TVL
    uint256 tvl = totalAssets();

    if (tvl == 0) {
      // Update last charged time even if TVL is 0
      platformFee.lastChargedAt = currentTime;
      return;
    }

    // Calculate TVL available for fee calculation (exclude already accrued fees)
    // This prevents fees from compounding on themselves
    uint256 tvlForFeeCalc = tvl > accruedFees ? tvl - accruedFees : 0;

    if (tvlForFeeCalc == 0) {
      // Update last charged time even if net TVL is 0
      platformFee.lastChargedAt = currentTime;
      return;
    }

    // FEE_DENOMINATOR = 1e18 * 365 * 24 * 60 * 60 * 1000 = 31_536_000_000_000_000_000_000_000_000
    // fee_amount = (tvlForFeeCalc * fee_percentage * elapsed_time_ms) / FEE_DENOMINATOR
    // Note: feePercentage is already in 1e18 format, and FEE_DENOMINATOR includes 1e18,
    // so we should NOT divide by 1e18 separately

    // Calculate fee amount on net TVL: (tvlForFeeCalc * fee_percentage * elapsed_time_ms) / FEE_DENOMINATOR
    // Use safe math to prevent overflow - break into steps to avoid intermediate overflow
    uint256 temp = tvlForFeeCalc * feePercentage;
    // Then multiply by elapsed time
    uint256 numerator = temp * elapsedTimeMs;
    uint256 feeAmount = numerator / FEE_DENOMINATOR;

    // Update accrued fee and last charged time
    uint256 newAccrued;
    unchecked {
      newAccrued = platformFee.accrued + feeAmount;
      platformFee.accrued = newAccrued;
    }
    _incrementSequence();
    platformFee.lastChargedAt = currentTime;

    uint256 currentSequenceNumber = sequenceNumber;

    emit VaultPlatformFeeCharged(
      address(this),
      feeAmount,
      newAccrued,
      currentTime,
      currentSequenceNumber
    );
  }

  /// @notice Internal helper to validate deposit requirements
  /// @param depositor Address of the depositor
  /// @param configProxy Protocol config proxy
  function _validateDeposit(address depositor, IEmberProtocolConfig configProxy) internal view {
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.deposits) revert OperationPaused();
    if (configProxy.isAccountBlacklisted(depositor)) revert Blacklisted();
    if (subAccounts[depositor]) revert InvalidValue();
    if (address(vaultValidator) != address(0)) {
      vaultValidator.validateDeposit(address(this), depositor);
    }
  }

  /// @notice Internal helper that implements the core deposit logic
  /// @param assets Amount of assets to deposit
  /// @param receiver Address to receive the shares
  /// @param depositor Address of the depositor
  /// @return shares Amount of shares minted
  function _deposit(
    uint256 assets,
    address receiver,
    address depositor
  ) internal returns (uint256 shares) {
    IEmberProtocolConfig configProxy = protocolConfig;

    // Charge accrued platform fees
    _chargeAccruedPlatformFees();

    _validateDeposit(depositor, configProxy);

    // Verify receiver is not blacklisted
    if (configProxy.isAccountBlacklisted(receiver)) revert Blacklisted();

    // Verify receiver is not a sub-account
    if (subAccounts[receiver]) revert InvalidValue();

    if (assets == 0) revert ZeroAmount();

    // Transfer collateral from user to vault using SafeERC20
    IERC20(asset()).safeTransferFrom(depositor, address(this), assets);

    // Calculate shares to mint using rate-based conversion
    shares = convertToShares(assets);

    if (shares == 0) revert ZeroAmount();

    // Mint shares to receiver
    _mint(receiver, shares);

    uint256 totalShares = totalSupply();

    // Check TVL doesn't exceed maxTVL
    uint256 currentTVL = totalAssets();
    if (currentTVL > maxTVL) revert MaxTVLReached();

    // Increment sequence number
    _incrementSequence();

    uint256 currentTime = _getChainTimestampMs();

    // Record last deposit timestamp for time-based withdrawal fee calculation
    if (address(vaultValidator) != address(0)) {
      vaultValidator.recordDeposit(address(this), receiver, currentTime);
    }

    uint256 currentSequenceNumber = sequenceNumber;

    emit VaultDeposit(
      address(this),
      depositor,
      receiver,
      assets,
      shares,
      totalShares,
      currentTime,
      currentSequenceNumber
    );

    return shares;
  }

  /// @notice Internal helper that implements the core mint logic
  /// @param shares Amount of shares to mint
  /// @param receiver Address to receive the shares
  /// @param depositor Address of the depositor
  /// @return assets Amount of assets deposited
  function _mintShares(
    uint256 shares,
    address receiver,
    address depositor
  ) internal returns (uint256 assets) {
    IEmberProtocolConfig configProxy = protocolConfig;
    _chargeAccruedPlatformFees();

    _validateDeposit(depositor, configProxy);

    // Verify receiver is not blacklisted
    if (configProxy.isAccountBlacklisted(receiver)) revert Blacklisted();

    // Verify receiver is not a sub-account
    if (subAccounts[receiver]) revert InvalidValue();

    if (shares == 0) revert ZeroAmount();

    // Calculate assets required using rate-based conversion with ceiling rounding
    assets = _convertToAssets(shares, Math.Rounding.Ceil);
    if (assets == 0) revert ZeroAmount();

    // Transfer collateral from user to vault using SafeERC20
    IERC20(asset()).safeTransferFrom(depositor, address(this), assets);

    _mint(receiver, shares);
    if (totalAssets() > maxTVL) revert MaxTVLReached();

    _incrementSequence();

    uint256 totalShares = totalSupply();
    uint256 currentTime = _getChainTimestampMs();

    // Record last deposit timestamp for time-based withdrawal fee calculation
    if (address(vaultValidator) != address(0)) {
      vaultValidator.recordDeposit(address(this), receiver, currentTime);
    }

    uint256 currentSequenceNumber = sequenceNumber;

    emit VaultDeposit(
      address(this),
      depositor,
      receiver,
      assets,
      shares,
      totalShares,
      currentTime,
      currentSequenceNumber
    );

    return assets;
  }

  /// @notice Internal helper to update account state for a withdrawal request
  /// @param request The withdrawal request
  /// @param add Whether to add or subtract the shares
  /// @param index An optional index indicating the index of request that got cancelled (use type(uint256).max for none)
  function _updateAccountState(WithdrawalRequest memory request, bool add, uint256 index) internal {
    if (add && index != type(uint256).max) revert InvalidRequest();

    Account storage accountState = accounts[request.owner];

    if (add) {
      unchecked {
        accountState.totalPendingWithdrawalShares += request.shares;
      }
      accountState.pendingWithdrawalRequestSequenceNumbers.push(request.sequenceNumber);
    } else {
      if (accountState.totalPendingWithdrawalShares < request.shares) revert InsufficientShares();
      unchecked {
        accountState.totalPendingWithdrawalShares -= request.shares;
      }

      // Find and remove the specific sequence number from the pending requests array
      uint256[] storage pendingSeqNums = accountState.pendingWithdrawalRequestSequenceNumbers;
      uint256 pendingLength = pendingSeqNums.length;
      if (pendingLength == 0) revert InvalidRequest();

      // Cache the sequence number to avoid repeated memory reads
      uint256 reqSeqNum = request.sequenceNumber;

      // Find the index of the sequence number to remove
      uint256 seqNumIndex = 0;
      bool found = false;
      for (uint256 i; i < pendingLength; ) {
        if (pendingSeqNums[i] == reqSeqNum) {
          seqNumIndex = i;
          found = true;
          break;
        }
        unchecked {
          ++i;
        }
      }

      // If sequence number not found, revert
      if (!found) revert InvalidRequest();

      // Use swap-and-pop: move last element to the removed position, then pop
      uint256 lastIndex = pendingLength - 1;
      if (seqNumIndex != lastIndex) {
        pendingSeqNums[seqNumIndex] = pendingSeqNums[lastIndex];
      }
      pendingSeqNums.pop();

      // If this request was skipped due to cancellation, remove its sequence number
      if (index != type(uint256).max) {
        uint256[] storage cancelSeqNums = accountState.cancelWithdrawRequestSequenceNumbers;
        uint256 cancelLength = cancelSeqNums.length;
        // Defensive check: ensure index is within bounds
        if (index < cancelLength) {
          // Use swap-and-pop
          unchecked {
            uint256 lastCancelIndex = cancelLength - 1;
            if (index != lastCancelIndex) {
              cancelSeqNums[index] = cancelSeqNums[lastCancelIndex];
            }
          }
          cancelSeqNums.pop();
        }
      }
    }
  }

  /// @notice Internal helper to process a single withdrawal request
  /// @dev NOTE: This function makes external calls (blacklist checks, token transfers) and is called in a loop
  ///      by processWithdrawalRequests(). The loop is bounded by numRequests parameter to prevent excessive gas usage.
  ///      External calls are necessary for security (blacklist checks) and functionality (token transfers).
  /// @param request The withdrawal request to process
  /// @param currentTime The current timestamp in milliseconds
  /// @return skipped Whether the request was skipped
  /// @return cancelled Whether the request was cancelled
  /// @return withdrawAmount The amount withdrawn (0 if skipped)
  /// @return sharesBurnt The number of shares burnt
  function _processRequest(
    WithdrawalRequest memory request,
    uint256 currentTime
  ) internal returns (bool skipped, bool cancelled, uint256 withdrawAmount, uint256 sharesBurnt) {
    // Cache storage variables
    IEmberProtocolConfig configProxy = protocolConfig;

    // Calculate withdraw amount using rate-based conversion
    withdrawAmount = convertToAssets(request.shares);

    Account storage accountState = accounts[request.owner];
    uint256[] storage cancelSeqNums = accountState.cancelWithdrawRequestSequenceNumbers;
    uint256 numCancelledRequests = cancelSeqNums.length;

    // Check if request was cancelled
    bool isCancelled = false;
    uint256 cancelIndex = type(uint256).max;
    uint256 requestSeqNum = request.sequenceNumber;

    for (uint256 i = 0; i < numCancelledRequests; ) {
      if (cancelSeqNums[i] == requestSeqNum) {
        isCancelled = true;
        cancelIndex = i;
        break;
      }
      unchecked {
        i++;
      }
    }

    cancelled = isCancelled;

    // Determine the index to use for account state update
    uint256 indexToUse = isCancelled ? cancelIndex : type(uint256).max;

    // Check if request should be skipped (blacklisted owner/receiver, cancelled, or zero withdraw amount)
    bool ownerBlacklisted = configProxy.isAccountBlacklisted(request.owner);
    bool receiverBlacklisted = configProxy.isAccountBlacklisted(request.receiver);
    bool shouldSkip = ownerBlacklisted || receiverBlacklisted || isCancelled || withdrawAmount == 0;

    uint256 permanentFeeCharged = 0;
    uint256 timeBasedFeeCharged = 0;

    if (shouldSkip) {
      // If skipped due to blacklisting or zero amount (not cancellation), set index to numCancelledRequests
      if (!isCancelled) {
        indexToUse = numCancelledRequests;
      }

      skipped = true;
      withdrawAmount = 0;
      sharesBurnt = 0; // No shares were burnt since request was skipped

      // Return shares to owner (use _transfer to transfer from vault, not from msg.sender)
      _transfer(address(this), request.owner, request.shares);
    } else {
      skipped = false;

      // Calculate withdrawal fees via validator
      if (address(vaultValidator) != address(0)) {
        (permanentFeeCharged, timeBasedFeeCharged) = vaultValidator.calculateWithdrawalFees(
          address(this),
          request.owner,
          withdrawAmount,
          currentTime
        );
        uint256 totalFee = permanentFeeCharged + timeBasedFeeCharged;
        if (totalFee > 0) {
          withdrawAmount -= totalFee;
        }
      }

      // Burn shares (they are already in the vault from redeemShares)
      _burn(address(this), request.shares);
      sharesBurnt = request.shares; // Shares were actually burnt

      // Check vault has sufficient balance
      if (IERC20(asset()).balanceOf(address(this)) < withdrawAmount) revert InsufficientBalance();

      // Transfer funds to receiver using SafeERC20
      IERC20(asset()).safeTransfer(request.receiver, withdrawAmount);
    }

    // Update account state
    _updateAccountState(request, false, indexToUse);

    // Cache values for event
    uint256 totalShares = totalSupply();
    uint256 totalSharesPendingToBurn = balanceOf(address(this));
    uint256 currentSequenceNumber = sequenceNumber;

    emit RequestProcessed(
      address(this),
      request.owner,
      request.receiver,
      request.shares,
      withdrawAmount,
      request.timestamp,
      currentTime,
      skipped,
      cancelled,
      totalShares,
      totalSharesPendingToBurn,
      currentSequenceNumber,
      requestSeqNum
    );

    if (permanentFeeCharged > 0 || timeBasedFeeCharged > 0) {
      emit WithdrawalFeeCharged(
        address(this),
        request.owner,
        requestSeqNum,
        permanentFeeCharged,
        timeBasedFeeCharged
      );
    }
  }
}
