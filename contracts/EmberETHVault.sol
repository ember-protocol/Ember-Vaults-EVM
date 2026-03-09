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
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IEmberProtocolConfig.sol";
import "./interfaces/IWETH.sol";
import "./libraries/Math.sol"; // FixedPointMath library

// Custom errors
error OperationPaused();
error InsufficientBalance();
error InsufficientShares();
error TransferFailed();
error InvalidRequest();
error MaxTVLReached();
error ZeroAmount();
error IndexOutOfBounds();
error UseRedeemShares();
error ETHTransferFailed();
error InvalidWETHAddress();

/**
 * @title EmberETHVault
 * @dev Upgradeable ERC-4626 compliant ETH/WETH vault using UUPS proxy pattern
 * @notice Specialized vault for ETH/WETH with the following behavior:
 *         - Stores WETH (ERC20) as the underlying asset (ERC4626 compliant)
 *         - Accepts both native ETH and WETH deposits
 *         - ETH deposits are automatically wrapped to WETH
 *         - User withdrawals send native ETH (WETH is unwrapped)
 *         - Sub-account withdrawals send WETH (for DeFi strategies)
 * 
 * Key Differences from EmberVault:
 * - depositETH() - wraps ETH to WETH, then deposits
 * - mintWithETH() - wraps ETH to WETH, then mints shares
 * - processWithdrawalRequests() - unwraps WETH to ETH before sending to users
 * - withdrawFromVaultWithoutRedeemingShares() - sends WETH to sub-accounts (unchanged)
 * 
 * Maintains full ERC-4626 compliance with WETH as the asset.
 */
contract EmberETHVault is
  Initializable,
  ERC4626Upgradeable,
  UUPSUpgradeable,
  OwnableUpgradeable,
  ReentrancyGuardUpgradeable
{
  using SafeERC20 for IERC20;

  // Structs (identical to EmberVault)
  struct PlatformFee {
    uint256 accrued;
    uint256 lastChargedAt;
    uint256 platformFeePercentage;
  }

  struct Rate {
    uint256 value;
    uint256 maxRateChangePerUpdate;
    uint256 rateUpdateInterval;
    uint256 lastUpdatedAt;
  }

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

  struct WithdrawalRequest {
    address owner;
    address receiver;
    uint256 shares;
    uint256 estimatedWithdrawAmount;
    uint256 timestamp;
    uint256 sequenceNumber;
  }

  struct Account {
    uint256 totalPendingWithdrawalShares;
    uint256[] pendingWithdrawalRequestSequenceNumbers;
    uint256[] cancelWithdrawRequestSequenceNumbers;
  }

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
  uint256 private constant FEE_DENOMINATOR = 31_536_000_000_000_000_000_000_000_000;
  bytes32 private constant DEPOSITS_HASH = keccak256("deposits");
  bytes32 private constant WITHDRAWALS_HASH = keccak256("withdrawals");
  bytes32 private constant PRIVILEGED_OPS_HASH = keccak256("privilegedOperations");
  bytes32 private constant WETH_SYMBOL_HASH = keccak256("WETH");

  // State variables
  string private _vaultName;
  uint256 public maxTVL;
  uint256 public minWithdrawableShares;
  mapping(address => bool) public subAccounts;
  
  PlatformFee public platformFee;
  Rate public rate;
  Roles public roles;
  IEmberProtocolConfig public protocolConfig;
  PauseStatus public pauseStatus;
  
  uint256 public sequenceNumber;
  WithdrawalRequest[] public pendingWithdrawals;
  uint256 private withdrawalQueueStartIndex;
  mapping(address => Account) public accounts;

  // Events (identical to EmberVault)
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

  event VaultRateManagerUpdated(
    address indexed vault,
    address indexed previousRateManager,
    address indexed newRateManager,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultMaxTVLUpdated(
    address indexed vault,
    uint256 previousMaxTVL,
    uint256 newMaxTVL,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultRateUpdateIntervalChanged(
    address indexed vault,
    uint256 previousInterval,
    uint256 newInterval,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultAdminChanged(
    address indexed vault,
    address indexed previousAdmin,
    address indexed newAdmin,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultOperatorChanged(
    address indexed vault,
    address indexed previousOperator,
    address indexed newOperator,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultFeePercentageUpdated(
    address indexed vault,
    uint256 previousFeePercentage,
    uint256 newFeePercentage,
    uint256 timestamp,
    uint256 sequenceNumber
  );

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

  event VaultSubAccountUpdated(
    address indexed vault,
    address indexed account,
    bool isSubAccount,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultPauseStatusUpdated(
    address indexed vault,
    string operation,
    bool paused,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultRateUpdated(
    address indexed vault,
    uint256 previousRate,
    uint256 newRate,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultPlatformFeeCharged(
    address indexed vault,
    uint256 feeAmount,
    uint256 totalAccrued,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event VaultPlatformFeeCollected(
    address indexed vault,
    address indexed recipient,
    uint256 amount,
    uint256 timestamp,
    uint256 sequenceNumber
  );

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

  event RequestCancelled(
    address indexed vault,
    address indexed owner,
    uint256 requestSequenceNumber,
    uint256[] cancelWithdrawRequestSequenceNumbers,
    uint256 timestamp
  );

  event VaultWithdrawalWithoutRedeemingShares(
    address indexed vault,
    address indexed subAccount,
    uint256 previousBalance,
    uint256 newBalance,
    uint256 amount,
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
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event ETHWrapped(uint256 amount);

  // Modifiers
  modifier onlyOperator() {
    if (msg.sender != roles.operator) revert Unauthorized();
    _;
  }

  modifier onlyRateManager() {
    if (msg.sender != roles.rateManager) revert Unauthorized();
    _;
  }

  modifier onlyProtocolConfig() {
    if (msg.sender != address(protocolConfig)) revert Unauthorized();
    _;
  }

  modifier onlyAdmin(address caller) {
    if (caller != roles.admin) revert Unauthorized();
    _;
  }

  modifier onlyOwnerCaller(address caller) {
    if (caller != owner()) revert Unauthorized();
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @notice Initialize the ETH vault
   * @dev Sets WETH as the underlying ERC4626 asset
   * @param _protocolConfig Address of the protocol config contract
   * @param initialOwner Address of the initial owner
   * @param params Initialization parameters (collateralToken must be WETH address)
   * @param _subAccounts Initial list of sub-accounts
   */
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
    if (params.collateralToken == address(0)) revert ZeroAddress();
    
    // Verify collateralToken is a WETH contract by checking it implements IWETH interface
    if (!_isWETH(params.collateralToken)) revert InvalidWETHAddress();
    
    if (
      params.admin == params.operator ||
      params.admin == params.rateManager ||
      params.operator == params.rateManager
    ) revert InvalidValue();

    IEmberProtocolConfig configProxy = IEmberProtocolConfig(_protocolConfig);

    if (
      params.rateUpdateInterval < configProxy.getMinRateInterval() ||
      params.rateUpdateInterval > configProxy.getMaxRateInterval() ||
      params.rateUpdateInterval == configProxy.getMinRateInterval()
    ) revert InvalidInterval();

    if (params.feePercentage >= configProxy.getMaxAllowedFeePercentage()) revert InvalidValue();

    // Initialize ERC4626 with WETH as the underlying asset
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

    pauseStatus = PauseStatus({
      deposits: false,
      withdrawals: false,
      privilegedOperations: false
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
  // ETH Receive Function
  // ============================================

  /**
   * @notice Receive ETH from WETH contract during withdrawals
   * @dev Required for WETH.withdraw() to send ETH back to this contract
   */
  receive() external payable {}

  // ============================================
  // ETH-Specific Deposit Functions
  // ============================================

  /**
   * @notice Deposit native ETH (wraps to WETH then deposits)
   * @param receiver Address to receive the shares
   * @return shares Amount of shares minted
   */
  function depositETH(address receiver) external payable nonReentrant returns (uint256 shares) {
    if (msg.value == 0) revert ZeroAmount();
    
    // Wrap ETH to WETH
    IWETH(asset()).deposit{value: msg.value}();
    emit ETHWrapped(msg.value);
    
    // Deposit WETH (vault now holds WETH)
    return _deposit(msg.value, receiver, address(this));
  }

  /**
   * @notice Mint exact shares with native ETH (wraps to WETH then mints)
   * @param shares Amount of shares to mint
   * @param receiver Address to receive the shares
   * @return assets Amount of ETH consumed
   */
  function mintWithETH(uint256 shares, address receiver) external payable nonReentrant returns (uint256 assets) {
    assets = previewMint(shares);
    if (msg.value < assets) revert InsufficientBalance();
    
    // Wrap exact amount needed
    IWETH(asset()).deposit{value: assets}();
    emit ETHWrapped(assets);
    
    // Deposit WETH
    _deposit(assets, receiver, address(this));
    
    // Refund excess ETH
    if (msg.value > assets) {
      uint256 refund = msg.value - assets;
      (bool success, ) = msg.sender.call{value: refund}("");
      if (!success) revert ETHTransferFailed();
    }
    
    return assets;
  }

  // ============================================
  // Standard ERC4626 Deposit Functions (WETH)
  // ============================================

  /**
   * @notice Deposit WETH and mint shares
   * @dev Standard ERC4626 deposit function
   * @param assets Amount of WETH to deposit
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
   * @notice Deposit WETH with permit signature
   * @dev Combines permit approval and deposit in a single transaction
   * @dev Requires WETH to support ERC20 Permit (EIP-2612)
   * @param assets Amount of WETH to deposit
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
    IERC20Permit(asset()).permit(msg.sender, address(this), assets, deadline, v, r, s);
    return _deposit(assets, receiver, msg.sender);
  }

  /**
   * @notice Mint exact shares with WETH
   * @dev Standard ERC4626 mint function
   * @param shares Amount of shares to mint
   * @param receiver Address to receive the shares
   * @return assets Amount of WETH deposited
   */
  function mint(
    uint256 shares,
    address receiver
  ) public virtual override nonReentrant returns (uint256 assets) {
    return _mint(shares, receiver, msg.sender);
  }

  /**
   * @notice Mint shares with WETH permit signature
   * @dev Combines permit approval and mint in a single transaction
   * @param shares Amount of shares to mint
   * @param receiver Address to receive the shares
   * @param deadline Permit signature deadline
   * @param v Permit signature v component
   * @param r Permit signature r component
   * @param s Permit signature s component
   * @return assets Amount of WETH deposited
   */
  function mintWithPermit(
    uint256 shares,
    address receiver,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external nonReentrant returns (uint256 assets) {
    assets = previewMint(shares);
    IERC20Permit(asset()).permit(msg.sender, address(this), assets, deadline, v, r, s);
    return _mint(shares, receiver, msg.sender);
  }

  /**
   * @notice Internal deposit implementation
   * @dev Modified from EmberVault to support wrapping (depositor can be vault itself)
   */
  function _deposit(
    uint256 assets,
    address receiver,
    address depositor
  ) internal returns (uint256 shares) {
    IEmberProtocolConfig configProxy = protocolConfig;

    // Charge accrued platform fees
    _chargeAccruedPlatformFees();

    _validateDeposit(msg.sender, configProxy);

    // Verify receiver is not blacklisted
    if (configProxy.isAccountBlacklisted(receiver)) revert Blacklisted();

    // Verify receiver is not a sub-account
    if (subAccounts[receiver]) revert InvalidValue();

    if (assets == 0) revert ZeroAmount();

    // Transfer WETH from depositor to vault (if depositor is not vault itself)
    if (depositor != address(this)) {
      IERC20(asset()).safeTransferFrom(depositor, address(this), assets);
    }

    // Calculate shares to mint using rate-based conversion
    shares = convertToShares(assets);

    if (shares == 0) revert ZeroAmount();

    // Mint shares to receiver
    _mint(receiver, shares);

    uint256 totalShares = totalSupply();

    // Check TVL doesn't exceed maxTVL
    uint256 currentTVL = totalAssets();
    if (currentTVL > maxTVL) revert MaxTVLReached();

    unchecked {
      sequenceNumber++;
    }

    uint256 currentTime = _getChainTimestampMs();
    uint256 currentSequenceNumber = sequenceNumber;

    emit VaultDeposit(
      address(this),
      msg.sender,
      receiver,
      assets,
      shares,
      totalShares,
      currentTime,
      currentSequenceNumber
    );
  }

  /**
   * @notice Internal mint implementation
   */
  function _mint(
    uint256 shares,
    address receiver,
    address depositor
  ) internal returns (uint256 assets) {
    IEmberProtocolConfig configProxy = protocolConfig;

    // Charge accrued platform fees
    _chargeAccruedPlatformFees();

    _validateDeposit(msg.sender, configProxy);

    // Verify receiver is not blacklisted
    if (configProxy.isAccountBlacklisted(receiver)) revert Blacklisted();

    // Verify receiver is not a sub-account
    if (subAccounts[receiver]) revert InvalidValue();

    if (shares == 0) revert ZeroAmount();

    // Calculate assets needed using rate-based conversion
    assets = convertToAssets(shares);

    if (assets == 0) revert ZeroAmount();

    // Transfer WETH from depositor to vault (if depositor is not vault itself)
    if (depositor != address(this)) {
      IERC20(asset()).safeTransferFrom(depositor, address(this), assets);
    }

    // Mint shares to receiver
    _mint(receiver, shares);

    uint256 totalShares = totalSupply();

    // Check TVL doesn't exceed maxTVL
    uint256 currentTVL = totalAssets();
    if (currentTVL > maxTVL) revert MaxTVLReached();

    unchecked {
      sequenceNumber++;
    }

    uint256 currentTime = _getChainTimestampMs();
    uint256 currentSequenceNumber = sequenceNumber;

    emit VaultDeposit(
      address(this),
      msg.sender,
      receiver,
      assets,
      shares,
      totalShares,
      currentTime,
      currentSequenceNumber
    );
  }

  function _validateDeposit(address depositor, IEmberProtocolConfig configProxy) internal view {
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.deposits) revert OperationPaused();
    if (configProxy.isAccountBlacklisted(depositor)) revert Blacklisted();
    if (subAccounts[depositor]) revert InvalidValue();
  }

  // ============================================
  // Protocol Config Setter Functions
  // ============================================

  function setMaxTVL(
    address caller,
    uint256 newMaxTVL
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    uint256 previousMaxTVL = maxTVL;
    maxTVL = newMaxTVL;
    unchecked {
      sequenceNumber++;
    }

    emit VaultMaxTVLUpdated(
      address(this),
      previousMaxTVL,
      newMaxTVL,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  function setRateUpdateInterval(
    address caller,
    uint256 newInterval
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    uint256 previousInterval = rate.rateUpdateInterval;
    rate.rateUpdateInterval = newInterval;
    unchecked {
      sequenceNumber++;
    }

    emit VaultRateUpdateIntervalChanged(
      address(this),
      previousInterval,
      newInterval,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  function setAdmin(
    address caller,
    address newAdmin
  ) external nonReentrant onlyProtocolConfig onlyOwnerCaller(caller) {
    address previousAdmin = roles.admin;
    roles.admin = newAdmin;
    unchecked {
      sequenceNumber++;
    }

    emit VaultAdminChanged(
      address(this),
      previousAdmin,
      newAdmin,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  function setOperator(
    address caller,
    address newOperator
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    address previousOperator = roles.operator;
    roles.operator = newOperator;
    unchecked {
      sequenceNumber++;
    }

    emit VaultOperatorChanged(
      address(this),
      previousOperator,
      newOperator,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  function setRateManager(
    address caller,
    address newRateManager
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    address previousRateManager = roles.rateManager;
    roles.rateManager = newRateManager;
    unchecked {
      sequenceNumber++;
    }

    emit VaultRateManagerUpdated(
      address(this),
      previousRateManager,
      newRateManager,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  function setFeePercentage(
    address caller,
    uint256 newFeePercentage
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    uint256 previousFeePercentage = platformFee.platformFeePercentage;
    platformFee.platformFeePercentage = newFeePercentage;
    unchecked {
      sequenceNumber++;
    }

    emit VaultFeePercentageUpdated(
      address(this),
      previousFeePercentage,
      newFeePercentage,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  function setVaultName(
    address caller,
    string calldata newName
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    string memory previousName = _vaultName;
    _vaultName = newName;
    unchecked {
      sequenceNumber++;
    }

    emit VaultNameUpdated(
      address(this),
      previousName,
      newName,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  function setMinWithdrawableShares(
    address caller,
    uint256 newMinWithdrawableShares
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    uint256 previousMinWithdrawableShares = minWithdrawableShares;
    minWithdrawableShares = newMinWithdrawableShares;
    unchecked {
      sequenceNumber++;
    }

    emit VaultMinWithdrawableSharesUpdated(
      address(this),
      previousMinWithdrawableShares,
      newMinWithdrawableShares,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  function setSubAccountStatus(
    address caller,
    address account,
    bool status
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    subAccounts[account] = status;
    unchecked {
      sequenceNumber++;
    }

    emit VaultSubAccountUpdated(
      address(this),
      account,
      status,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  function setPausedStatus(
    address caller,
    string calldata operation,
    bool paused
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    bytes32 operationHash = keccak256(bytes(operation));

    if (operationHash == DEPOSITS_HASH) {
      pauseStatus.deposits = paused;
    } else if (operationHash == WITHDRAWALS_HASH) {
      pauseStatus.withdrawals = paused;
    } else if (operationHash == PRIVILEGED_OPS_HASH) {
      pauseStatus.privilegedOperations = paused;
    } else {
      revert InvalidValue();
    }

    unchecked {
      sequenceNumber++;
    }
    emit VaultPauseStatusUpdated(
      address(this),
      operation,
      paused,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  // ============================================
  // Withdrawal Functions
  // ============================================

  /**
   * @notice Request to redeem shares (users will receive ETH when processed)
   * @param shares Amount of shares to redeem
   * @param receiver Address to receive the ETH when processed
   * @return request The withdrawal request created
   */
  function redeemShares(
    uint256 shares,
    address receiver
  ) external nonReentrant returns (WithdrawalRequest memory request) {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.withdrawals) revert OperationPaused();

    address shareOwner = msg.sender;

    if (configProxy.isAccountBlacklisted(shareOwner)) revert Blacklisted();
    if (configProxy.isAccountBlacklisted(receiver)) revert Blacklisted();

    if (shares < minWithdrawableShares) revert InsufficientShares();

    // Transfer shares from user to vault
    _spendAllowance(shareOwner, address(this), shares);
    _transfer(shareOwner, address(this), shares);

    // Calculate estimated withdrawal amount
    uint256 estimatedWithdrawAmount = convertToAssets(shares);

    unchecked {
      sequenceNumber++;
    }

    uint256 currentTime = _getChainTimestampMs();

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

    // Update account state
    _updateAccountState(request, true, type(uint256).max);

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

  /**
   * @notice Cancel a pending withdrawal request
   * @param requestSequenceNumber Sequence number of the request to cancel
   */
  function cancelPendingWithdrawalRequest(uint256 requestSequenceNumber) external nonReentrant {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.withdrawals) revert OperationPaused();

    address requestOwner = msg.sender;
    Account storage accountState = accounts[requestOwner];

    if (accountState.totalPendingWithdrawalShares == 0) revert InvalidRequest();

    // Check if already cancelled
    uint256[] storage cancelList = accountState.cancelWithdrawRequestSequenceNumbers;
    for (uint256 i = 0; i < cancelList.length; i++) {
      if (cancelList[i] == requestSequenceNumber) {
        revert InvalidRequest();
      }
    }

    // Check if request exists in pending list
    uint256[] storage pendingList = accountState.pendingWithdrawalRequestSequenceNumbers;
    bool found = false;
    for (uint256 i = 0; i < pendingList.length; i++) {
      if (pendingList[i] == requestSequenceNumber) {
        found = true;
        break;
      }
    }
    if (!found) revert InvalidRequest();

    // Add to cancel list
    cancelList.push(requestSequenceNumber);

    emit RequestCancelled(
      address(this),
      requestOwner,
      requestSequenceNumber,
      cancelList,
      _getChainTimestampMs()
    );
  }

  /**
   * @notice Process withdrawal requests from the queue
   * @dev Unwraps WETH to ETH before sending to users
   * @param numRequests Number of requests to process
   */
  function processWithdrawalRequests(uint256 numRequests) external nonReentrant onlyOperator {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    if (numRequests == 0) revert ZeroAmount();

    unchecked {
      sequenceNumber++;
    }

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
    uint256[5] memory counters;

    // Process requests
    for (uint256 i = 0; i < numRequests; ) {
      WithdrawalRequest memory request = pendingWithdrawals[startIndex];
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
        counters[1]++;
        counters[0] += sharesBurnt;
        counters[2] += withdrawAmount;
        if (skipped) counters[3]++;
        if (cancelled) counters[4]++;
      }
    }
    
    // Reset queue if empty
    if (startIndex >= queueLength) {
      delete pendingWithdrawals;
      withdrawalQueueStartIndex = 0;
    } else {
      withdrawalQueueStartIndex = startIndex;
    }

    // Charge accrued platform fees
    _chargeAccruedPlatformFees();

    emit ProcessRequestsSummary(
      address(this),
      counters[1],
      counters[3],
      counters[4],
      counters[0],
      counters[2],
      totalSupply(),
      balanceOf(address(this)),
      rate.value,
      currentTime,
      sequenceNumber
    );
  }

  /**
   * @notice Internal function to process a single withdrawal request
   * @dev Unwraps WETH to ETH before sending to user
   */
  function _processRequest(
    WithdrawalRequest memory request,
    uint256 currentTime
  ) internal returns (bool skipped, bool cancelled, uint256 withdrawAmount, uint256 sharesBurnt) {
    withdrawAmount = convertToAssets(request.shares);

    (cancelled, skipped, sharesBurnt, withdrawAmount) = _executeWithdrawalWithETH(request, withdrawAmount);

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
      totalSupply(),
      balanceOf(address(this)),
      sequenceNumber,
      request.sequenceNumber
    );
  }

  /**
   * @notice Execute withdrawal with WETH unwrapping
   */
  function _executeWithdrawalWithETH(
    WithdrawalRequest memory request,
    uint256 withdrawAmount
  ) internal returns (bool cancelled, bool skipped, uint256 sharesBurnt, uint256 finalWithdrawAmount) {
    Account storage accountState = accounts[request.owner];
    
    // Check if cancelled
    (cancelled, ) = _checkCancellation(request.sequenceNumber, accountState);
    
    // Check if should skip
    skipped = _shouldSkipRequest(request, cancelled, withdrawAmount);

    uint256 indexToUse = cancelled ? _findCancelIndex(request.sequenceNumber, accountState) : type(uint256).max;
    
    if (skipped) {
      if (!cancelled) {
        indexToUse = accountState.cancelWithdrawRequestSequenceNumbers.length;
      }
      sharesBurnt = 0;
      finalWithdrawAmount = 0;
      _transfer(address(this), request.owner, request.shares);
    } else {
      _burn(address(this), request.shares);
      sharesBurnt = request.shares;
      finalWithdrawAmount = withdrawAmount;

      if (IERC20(asset()).balanceOf(address(this)) < withdrawAmount) revert InsufficientBalance();

      // Unwrap WETH to ETH
      IWETH(asset()).withdraw(withdrawAmount);

      // Send ETH to receiver
      (bool success, ) = request.receiver.call{value: withdrawAmount}("");
      if (!success) revert ETHTransferFailed();
    }

    _updateAccountState(request, false, indexToUse);
  }

  /**
   * @notice Check if a request was cancelled
   */
  function _checkCancellation(
    uint256 requestSeqNum,
    Account storage accountState
  ) internal view returns (bool isCancelled, uint256 cancelIndex) {
    uint256[] storage cancelSeqNums = accountState.cancelWithdrawRequestSequenceNumbers;
    cancelIndex = type(uint256).max;
    
    for (uint256 i = 0; i < cancelSeqNums.length; ) {
      if (cancelSeqNums[i] == requestSeqNum) {
        return (true, i);
      }
      unchecked {
        i++;
      }
    }
    return (false, type(uint256).max);
  }

  /**
   * @notice Find cancel index for a request
   */
  function _findCancelIndex(
    uint256 requestSeqNum,
    Account storage accountState
  ) internal view returns (uint256) {
    uint256[] storage cancelSeqNums = accountState.cancelWithdrawRequestSequenceNumbers;
    
    for (uint256 i = 0; i < cancelSeqNums.length; ) {
      if (cancelSeqNums[i] == requestSeqNum) {
        return i;
      }
      unchecked {
        i++;
      }
    }
    return type(uint256).max;
  }

  /**
   * @notice Check if request should be skipped
   */
  function _shouldSkipRequest(
    WithdrawalRequest memory request,
    bool isCancelled,
    uint256 withdrawAmount
  ) internal view returns (bool) {
    if (isCancelled || withdrawAmount == 0) return true;
    
    IEmberProtocolConfig configProxy = protocolConfig;
    return configProxy.isAccountBlacklisted(request.owner) || 
           configProxy.isAccountBlacklisted(request.receiver);
  }

  /**
   * @notice Update account state for withdrawal tracking
   */
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

      uint256[] storage pendingSeqNums = accountState.pendingWithdrawalRequestSequenceNumbers;
      uint256 pendingLength = pendingSeqNums.length;
      if (pendingLength == 0) revert InvalidRequest();

      uint256 reqSeqNum = request.sequenceNumber;

      uint256 seqNumIndex = 0;
      bool found = false;
      for (uint256 i; i < pendingLength; ) {
        if (pendingSeqNums[i] == reqSeqNum) {
          seqNumIndex = i;
          found = true;
          break;
        }
        unchecked {
          i++;
        }
      }

      if (!found) revert InvalidRequest();

      pendingSeqNums[seqNumIndex] = pendingSeqNums[pendingLength - 1];
      pendingSeqNums.pop();

      // If this was a cancelled request, remove from cancel list
      if (index != type(uint256).max) {
        uint256[] storage cancelSeqNums = accountState.cancelWithdrawRequestSequenceNumbers;
        uint256 cancelLength = cancelSeqNums.length;

        if (index >= cancelLength) revert IndexOutOfBounds();

        cancelSeqNums[index] = cancelSeqNums[cancelLength - 1];
        cancelSeqNums.pop();
      }
    }
  }

  /**
   * @notice Withdraw WETH from vault without redeeming shares (operator only)
   * @dev Used to move WETH to sub-accounts for strategy execution
   * @dev Sends WETH (not ETH) to sub-accounts for DeFi compatibility
   * @param subAccount Address of the whitelisted sub-account
   * @param amount Amount of WETH to withdraw
   */
  function withdrawFromVaultWithoutRedeemingShares(
    address subAccount,
    uint256 amount
  ) external nonReentrant onlyOperator {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();
    if (!subAccounts[subAccount]) revert InvalidValue();
    if (amount == 0) revert ZeroAmount();

    uint256 vaultBalance = IERC20(asset()).balanceOf(address(this));
    if (amount > vaultBalance) revert InsufficientBalance();

    uint256 previousBalance = vaultBalance;

    // Transfer WETH to sub account (NOT unwrapped - sub-accounts get WETH)
    IERC20(asset()).safeTransfer(subAccount, amount);

    uint256 newBalance = IERC20(asset()).balanceOf(address(this));

    unchecked {
      sequenceNumber++;
    }

    emit VaultWithdrawalWithoutRedeemingShares(
      address(this),
      subAccount,
      previousBalance,
      newBalance,
      amount,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  // ============================================
  // Rate Management
  // ============================================

  /**
   * @notice Update the vault rate
   * @param newRate New rate value (1e18 precision)
   */
  function updateVaultRate(uint256 newRate) external nonReentrant onlyRateManager {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    // Charge accrued platform fees
    _chargeAccruedPlatformFees();

    uint256 currentTime = _getChainTimestampMs();
    uint256 lastUpdatedAt = rate.lastUpdatedAt;

    // Check enough time has passed
    if (currentTime < lastUpdatedAt + rate.rateUpdateInterval) revert InvalidInterval();

    // Validate rate is within bounds
    if (newRate < configProxy.getMinRate() || newRate > configProxy.getMaxRate())
      revert InvalidRate();

    // Calculate percentage change
    uint256 percentChange = FixedPointMath.percentChangeFrom(rate.value, newRate);

    // Validate rate change is within allowed limit
    if (percentChange > rate.maxRateChangePerUpdate) revert InvalidRate();

    // Check rate is different
    if (newRate == rate.value) revert SameValue();

    uint256 previousRate = rate.value;

    rate.value = newRate;
    rate.lastUpdatedAt = currentTime;

    unchecked {
      sequenceNumber++;
    }
    emit VaultRateUpdated(address(this), previousRate, newRate, currentTime, sequenceNumber);
  }

  /**
   * @notice Collect accrued platform fees (sends WETH)
   */
  function collectPlatformFee() external nonReentrant onlyOperator returns (uint256 amount) {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    // Charge accrued platform fees
    _chargeAccruedPlatformFees();

    if (platformFee.accrued == 0) revert ZeroAmount();

    amount = platformFee.accrued;

    // Check vault has sufficient balance
    uint256 vaultBalance = IERC20(asset()).balanceOf(address(this));
    if (amount > vaultBalance) revert InsufficientBalance();

    platformFee.accrued = 0;

    address feeRecipient = configProxy.getPlatformFeeRecipient();

    // Transfer WETH to platform fee recipient (NOT unwrapped)
    IERC20(asset()).safeTransfer(feeRecipient, amount);

    unchecked {
      sequenceNumber++;
    }

    emit VaultPlatformFeeCollected(
      address(this),
      feeRecipient,
      amount,
      _getChainTimestampMs(),
      sequenceNumber
    );

    return amount;
  }

  /**
   * @notice Charge accrued platform fees
   */
  function _chargeAccruedPlatformFees() internal {
    uint256 currentTime = _getChainTimestampMs();
    uint256 timeSinceLastCharge = currentTime - platformFee.lastChargedAt;

    if (timeSinceLastCharge == 0) return;

    uint256 totalShares = totalSupply();
    if (totalShares == 0) {
      platformFee.lastChargedAt = currentTime;
      return;
    }

    uint256 currentTotalAssets = totalAssets();
    uint256 feePercentage = platformFee.platformFeePercentage;

    uint256 accruedFee = (currentTotalAssets * feePercentage * timeSinceLastCharge) /
      FEE_DENOMINATOR;

    if (accruedFee > 0) {
      platformFee.accrued += accruedFee;
      
      unchecked {
        sequenceNumber++;
      }

      emit VaultPlatformFeeCharged(
        address(this),
        accruedFee,
        platformFee.accrued,
        currentTime,
        sequenceNumber
      );
    }

    platformFee.lastChargedAt = currentTime;
  }

  // ============================================
  // ERC4626 Overrides
  // ============================================

  /**
   * @notice Get total assets (uses rate-based calculation like EmberVault)
   */
  function totalAssets() public view virtual override returns (uint256) {
    uint256 shares = totalSupply();
    if (shares == 0) {
      return 0;
    }
    return convertToAssets(shares);
  }

  /**
   * @notice Internal conversion from assets to shares using rate-based conversion
   * @dev Overrides ERC4626 pool-based conversion with custom rate-based formula
   */
  function _convertToShares(
    uint256 assets,
    Math.Rounding /* rounding */
  ) internal view virtual override returns (uint256) {
    uint256 rateValue = rate.value;
    if (rateValue == 0) {
      return 0;
    }
    return FixedPointMath.mul(assets, rateValue);
  }

  /**
   * @notice Internal conversion from shares to assets using rate-based conversion
   * @dev Overrides ERC4626 pool-based conversion with custom rate-based formula
   */
  function _convertToAssets(
    uint256 shares,
    Math.Rounding rounding
  ) internal view virtual override returns (uint256) {
    uint256 rateValue = rate.value;
    if (rateValue == 0 || shares == 0) {
      return 0;
    }

    if (rounding == Math.Rounding.Ceil) {
      return FixedPointMath.divCeil(shares, rateValue);
    } else {
      return FixedPointMath.div(shares, rateValue);
    }
  }

  /**
   * @notice Standard ERC-4626 withdraw is disabled
   */
  function withdraw(uint256, address, address) public virtual override returns (uint256) {
    revert UseRedeemShares();
  }

  /**
   * @notice Standard ERC-4626 redeem is disabled
   */
  function redeem(uint256, address, address) public virtual override returns (uint256) {
    revert UseRedeemShares();
  }

  // ============================================
  // View Functions
  // ============================================

  /**
   * @notice Get vault name
   */
  function vaultName() external view returns (string memory) {
    return _vaultName;
  }

  /**
   * @notice Get vault version
   */
  function version() external pure virtual returns (string memory) {
    return "v1.0.0-eth";
  }

  /**
   * @notice Get withdrawal request by index
   */
  function getWithdrawalRequest(uint256 index) external view returns (WithdrawalRequest memory) {
    if (index >= pendingWithdrawals.length) revert IndexOutOfBounds();
    return pendingWithdrawals[index];
  }

  /**
   * @notice Get number of pending withdrawal requests
   */
  function getPendingWithdrawalsLength() external view returns (uint256) {
    uint256 queueLength = pendingWithdrawals.length;
    uint256 startIndex = withdrawalQueueStartIndex;
    if (queueLength <= startIndex) return 0;
    return queueLength - startIndex;
  }

  /**
   * @notice Get withdrawal queue start index
   */
  function getWithdrawalQueueStartIndex() external view returns (uint256) {
    return withdrawalQueueStartIndex;
  }

  /**
   * @notice Get account info
   */
  function getAccountInfo(address account) external view returns (
    uint256 totalPendingShares,
    uint256[] memory pendingRequestIds,
    uint256[] memory cancelledRequestIds
  ) {
    Account storage accountState = accounts[account];
    return (
      accountState.totalPendingWithdrawalShares,
      accountState.pendingWithdrawalRequestSequenceNumbers,
      accountState.cancelWithdrawRequestSequenceNumbers
    );
  }

  /**
   * @notice Check if account is a sub-account
   */
  function isSubAccount(address account) external view returns (bool) {
    return subAccounts[account];
  }

  // ============================================
  // Internal Functions
  // ============================================

  /**
   * @notice Get current chain timestamp in milliseconds
   */
  function _getChainTimestampMs() internal view returns (uint256) {
    return block.timestamp * 1000;
  }

  /**
   * @notice Verify an address is a WETH contract (symbol = "WETH" and implements IWETH)
   */
  function _isWETH(address token) internal returns (bool) {
    try IERC20Metadata(token).symbol() returns (string memory symbol) {
      if (keccak256(bytes(symbol)) == WETH_SYMBOL_HASH) {
        try IWETH(token).withdraw(0) { return true; } catch {}
      }
    } catch {}
    return false;
  }

  /**
   * @notice Authorize upgrade (owner only)
   */
  function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

  /**
   * @dev Reserved storage gap for future upgrades
   */
  uint256[50] private __gap;
}
