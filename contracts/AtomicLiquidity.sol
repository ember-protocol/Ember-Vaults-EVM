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
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "./interfaces/IEmberProtocolConfig.sol";
import "./interfaces/IEmberVaultValidator.sol";
import "./libraries/Math.sol"; // FixedPointMath library
import "./libraries/AtomicLiquidityLib.sol";
import "./libraries/VaultPlatformFeeLib.sol";
import "./libraries/WithdrawalQueueLib.sol";

// Custom errors. The lib-shared ones (also declared inside AtomicLiquidityLib) are
// duplicated *inside* the contract scope below so the contract's ABI carries them — this
// is what `revertedWithCustomError(vault, "X")` tests look up. Selectors match across
// declarations because Solidity errors are keyed by signature.
error OperationPaused();
error InsufficientShares();
error InvalidRequest();
error MaxTVLReached();
error IndexOutOfBounds();
error StrategyNotSet();
error InvalidStrategy();
error InstantWithdrawCapExceeded();
error InstantWithdrawFeeTooHigh();
error EmberShareNotWhitelisted();

/**
 * @title AtomicLiquidity
 * @notice Vault that mirrors EmberVault's request-based redemption and rate-based pricing,
 *         but issues no receipt/share token. User shares are tracked in an internal mapping.
 *         Deposited assets can be supplied to an external ERC-4626 strategy (e.g. a MetaMorpho
 *         vault on Morpho) by the operator, and withdrawn back on demand.
 */
contract AtomicLiquidity is
  Initializable,
  UUPSUpgradeable,
  OwnableUpgradeable,
  ReentrancyGuardUpgradeable
{
  using SafeERC20 for IERC20;

  // ============ Structs ============

  // PlatformFee is defined in AtomicLiquidityLib so the library can take `storage`
  // references against the same layout — see `chargeAccruedPlatformFees`.

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

  // Account struct lives in WithdrawalQueueLib (shared withdrawal-queue bookkeeping).

  struct VaultInitParams {
    string name;
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

  // EmberShareConfig and HoldbackEntry are defined in AtomicLiquidityLib so the library
  // can take `storage` references against the same layout.

  // ============ Constants ============

  // FEE_DENOMINATOR moved to AtomicLiquidityLib — only the lib's chargeAccruedPlatformFees
  // uses it now.

  bytes32 private constant DEPOSITS_HASH = keccak256("deposits");
  bytes32 private constant WITHDRAWALS_HASH = keccak256("withdrawals");
  bytes32 private constant PRIVILEGED_OPS_HASH = keccak256("privilegedOperations");

  /// @notice Length of the fixed (tumbling) 24h window over which an EmberShare's per-share
  ///         instant-swap capacity is metered. The window is anchored to the first swap of an
  ///         epoch and resets wholesale once it elapses — it is NOT a sliding/rolling window.
  ///         Consequence: usage near the end of one window and the start of the next is not
  ///         aggregated, so up to ~2x the cap can be consumed across a window boundary in a
  ///         short span. This is accepted: the cap is a coarse anti-drain/concentration
  ///         throttle, not a hard short-term liquidity guarantee.
  uint256 public constant EMBER_SHARE_EPOCH_DURATION = 24 hours;

  /// @notice Sentinel for "100%" in 1e18 fixed-point. Used as a cap on percentage inputs.
  uint256 private constant PERCENT_MAX = 1e18;

  // ============ Storage ============

  string private _vaultName;

  /// @notice Underlying collateral token (ERC-20)
  address public collateralToken;

  /// @notice External ERC-4626 strategy (e.g. a MetaMorpho vault). May be unset (address(0)).
  IERC4626 public strategy;

  uint256 public maxTVL;

  uint256 public minWithdrawableShares;

  /// @notice Total user share supply (excludes nothing — pending-burn shares are still in totalShares
  ///         until the request is finalized, mirroring EmberVault.totalSupply semantics)
  uint256 public totalShares;

  /// @notice Per-user share balance. Shares are non-transferable.
  mapping(address => uint256) public shareOf;

  /// @notice Shares parked by redeemShares() awaiting processing. Mirrors EmberVault's
  ///         balanceOf(address(this)). Returned to user on skip; deducted from totalShares on burn.
  uint256 public pendingBurnShares;

  mapping(address => bool) public subAccounts;

  VaultPlatformFeeLib.PlatformFee public platformFee;
  Rate public rate;
  Roles public roles;

  IEmberProtocolConfig public protocolConfig;

  PauseStatus public pauseStatus;

  uint256 public sequenceNumber;

  WithdrawalRequest[] public pendingWithdrawals;
  uint256 private withdrawalQueueStartIndex;

  mapping(address => WithdrawalQueueLib.Account) public accounts;

  IEmberVaultValidator public vaultValidator;

  /// @notice Cumulative cap (in shares) on instantWithdraw redemptions over the vault's lifetime.
  ///         Initialized to 0 (no instant withdrawals). Admin raises this to grant additional
  ///         capacity. Headroom = max - cumulative (clamped at 0).
  uint256 public maxInstantWithdrawShares;

  /// @notice Running total of shares ever burned via instantWithdraw. Monotonically increasing.
  ///         When this hits maxInstantWithdrawShares, instantWithdraw reverts until admin
  ///         raises the cap.
  uint256 public cumulativeInstantWithdrawShares;

  /// @notice Fee charged on instant withdrawals, in 1e18 fixed-point (1e18 = 100%).
  ///         The fee is deducted from the gross asset payout and accrued into platformFee.accrued
  ///         so it is collected via the same collectPlatformFee() flow as time-based fees.
  uint256 public instantWithdrawFeePercentage;

  /// @notice Per-EmberVault-share configuration for the cross-vault instant-swap feature.
  ///         Keyed by the EmberVault contract address (which IS the receipt-token address,
  ///         since EmberVault is itself ERC-4626/ERC-20).
  mapping(address => AtomicLiquidityLib.EmberShareConfig) public emberShareConfigs;

  /// @notice Per-share FIFO queue of holdback entries created by swapEmberShares. Read via
  ///         the `getHoldbackEntry(share, index)` helper.
  mapping(address => AtomicLiquidityLib.HoldbackEntry[]) internal _holdbackQueues;

  /// @notice Per-share FIFO start index for the holdback queue. Advances when a contiguous
  ///         block of head entries reaches `released == amount`.
  mapping(address => uint256) public holdbackQueueStartIndex;

  /// @notice Addresses exempt from the EmberShare-swap fee. When `feeWaivedAddresses[user]`
  ///         is true, swapEmberShares charges 0 fee for that share-owner regardless of the
  ///         per-share `feePercentage`.
  mapping(address => bool) public feeWaivedAddresses;

  /// @notice Addresses exempt from the EmberShare-swap holdback. When true, swapEmberShares
  ///         pays the user the full holdback portion immediately and skips queueing a
  ///         HoldbackEntry. Independent of `feeWaivedAddresses` — exempting a user from one
  ///         does not exempt them from the other.
  mapping(address => bool) public holdbackWaivedAddresses;

  /// @notice Sticky flag, set true the first time `redeemCollectedEmberShares` fires.
  ///         Never cleared. Cheap negative cache used by the swap utilization view: while
  ///         false, no source vault can have pending withdrawal requests attributed to
  ///         this vault, so the cross-contract `source.accounts(this)` read can be
  ///         skipped (~2,100 gas saved per swap).
  bool public hasActiveRedemptionHistory;

  /// @notice Collateral owed to a recipient whose holdback payout could not be delivered
  ///         during `releaseUsersHoldback` (e.g. a blocklisted address). Escrowed here so a
  ///         single unpayable recipient can't wedge the FIFO release queue; claimed via
  ///         `claimHoldback` / `claimHoldbackFor`.
  mapping(address => uint256) public unclaimedHoldback;

  /// @dev Reserved storage gap for future upgrades. Decremented by 1 when `unclaimedHoldback`
  ///      was added so the post-`__gap` layout is unchanged.
  uint256[39] private __gap;

  // ============ Events ============

  event VaultCreated(
    address indexed vault,
    string name,
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

  event VaultMaxRateChangePerUpdateChanged(
    address indexed vault,
    uint256 previousMaxRateChangePerUpdate,
    uint256 newMaxRateChangePerUpdate,
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
    /// @dev Net collateral actually transferred to `recipient` (= accrued - lossAbsorbed).
    uint256 amount,
    /// @dev Portion of accrued fees netted against a vault-side shortfall instead of being
    ///      transferred out. `amount + lossAbsorbed == accruedBeforeCall`.
    uint256 lossAbsorbed,
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

  event VaultSupplyToSubAccount(
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

  event WithdrawalFeeCharged(
    address indexed vault,
    address indexed owner,
    uint256 requestSequenceNumber,
    uint256 permanentFeeCharged,
    uint256 timeBasedFeeCharged
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
    uint256 sequenceNumber
  );

  event StrategyUpdated(
    address indexed vault,
    address indexed previousStrategy,
    address indexed newStrategy,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event StrategySupplied(
    address indexed vault,
    address indexed strategy,
    uint256 assetsSupplied,
    uint256 strategySharesReceived,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event StrategyWithdrawn(
    address indexed vault,
    address indexed strategy,
    uint256 assetsWithdrawn,
    uint256 strategySharesBurned,
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

  event InstantWithdrawLimitUpdated(
    address indexed vault,
    uint256 previousMax,
    uint256 newMax,
    uint256 cumulativeInstantWithdrawShares,
    uint256 timestamp,
    uint256 sequenceNumber
  );

  event InstantWithdrawFeeUpdated(
    address indexed vault,
    uint256 previousFeePercentage,
    uint256 newFeePercentage,
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

  event EmberShareFeeMultiplierTierUpdated(
    address indexed vault,
    address indexed share,
    uint256 threshold,
    uint256 multiplier,
    bool removed,
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

  // ============ Library-emitted events / errors (re-declared for ABI exposure) ============
  // The functions swapEmberShares, releaseUsersHoldback, redeemCollectedEmberShares delegate
  // to AtomicLiquidityLib. DELEGATECALL keeps `address(this)` as the proxy on emitted events,
  // and selectors match across declarations — so re-declaring here lets tests and indexers
  // find them on the AtomicLiquidity ABI directly.

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
    uint256 utilizationAtSwap,
    uint256 feeMultiplierApplied,
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

  event HoldbackTransferDeferred(
    address indexed vault,
    address indexed share,
    address recipient,
    uint256 index,
    uint256 amount,
    // Swap sequence number of the deferred holdback entry (== the EmberShareSwapped
    // sequenceNumber that created it) — stable key for linking the deferral to its swap.
    uint256 swapSequenceNumber,
    uint256 timestamp,
    // Vault sequence number of the releaseUsersHoldback batch that deferred this entry.
    uint256 sequenceNumber
  );

  /// @notice Emitted when an escrowed (previously undeliverable) holdback payout is delivered.
  ///         Settles the recipient's aggregate `unclaimedHoldback` balance (which may span
  ///         multiple deferred entries). `to` is where the collateral actually went: the original
  ///         `recipient` for a normal claim, or a different address for a recipient-redirect
  ///         ({claimHoldbackTo}) or an owner rescue ({recoverUnclaimedHoldback}).
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

  error InsufficientBalance();
  error ZeroAmount();
  error EmberShareCapExceeded();
  error InvalidPercentage();
  error EmptyHoldbackQueue();
  error EmberShareUtilizationCapExceeded();
  error InvalidFeeMultiplier();
  /// @dev A-9: surfaced on the vault ABI so callers can catch the swap's minNetOut guard
  ///      (the revert originates in AtomicLiquidityLib via delegatecall).
  error SlippageToleranceExceeded();
  error TierNotFound();
  error SwapAmountTooSmall();
  error EmberShareHeldValueCapExceeded();

  // ============ Modifiers ============

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
      params.rateUpdateInterval > configProxy.getMaxRateInterval()
    ) revert InvalidInterval();

    if (params.maxRateChangePerUpdate == 0) revert InvalidRate();

    if (params.feePercentage > configProxy.getMaxAllowedFeePercentage()) revert InvalidValue();

    __Ownable_init(initialOwner);
    __UUPSUpgradeable_init();
    __ReentrancyGuard_init();

    protocolConfig = configProxy;

    if (bytes(params.name).length == 0) revert InvalidValue();
    if (params.minWithdrawableShares == 0) revert ZeroAmount();
    if (params.maxTVL == 0) revert ZeroAmount();

    _vaultName = params.name;
    collateralToken = params.collateralToken;
    maxTVL = params.maxTVL;
    minWithdrawableShares = params.minWithdrawableShares;

    uint256 currentTime = _getChainTimestampMs();

    platformFee = VaultPlatformFeeLib.PlatformFee({
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

    sequenceNumber = 0;

    emit VaultCreated(
      address(this),
      params.name,
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

  function setFeePercentage(
    address caller,
    uint256 newFeePercentage
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    // Settle accrued fees at the OLD percentage before mutating, so prior elapsed time
    // is not retroactively re-priced at the new rate.
    _chargeAccruedPlatformFees();

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

  /// @dev Authorization is enforced upstream by `EmberProtocolConfig.setVaultPausedStatus`
  ///      which is `onlyGuardian` — guardian holds the emergency-pause authority across
  ///      all vaults registered with the protocol-config. The `caller` parameter is kept
  ///      for ABI compatibility with `IEmberVault.setPausedStatus` (so the same forwarder
  ///      can dispatch to both vault types) but intentionally unused here.
  function setPausedStatus(
    address /* caller */,
    string calldata operation,
    bool paused
  ) external nonReentrant onlyProtocolConfig {
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

  function setVaultValidator(
    address caller,
    address _validator
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    vaultValidator = IEmberVaultValidator(_validator);
  }

  /// @notice Sets (or clears) the external ERC-4626 strategy.
  /// @dev Only callable by protocol config, caller must be admin.
  ///      The strategy must use the same underlying asset. Pass address(0) to clear.
  ///      Before re-pointing, the setter automatically drains the FULL residual position from
  ///      the previous strategy back into the vault (it would otherwise be orphaned — no
  ///      on-chain helper reads it once `strategy` has changed). This reverts if the old
  ///      strategy cannot service the full withdrawal at call time.
  /// @param caller The original caller address (must be admin)
  /// @param newStrategy The new ERC-4626 strategy address (zero to disable)
  function setStrategy(
    address caller,
    address newStrategy
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    address previousStrategy = address(strategy);
    if (previousStrategy == newStrategy) revert SameValue();

    if (newStrategy != address(0)) {
      if (IERC4626(newStrategy).asset() != collateralToken) revert InvalidStrategy();
    }

    // Drain any residual position in the previous strategy before swapping the
    // pointer. Without this, leftover shares are orphaned — no on-chain helper
    // reads them back once `strategy` has been re-pointed.
    if (previousStrategy != address(0)) {
      IERC4626 prev = IERC4626(previousStrategy);
      uint256 prevShares = prev.balanceOf(address(this));
      if (prevShares > 0) {
        uint256 prevAssets = prev.convertToAssets(prevShares);
        if (prevAssets > 0) {
          prev.withdraw(prevAssets, address(this), address(this));
        }
      }
    }

    strategy = IERC4626(newStrategy);
    _incrementSequence();

    emit StrategyUpdated(
      address(this),
      previousStrategy,
      newStrategy,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Sets the cumulative cap (in shares) for instantWithdraw redemptions.
  /// @dev Only callable by protocol config, caller must be admin.
  ///      Headroom for new instant withdrawals is `newMax - cumulativeInstantWithdrawShares`
  ///      (clamped at 0). Set below the current cumulative to halt instant withdrawals
  ///      until further notice; set above to grant new capacity.
  /// @param caller The original caller address (must be admin)
  /// @param newMax The new cumulative cap, in shares
  function setMaxInstantWithdrawShares(
    address caller,
    uint256 newMax
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    uint256 previousMax = maxInstantWithdrawShares;
    if (previousMax == newMax) revert SameValue();

    maxInstantWithdrawShares = newMax;
    _incrementSequence();

    emit InstantWithdrawLimitUpdated(
      address(this),
      previousMax,
      newMax,
      cumulativeInstantWithdrawShares,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Sets the fee percentage charged on instant withdrawals.
  /// @dev Only callable by protocol config, caller must be admin.
  ///      Fee is in 1e18 fixed-point (1e18 = 100%). L-5: must be strictly < 1e18 so an
  ///      instant withdraw can't burn shares for a zero payout.
  /// @param caller The original caller address (must be admin)
  /// @param newFeePercentage The new instant-withdraw fee, in 1e18 fixed-point
  function setInstantWithdrawFeePercentage(
    address caller,
    uint256 newFeePercentage
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    if (newFeePercentage >= 1e18) revert InstantWithdrawFeeTooHigh();

    uint256 previousFeePercentage = instantWithdrawFeePercentage;
    if (previousFeePercentage == newFeePercentage) revert SameValue();

    instantWithdrawFeePercentage = newFeePercentage;
    _incrementSequence();

    emit InstantWithdrawFeeUpdated(
      address(this),
      previousFeePercentage,
      newFeePercentage,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Whitelists (or de-lists) an EmberVault share for the cross-vault instant-swap.
  /// @dev Only callable by protocol config, caller must be admin. When `whitelisted` is false
  ///      the percentage params are ignored; the config is cleared except for any in-flight
  ///      epoch state, so a previously-locked share remains locked until its window expires.
  ///      Note: this does NOT affect existing holdback queue entries — those are paid out via
  ///      `releaseUsersHoldback` regardless of whitelist status. The fee-multiplier curve
  ///      (configured via `updateEmberShareFeeMultiplierTier`) is also preserved across
  ///      whitelist updates.
  /// @param caller The original caller address (must be admin)
  /// @param share The EmberVault share-token address to configure
  /// @param whitelisted Whether the share is permitted for instant swap
  /// @param feePercentage Base fee on the gross asset value (1e18 = 100%); the curve scales this
  /// @param maxCapacityPercentage Cap per fixed 24h epoch as a fraction of share.totalAssets() (1e18 = 100%)
  /// @param holdbackPercentage Portion of gross retained until batch release (1e18 = 100%)
  /// @param maxUtilizationPercentage Concentration cap: maximum fraction of AL's TVL the held
  ///        value of this source share can occupy (1e18 = 100%)
  /// @param minSwapGross Minimum gross collateral value a single swap must produce (in collateral
  ///        units). Dust floor that blocks sub-unit swaps which round the fee to 0 yet still queue
  ///        a near-zero holdback entry — preventing holdback-queue bloat and partial-release DoS.
  ///        Pass 0 to disable the floor.
  /// @param maxHeldValueAbsolute Absolute ceiling (in collateral units) on the post-swap held value
  ///        of this source share. TVL-independent, so it can't be gamed by transiently inflating
  ///        totalAssets() (deposit → swap → withdraw) to slip past maxUtilizationPercentage.
  ///        Pass 0 to disable the absolute cap.
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
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    _incrementSequence();
    AtomicLiquidityLib.setEmberShareWhitelist(
      AtomicLiquidityLib.WhitelistArgs({
        share: share,
        whitelisted: whitelisted,
        feePercentage: feePercentage,
        maxCapacityPercentage: maxCapacityPercentage,
        holdbackPercentage: holdbackPercentage,
        maxUtilizationPercentage: maxUtilizationPercentage,
        minSwapGross: minSwapGross,
        maxHeldValueAbsolute: maxHeldValueAbsolute,
        collateralToken: collateralToken,
        sequenceNumber: sequenceNumber,
        timestamp: _getChainTimestampMs()
      }),
      emberShareConfigs[share]
    );
  }

  /// @notice Upserts or removes a tier on an EmberShare's fee-multiplier curve. Admin via
  ///         protocol-config. With `remove = false`, inserts (or updates) a tier at the
  ///         given `threshold` with the given `multiplier` (must be ≥ 1e18 i.e. ≥ 1×).
  ///         With `remove = true`, deletes the tier at `threshold` (must exist); the
  ///         `multiplier` argument is ignored.
  /// @param caller The original caller address (must be admin)
  /// @param share The configured EmberVault share-token address
  /// @param threshold Utilization threshold in 1e18 fixed-point (≤ 1e18)
  /// @param multiplier Fee multiplier in 1e18 fixed-point (≥ 1e18 on insert)
  /// @param remove If true, remove the tier at `threshold`; ignores `multiplier`
  function updateEmberShareFeeMultiplierTier(
    address caller,
    address share,
    uint256 threshold,
    uint256 multiplier,
    bool remove
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    _incrementSequence();
    AtomicLiquidityLib.updateEmberShareFeeMultiplierTier(
      share,
      threshold,
      multiplier,
      remove,
      sequenceNumber,
      _getChainTimestampMs(),
      emberShareConfigs[share]
    );
  }

  // Utilization and curve introspection are intentionally NOT exposed via on-chain views — off-chain
  // consumers can reconstruct the curve from `EmberShareFeeMultiplierTierUpdated` event
  // logs. Keeping these out saves ~300 bytes of implementation bytecode under the
  // EIP-170 24,576-byte ceiling.

  /// @notice Sets per-address fee and holdback waivers for the EmberShare cross-vault swap.
  /// @dev Only callable by protocol config, caller must be admin. Waivers are independent —
  ///      an address can be on neither list, one of them, or both. The waiver applies based
  ///      on the share-OWNER (msg.sender of swapEmberShares), not the receiver. Setting both
  ///      flags to false removes the address from both lists.
  /// @param caller The original caller address (must be admin)
  /// @param account The address whose waiver flags are being set
  /// @param feeWaived True to charge zero fee on this account's swaps
  /// @param holdbackWaived True to skip queueing a holdback and pay the full gross immediately
  function setSwapWaiver(
    address caller,
    address account,
    bool feeWaived,
    bool holdbackWaived
  ) external nonReentrant onlyProtocolConfig onlyAdmin(caller) {
    _incrementSequence();
    AtomicLiquidityLib.setSwapWaiver(
      account,
      feeWaived,
      holdbackWaived,
      sequenceNumber,
      _getChainTimestampMs(),
      feeWaivedAddresses,
      holdbackWaivedAddresses
    );
  }

  // ============================================
  // Rate / Fee Operations
  // ============================================

  function updateVaultRate(uint256 newRate) external nonReentrant onlyRateManager {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    _chargeAccruedPlatformFees();

    uint256 currentTime = _getChainTimestampMs();
    uint256 lastUpdatedAt = rate.lastUpdatedAt;

    if (currentTime < lastUpdatedAt + rate.rateUpdateInterval) revert InvalidInterval();

    if (newRate < configProxy.getMinRate() || newRate > configProxy.getMaxRate())
      revert InvalidRate();

    uint256 percentChange = FixedPointMath.percentChangeFrom(rate.value, newRate);
    if (percentChange > rate.maxRateChangePerUpdate) revert InvalidRate();

    if (newRate == rate.value) revert SameValue();

    uint256 previousRate = rate.value;

    rate.value = newRate;
    rate.lastUpdatedAt = currentTime;

    _incrementSequence();
    emit VaultRateUpdated(address(this), previousRate, newRate, currentTime, sequenceNumber);
  }

  /// @notice Settles accrued fees and forwards `accrued − loss` to the protocol fee recipient.
  /// @dev Operator-only. `loss` lets the operator net an off-vault shortfall (e.g. a strategy
  ///      loss the vault has already booked into its receipt-token / position holdings) against
  ///      unclaimed platform fees BEFORE the transfer. The full accrued amount is settled to
  ///      zero; only `accrued − loss` actually leaves the vault. Pass `loss = 0` for the
  ///      ordinary path (transfer everything).
  /// @param loss Portion of accrued fees to absorb against a shortfall instead of transferring.
  ///        Must be ≤ accrued (else reverts with `InvalidValue`).
  /// @return amount The net collateral transferred to the platform-fee recipient.
  function collectPlatformFee(
    uint256 loss
  ) external nonReentrant onlyOperator returns (uint256 amount) {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    _chargeAccruedPlatformFees();

    uint256 accrued = platformFee.accrued;
    if (accrued == 0) revert ZeroAmount();
    if (loss > accrued) revert InvalidValue();

    amount = accrued - loss;

    address recipient = configProxy.getPlatformFeeRecipient();
    if (recipient == address(0)) revert ZeroAddress();

    // Zero out the accrued bucket first — both the transferred portion AND the loss-absorbed
    // portion are settled by this call. The `loss` USDC stays in vault.balance and benefits
    // remaining shareholders.
    platformFee.accrued = 0;

    if (amount > 0) {
      // Auto-pull from strategy if idle balance is short, consistent with other outflow paths.
      AtomicLiquidityLib.ensureLiquidity(collateralToken, address(strategy), amount);
      IERC20(collateralToken).safeTransfer(recipient, amount);
    }

    _incrementSequence();
    emit VaultPlatformFeeCollected(
      address(this),
      recipient,
      amount,
      loss,
      _getChainTimestampMs(),
      sequenceNumber
    );

    return amount;
  }

  // ============================================
  // Strategy Operations (Operator)
  // ============================================

  /// @notice Supplies idle vault funds into the configured strategy.
  /// @dev Operator-only. Reverts if no strategy is set or privileged operations are paused.
  ///      Uses ERC-4626 deposit on the strategy.
  /// @param assets The amount of underlying collateral to supply.
  /// @return strategyShares The number of strategy shares minted to this vault.
  function supplyToStrategy(
    uint256 assets
  ) external nonReentrant onlyOperator returns (uint256 strategyShares) {
    IEmberProtocolConfig configProxy = protocolConfig;
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    if (assets == 0) revert ZeroAmount();

    IERC4626 _strategy = strategy;
    if (address(_strategy) == address(0)) revert StrategyNotSet();

    IERC20 token = IERC20(collateralToken);
    if (token.balanceOf(address(this)) < assets) revert InsufficientBalance();

    // forceApprove sets allowance to exactly `assets`, avoiding USDT-style residual-approval issues.
    token.forceApprove(address(_strategy), assets);
    strategyShares = _strategy.deposit(assets, address(this));

    _incrementSequence();

    emit StrategySupplied(
      address(this),
      address(_strategy),
      assets,
      strategyShares,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  /// @notice Pulls underlying collateral back from the strategy into this vault.
  /// @dev Operator-only. Uses ERC-4626 withdraw to receive an exact asset amount.
  /// @param assets The amount of underlying collateral to withdraw.
  /// @return strategyShares The number of strategy shares burned to satisfy the withdrawal.
  function withdrawFromStrategy(
    uint256 assets
  ) external nonReentrant onlyOperator returns (uint256 strategyShares) {
    IEmberProtocolConfig configProxy = protocolConfig;
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    if (assets == 0) revert ZeroAmount();

    IERC4626 _strategy = strategy;
    if (address(_strategy) == address(0)) revert StrategyNotSet();

    strategyShares = _strategy.withdraw(assets, address(this), address(this));

    _incrementSequence();

    emit StrategyWithdrawn(
      address(this),
      address(_strategy),
      assets,
      strategyShares,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  // ============================================
  // Deposit
  // ============================================

  /// @notice Deposits assets and credits internal shares to receiver.
  /// @param assets Amount of assets to deposit
  /// @param receiver Address to receive the shares
  /// @return shares Amount of shares credited
  function deposit(
    uint256 assets,
    address receiver
  ) external nonReentrant returns (uint256 shares) {
    return _deposit(assets, receiver, msg.sender);
  }

  // ============================================
  // Redeem (Request-Based)
  // ============================================

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
    // Reject a null receiver: such a request would be queued, then revert at processing time
    // on safeTransfer(address(0)), freezing the FIFO withdrawal queue at the head. Matches
    // swapEmberShares' guard.
    if (receiver == address(0)) revert ZeroAddress();

    if (shares < minWithdrawableShares) revert InsufficientShares();

    uint256 ownerShares = shareOf[shareOwner];
    if (ownerShares < shares) revert InsufficientShares();

    unchecked {
      shareOf[shareOwner] = ownerShares - shares;
      pendingBurnShares += shares;
    }

    uint256 estimatedWithdrawAmount = convertToAssets(shares);

    _incrementSequence();

    uint256 currentTime = _getChainTimestampMs();

    request = WithdrawalRequest({
      owner: shareOwner,
      receiver: receiver,
      shares: shares,
      estimatedWithdrawAmount: estimatedWithdrawAmount,
      timestamp: currentTime,
      sequenceNumber: sequenceNumber
    });

    pendingWithdrawals.push(request);

    WithdrawalQueueLib.updateAccountState(
      accounts,
      request.owner,
      request.shares,
      request.sequenceNumber,
      true,
      type(uint256).max
    );

    emit RequestRedeemed(
      address(this),
      request.owner,
      request.receiver,
      request.shares,
      request.timestamp,
      totalShares,
      pendingBurnShares,
      sequenceNumber
    );

    return request;
  }

  function cancelPendingWithdrawalRequest(uint256 requestSequenceNumber) external nonReentrant {
    if (protocolConfig.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.withdrawals) revert OperationPaused();

    // Validation, cancel-list append, and the RequestCancelled emit are hoisted into
    // WithdrawalQueueLib (DELEGATECALL) to keep this implementation under EIP-170.
    WithdrawalQueueLib.cancel(accounts, msg.sender, requestSequenceNumber, _getChainTimestampMs());
  }

  /// @notice Burns the caller's shares immediately and pays out underlying collateral
  ///         minus a fee, subject to a cumulative cap (`maxInstantWithdrawShares`).
  /// @dev If the vault's idle balance is insufficient to cover the net payout, the
  ///      vault auto-pulls the deficit from the configured ERC-4626 strategy. The
  ///      withdrawal fee is added to `platformFee.accrued`, so it is collected via the
  ///      same `collectPlatformFee()` flow as time-based fees.
  /// @param shares The number of shares to burn
  /// @param receiver The address to receive the net underlying assets
  /// @return netAmount The underlying assets transferred to receiver (gross minus fee)
  function instantWithdraw(
    uint256 shares,
    address receiver
  ) external nonReentrant returns (uint256 netAmount) {
    // Cumulative cap check kept in the contract so `InstantWithdrawCapExceeded` stays in the
    // vault ABI (the library re-validates, but this is the user-facing revert surface). The
    // library performs all remaining validation, the burn, payout, fee accrual, and event.
    if (cumulativeInstantWithdrawShares + shares > maxInstantWithdrawShares)
      revert InstantWithdrawCapExceeded();

    // Settle accrued time-based platform fees against the OLD totalShares before the burn,
    // so prior elapsed time is not re-priced against a smaller TVL. (A later revert inside
    // the library rolls this back with the rest of the call.)
    _chargeAccruedPlatformFees();
    _incrementSequence();

    uint256 newCumulative;
    uint256 newTotalShares;
    (netAmount, newCumulative, newTotalShares) = AtomicLiquidityLib.instantWithdraw(
      AtomicLiquidityLib.InstantWithdrawArgs({
        configProxy: address(protocolConfig),
        withdrawalsPaused: pauseStatus.withdrawals,
        shareOwner: msg.sender,
        receiver: receiver,
        shares: shares,
        grossAmount: convertToAssets(shares),
        minWithdrawableShares: minWithdrawableShares,
        maxInstantWithdrawShares: maxInstantWithdrawShares,
        instantWithdrawFeePercentage: instantWithdrawFeePercentage,
        cumulativeBefore: cumulativeInstantWithdrawShares,
        totalSharesBefore: totalShares,
        collateralToken: collateralToken,
        strategy: address(strategy),
        timestamp: _getChainTimestampMs(),
        sequenceNumber: sequenceNumber
      }),
      shareOf,
      platformFee
    );

    cumulativeInstantWithdrawShares = newCumulative;
    totalShares = newTotalShares;
  }

  // ============================================
  // Cross-Vault EmberShare Instant Swap
  // ============================================

  /// @notice Atomically swaps an EmberVault share-token holding for underlying collateral.
  /// @dev Caller transfers `shareAmount` of EmberVault receipt tokens to this contract; in
  ///      exchange this contract pays out `gross − fee − holdback` of collateral immediately
  ///      to `receiver`. The holdback is queued FIFO and released later via
  ///      `releaseUsersHoldback`. The fee accrues to `platformFee.accrued`.
  ///
  ///      Internally this contract calls `EmberVault(share).redeemShares(...)` so the EmberVault
  ///      eventually settles us in collateral via its normal queue. This contract must therefore
  ///      not be blacklisted on the EmberVault, and `shareAmount` must satisfy the EmberVault's
  ///      `minWithdrawableShares`.
  ///
  ///      Capacity is metered per fixed (tumbling) 24h epoch as `share.totalAssets() * maxCapPct / 1e18`.
  ///      A redemption that would push past the cap reverts; the epoch resets wholesale the first
  ///      time someone calls after the 24h window (anchored to the epoch's first swap) has elapsed.
  ///      Because the window is fixed rather than sliding, usage straddling a boundary is not
  ///      aggregated — up to ~2x the cap can be consumed across the reset (accepted; the cap is a
  ///      coarse throttle, not a hard short-term limit).
  /// @param share The EmberVault address whose receipt tokens are being swapped
  /// @param shareAmount The number of EmberVault shares to swap
  /// @param receiver The address that receives the immediate net payout and (later) the holdback
  /// @param minNetOut A-9: minimum immediate collateral payout the caller accepts; reverts
  ///        `SlippageToleranceExceeded` if the net payout is below it. Pass 0 to disable.
  /// @return netAmount The collateral transferred to `receiver` immediately
  function swapEmberShares(
    address share,
    uint256 shareAmount,
    address receiver,
    uint256 minNetOut
  ) external nonReentrant returns (uint256 netAmount) {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.withdrawals) revert OperationPaused();

    address shareOwner = msg.sender;
    if (configProxy.isAccountBlacklisted(shareOwner)) revert Blacklisted();
    if (configProxy.isAccountBlacklisted(receiver)) revert Blacklisted();
    if (receiver == address(0)) revert ZeroAddress();
    if (shareAmount == 0) revert ZeroAmount();
    if (!emberShareConfigs[share].whitelisted) revert EmberShareNotWhitelisted();

    // Settle accrued time-based fees BEFORE this swap adds its fee to platformFee.accrued.
    // The time-based fee base is `totalAssets() - accrued` (accrued is netted out of TVL),
    // so booking the swap fee first would retroactively shrink the fee base for the whole
    // elapsed period since lastChargedAt — under-charging the platform. Charging here
    // checkpoints lastChargedAt to now, so the swap fee only nets out going forward.
    // Mirrors instantWithdraw and the other fee-mutating paths.
    _chargeAccruedPlatformFees();

    _incrementSequence();

    uint256 feeAmount;
    (netAmount, feeAmount) = AtomicLiquidityLib.swapEmberShares(
      AtomicLiquidityLib.SwapArgs({
        share: share,
        shareAmount: shareAmount,
        receiver: receiver,
        shareOwner: shareOwner,
        collateralToken: collateralToken,
        strategy: address(strategy),
        sequenceNumber: sequenceNumber,
        timestamp: _getChainTimestampMs(),
        feeWaived: feeWaivedAddresses[shareOwner],
        holdbackWaived: holdbackWaivedAddresses[shareOwner],
        hasActiveRedemptionHistory: hasActiveRedemptionHistory,
        vaultTotalAssets: totalAssets(),
        minNetOut: minNetOut
      }),
      emberShareConfigs[share],
      _holdbackQueues[share]
    );

    if (feeAmount > 0) {
      unchecked {
        platformFee.accrued += feeAmount;
      }
    }
  }

  /// @notice One-shot settles a FIFO batch of holdback entries at the given unwinding rate.
  /// @dev Operator-only. For each entry visited (oldest first, up to `maxEntries`), pays
  ///      `entry.amount * unwindingPercentage / 1e18` to the entry's recipient and closes
  ///      the entry — the residual at <100% is absorbed by the user as a haircut. The
  ///      queue head ALWAYS advances past every visited entry, so re-calling on the same
  ///      entry has no effect. Use 100% for the normal path and lower values only for
  ///      black-swan scenarios where the vault has bad debt to socialize. Liquidity for
  ///      the total batch is pulled once via `_ensureLiquidity` (vault balance, then
  ///      strategy if short).
  ///
  ///      An entry whose recipient is protocol-blacklisted is SKIPPED: no transfer is made,
  ///      the holdback is forfeited (collateral stays in the vault), and the head advances
  ///      past it. This mirrors `_processRequest`'s skip-on-blacklist and is the resolution
  ///      path when a recipient can no longer receive the collateral token (e.g. a token-level
  ///      blacklist): blacklist the recipient at the protocol level, then release proceeds.
  ///      Without it, one stuck head recipient would freeze every later release for the share.
  /// @param share The EmberShare whose holdback queue is being processed
  /// @param unwindingPercentage Final settlement rate per entry in 1e18 fixed-point (1e18 = pay full holdback)
  /// @param maxEntries Upper bound on entries scanned this call (gas guard)
  /// @return entriesProcessed Number of entries visited (≤ maxEntries)
  /// @return totalReleased Sum of collateral transferred this call
  function releaseUsersHoldback(
    address share,
    uint256 unwindingPercentage,
    uint256 maxEntries
  ) external nonReentrant onlyOperator returns (uint256 entriesProcessed, uint256 totalReleased) {
    IEmberProtocolConfig configProxy = protocolConfig;
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    _incrementSequence();

    uint256 newStartIndex;
    (entriesProcessed, totalReleased, newStartIndex) = AtomicLiquidityLib.releaseUsersHoldback(
      AtomicLiquidityLib.ReleaseArgs({
        share: share,
        unwindingPercentage: unwindingPercentage,
        maxEntries: maxEntries,
        collateralToken: collateralToken,
        strategy: address(strategy),
        protocolConfig: address(protocolConfig),
        sequenceNumber: sequenceNumber,
        timestamp: _getChainTimestampMs()
      }),
      _holdbackQueues[share],
      holdbackQueueStartIndex[share],
      unclaimedHoldback
    );
    holdbackQueueStartIndex[share] = newStartIndex;
  }

  /// @notice Claims collateral owed to the caller from a holdback payout that could not be
  ///         delivered during `releaseUsersHoldback` (e.g. the caller was blocklisted at
  ///         release time and is now payable again).
  /// @return amount The collateral transferred to the caller.
  function claimHoldback() external nonReentrant returns (uint256 amount) {
    amount = _settleHoldback(msg.sender, msg.sender);
  }

  /// @notice Claims a recipient's escrowed holdback on their behalf and pushes it to them.
  /// @dev Permissionless: the funds can only ever go to `recipient`, so anyone (e.g. the
  ///      operator) may trigger delivery once the recipient is payable again.
  /// @param recipient The address whose escrowed holdback is delivered.
  /// @return amount The collateral transferred to `recipient`.
  function claimHoldbackFor(address recipient) external nonReentrant returns (uint256 amount) {
    amount = _settleHoldback(recipient, recipient);
  }

  /// @notice Redirect the CALLER's own escrowed holdback to `to`. Lets a recipient that can
  ///         transact but can no longer receive the collateral token (e.g. a token-level
  ///         blacklist) recover its funds to a good address. Moves only the caller's own escrow.
  /// @param to Destination for the caller's escrowed collateral.
  /// @return amount The collateral transferred to `to`.
  function claimHoldbackTo(address to) external nonReentrant returns (uint256 amount) {
    if (to == address(0)) revert ZeroAddress();
    amount = _settleHoldback(msg.sender, to);
  }

  /// @notice Owner recovery for an escrowed holdback whose `recipient` can neither receive the
  ///         collateral nor call {claimHoldbackTo} (a permanently-unpayable recipient): redirects
  ///         the recipient's full escrowed balance to `to`. Without this the balance would be
  ///         locked forever (the plain claim can only push to the unpayable recipient).
  /// @dev Moves user funds, so it is gated to the UUPS `owner`, which MUST be the timelock and/or
  ///      multisig (same trust tier as {_authorizeUpgrade}). Direct the funds to the rightful
  ///      party (identifiable off-chain from `HoldbackTransferDeferred`).
  /// @param recipient The stuck escrow key (the original holdback recipient).
  /// @param to Destination for the recovered collateral.
  /// @return amount The collateral transferred to `to`.
  function recoverUnclaimedHoldback(
    address recipient,
    address to
  ) external nonReentrant onlyOwner returns (uint256 amount) {
    if (to == address(0)) revert ZeroAddress();
    amount = _settleHoldback(recipient, to);
  }

  /// @dev Bumps the sequence and delegates the escrow settlement (zero + transfer + event) to
  ///      AtomicLiquidityLib to keep this implementation under EIP-170.
  function _settleHoldback(address recipient, address to) internal returns (uint256 amount) {
    _incrementSequence();
    amount = AtomicLiquidityLib.claimHoldback(
      unclaimedHoldback,
      collateralToken,
      recipient,
      to,
      sequenceNumber
    );
  }

  /// @notice Forwards collected EmberVault shares (held by this contract via swapEmberShares)
  ///         into the respective EmberVault's redemption queue.
  /// @dev Operator-only. Self-approves the EmberVault to spend `amount` of its own receipt
  ///      tokens held by this contract, then calls `redeemShares(amount, address(this))`.
  ///      The EmberVault's operator will later process the resulting WithdrawalRequest, at
  ///      which point this contract receives collateral. Whitelist status is intentionally
  ///      NOT enforced here — a share that was de-whitelisted after collection must still
  ///      be redeemable to avoid stranding funds.
  /// @param share The EmberVault address whose shares are being submitted for redemption
  /// @param amount The number of shares to enqueue for redemption
  function redeemCollectedEmberShares(
    address share,
    uint256 amount
  ) external nonReentrant onlyOperator {
    IEmberProtocolConfig configProxy = protocolConfig;
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    _incrementSequence();
    bool flip = AtomicLiquidityLib.redeemCollectedEmberShares(
      share,
      amount,
      sequenceNumber,
      _getChainTimestampMs()
    );
    // Sticky flag — once set, stays set. Idempotent on subsequent calls.
    if (flip && !hasActiveRedemptionHistory) {
      hasActiveRedemptionHistory = true;
    }
  }

  /// @notice Operator transfers idle collateral to a whitelisted sub-account
  ///         without redeeming shares (operational utility).
  function supplyToSubAccount(
    address subAccount,
    uint256 amount
  ) external nonReentrant onlyOperator {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    if (!subAccounts[subAccount]) revert InvalidValue();
    if (amount == 0) revert ZeroAmount();

    IERC20 token = IERC20(collateralToken);
    uint256 vaultBalance = token.balanceOf(address(this));
    if (amount > vaultBalance) revert InsufficientBalance();

    uint256 previousBalance = vaultBalance;

    token.safeTransfer(subAccount, amount);

    uint256 newBalance = token.balanceOf(address(this));

    _incrementSequence();

    emit VaultSupplyToSubAccount(
      address(this),
      subAccount,
      previousBalance,
      newBalance,
      amount,
      _getChainTimestampMs(),
      sequenceNumber
    );
  }

  function processWithdrawalRequests(uint256 numRequests) external nonReentrant onlyOperator {
    IEmberProtocolConfig configProxy = protocolConfig;

    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.privilegedOperations) revert OperationPaused();

    if (numRequests == 0) revert ZeroAmount();

    // Settle accrued time-based fees BEFORE burning any shares. The fee base is
    // `totalAssets() - accrued`, and the shares redeemed here were under management for the
    // whole elapsed window (they stay in totalShares via pendingBurnShares until now).
    // Charging after the burn loop would price that window against the post-burn (smaller)
    // TVL and under-collect. Mirrors instantWithdraw / swapEmberShares.
    _chargeAccruedPlatformFees();

    _incrementSequence();

    uint256 startIndex = withdrawalQueueStartIndex;
    uint256 queueLength = pendingWithdrawals.length;

    {
      uint256 availableRequests = queueLength > startIndex ? queueLength - startIndex : 0;
      if (numRequests > availableRequests) {
        numRequests = availableRequests;
      }
    }

    uint256 currentTime = _getChainTimestampMs();
    uint256[5] memory counters; // [totalSharesBurnt, totalRequestProcessed, totalAmountWithdrawn, requestsSkipped, requestsCancelled]

    for (uint256 i = 0; i < numRequests; ) {
      WithdrawalRequest memory request = pendingWithdrawals[startIndex];

      delete pendingWithdrawals[startIndex];

      unchecked {
        startIndex++;
        i++;
      }

      (
        bool skipped,
        bool cancelled,
        uint256 withdrawAmount,
        uint256 sharesBurnt,
        uint256 newTotalShares,
        uint256 newPendingBurnShares
      ) = AtomicLiquidityLib.processRequest(
          AtomicLiquidityLib.ProcessRequestArgs({
            owner: request.owner,
            receiver: request.receiver,
            shares: request.shares,
            reqTimestamp: request.timestamp,
            reqSequenceNumber: request.sequenceNumber,
            currentTime: currentTime,
            grossWithdrawAmount: convertToAssets(request.shares),
            configProxy: address(configProxy),
            vaultValidator: address(vaultValidator),
            collateralToken: collateralToken,
            totalShares: totalShares,
            pendingBurnShares: pendingBurnShares,
            sequenceNumber: sequenceNumber
          }),
          accounts,
          shareOf
        );

      // Persist the share-accounting scalars the library updated for this request.
      totalShares = newTotalShares;
      pendingBurnShares = newPendingBurnShares;

      unchecked {
        counters[1]++;
        counters[0] += sharesBurnt;
        counters[2] += withdrawAmount;
        if (skipped) counters[3]++;
        if (cancelled) counters[4]++;
      }
    }

    if (startIndex >= queueLength) {
      delete pendingWithdrawals;
      withdrawalQueueStartIndex = 0;
    } else {
      withdrawalQueueStartIndex = startIndex;
    }

    emit ProcessRequestsSummary(
      address(this),
      counters[1],
      counters[3],
      counters[4],
      counters[0],
      counters[2],
      totalShares,
      pendingBurnShares,
      rate.value,
      sequenceNumber
    );
  }

  // ============================================
  // Views
  // ============================================

  /// @notice Returns the share balance of an account. Shares are non-transferable.
  function balanceOf(address account) external view returns (uint256) {
    return shareOf[account];
  }

  /// @notice Total share supply (includes shares parked for pending burns).
  function totalSupply() external view returns (uint256) {
    return totalShares;
  }

  /// @notice Underlying asset for ERC-4626 strategy compatibility / external readers.
  function asset() external view returns (address) {
    return collateralToken;
  }

  /// @notice Computed total assets under management based on current rate.
  ///         Mirrors EmberVault.totalAssets() — this is not the actual token balance,
  ///         which may differ due to operator withdrawals or strategy holdings.
  function totalAssets() public view returns (uint256) {
    uint256 shares = totalShares;
    if (shares == 0) {
      return 0;
    }
    return convertToAssets(shares);
  }

  /// @notice Converts assets to shares using rate-based conversion: shares = assets * rate
  function convertToShares(uint256 assets) public view returns (uint256) {
    uint256 rateValue = rate.value;
    if (rateValue == 0) {
      return 0;
    }
    return FixedPointMath.mul(assets, rateValue);
  }

  /// @notice Converts shares to assets using rate-based conversion: assets = shares / rate (floor)
  function convertToAssets(uint256 shares) public view returns (uint256) {
    uint256 rateValue = rate.value;
    if (rateValue == 0 || shares == 0) {
      return 0;
    }
    return FixedPointMath.div(shares, rateValue);
  }

  function maxDeposit(address) external view returns (uint256) {
    if (pauseStatus.deposits || protocolConfig.getProtocolPauseStatus()) {
      return 0;
    }
    uint256 currentTVL = totalAssets();
    if (currentTVL >= maxTVL) {
      return 0;
    }
    return maxTVL - currentTVL;
  }

  function getPendingWithdrawal(uint256 index) external view returns (WithdrawalRequest memory) {
    uint256 startIndex = withdrawalQueueStartIndex;
    uint256 queueLength = pendingWithdrawals.length;
    if (startIndex + index >= queueLength) revert IndexOutOfBounds();
    return pendingWithdrawals[startIndex + index];
  }

  function getPendingWithdrawalsLength() external view returns (uint256) {
    uint256 startIndex = withdrawalQueueStartIndex;
    uint256 queueLength = pendingWithdrawals.length;
    return queueLength > startIndex ? queueLength - startIndex : 0;
  }

  /// @notice Best-effort view of how many underlying assets the vault could redeem from
  ///         the strategy right now. Returns 0 if no strategy is configured.
  function getStrategyAssets() external view returns (uint256) {
    return AtomicLiquidityLib.strategyAssets(address(strategy));
  }

  /// @notice Read-only solvency signal for off-chain monitoring: the vault's collateral
  ///         backing minus its modeled claims, as a signed value (positive = surplus,
  ///         negative = under-collateralized).
  /// @dev    backing = idle collateral balance + assets currently redeemable from the strategy.
  ///         claims  = totalAssets() (rate-based value owed to shareholders) + accrued platform fee.
  ///
  ///         This is purely informational — there is NO on-chain enforcement. Accrued platform
  ///         fees are a soft (junior) claim against future yield, reconciled when collected via
  ///         collectPlatformFee(loss); a transient negative margin is therefore possible by design.
  ///
  ///         NOTE: this does NOT subtract outstanding EmberShare swap holdback liabilities (those
  ///         are tracked per-share in the holdback queues and have no O(1) aggregate). Monitors
  ///         that care about holdbacks should account for them separately.
  /// @return margin Signed difference `backing - claims`, in collateral units.
  function solvencyMargin() external view returns (int256 margin) {
    return
      AtomicLiquidityLib.solvencyMargin(
        collateralToken,
        address(strategy),
        totalAssets(),
        platformFee.accrued
      );
  }

  /// @notice Remaining shares that can still be redeemed via instantWithdraw before the cap is hit.
  function availableInstantWithdrawShares() external view returns (uint256) {
    uint256 max = maxInstantWithdrawShares;
    uint256 used = cumulativeInstantWithdrawShares;
    return max > used ? max - used : 0;
  }

  /// @notice Returns the current effective remaining capacity (in collateral units) for an
  ///         EmberShare's instant swap. Mirrors the on-chain epoch logic: if the 24h window
  ///         has elapsed since `epochStartedAt`, capacity is computed as if the epoch were
  ///         fresh; otherwise it's `cap - epochUsedAmount`.
  function availableEmberShareCapacity(address share) external view returns (uint256) {
    return AtomicLiquidityLib.availableEmberShareCapacity(share, emberShareConfigs[share]);
  }

  /// @notice Returns the holdback queue length (including released entries before head advance).
  function getHoldbackQueueLength(address share) external view returns (uint256) {
    return _holdbackQueues[share].length;
  }

  /// @notice Returns the number of unprocessed holdback entries (queue.length - startIndex).
  function getPendingHoldbackEntries(address share) external view returns (uint256) {
    uint256 startIndex = holdbackQueueStartIndex[share];
    uint256 queueLength = _holdbackQueues[share].length;
    return queueLength > startIndex ? queueLength - startIndex : 0;
  }

  /// @notice Reads a specific holdback entry by absolute index (0 = first ever queued).
  function getHoldbackEntry(
    address share,
    uint256 index
  ) external view returns (AtomicLiquidityLib.HoldbackEntry memory) {
    AtomicLiquidityLib.HoldbackEntry[] storage queue = _holdbackQueues[share];
    if (index >= queue.length) revert IndexOutOfBounds();
    return queue[index];
  }

  function version() external pure virtual returns (string memory) {
    return "v1.0.0";
  }

  function vaultName() external view returns (string memory) {
    return _vaultName;
  }

  function getChainTimestampMs() external view returns (uint256) {
    return _getChainTimestampMs();
  }

  function getAccountState(
    address accountAddress
  )
    external
    view
    returns (
      uint256 totalPendingWithdrawalShares,
      uint256[] memory pendingWithdrawalRequestSequenceNumbers,
      uint256[] memory cancelWithdrawRequestSequenceNumbers
    )
  {
    WithdrawalQueueLib.Account storage account = accounts[accountAddress];
    return (
      account.totalPendingWithdrawalShares,
      account.pendingWithdrawalRequestSequenceNumbers,
      account.cancelWithdrawRequestSequenceNumbers
    );
  }

  // ============================================
  // Internal
  // ============================================

  function _getChainTimestampMs() internal view returns (uint256) {
    return block.timestamp * 1000;
  }

  function _incrementSequence() internal {
    unchecked {
      sequenceNumber++;
    }
  }

  function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
    // Authorization handled by onlyOwner.
  }

  /// @dev Thin wrapper around `VaultPlatformFeeLib.charge`. Body lives in the shared library;
  ///      this wrapper bumps the local `sequenceNumber` iff the library actually accrued a
  ///      non-zero fee (and emitted `VaultPlatformFeeCharged` with that bumped sequence).
  ///      Called from every flow that mutates TVL — see grep callers.
  function _chargeAccruedPlatformFees() internal {
    uint256 nextSeq;
    unchecked {
      nextSeq = sequenceNumber + 1;
    }
    bool didCharge = VaultPlatformFeeLib.charge(
      platformFee,
      totalAssets(),
      _getChainTimestampMs(),
      nextSeq
    );
    if (didCharge) {
      sequenceNumber = nextSeq;
    }
  }

  // `_ensureLiquidity` lives in AtomicLiquidityLib.ensureLiquidity (external). DELEGATECALL
  // preserves storage / msg.sender / address(this), so call sites read identically. The
  // single-source-of-truth is the lib's `_ensureLiquidity` helper — see callers below.

  function _validateDeposit(address depositor, IEmberProtocolConfig configProxy) internal view {
    if (configProxy.getProtocolPauseStatus()) revert ProtocolPaused();
    if (pauseStatus.deposits) revert OperationPaused();
    if (configProxy.isAccountBlacklisted(depositor)) revert Blacklisted();
    if (subAccounts[depositor]) revert InvalidValue();
    if (address(vaultValidator) != address(0)) {
      vaultValidator.validateDeposit(address(this), depositor);
    }
  }

  function _deposit(
    uint256 assets,
    address receiver,
    address depositor
  ) internal returns (uint256 shares) {
    IEmberProtocolConfig configProxy = protocolConfig;

    _chargeAccruedPlatformFees();

    _validateDeposit(depositor, configProxy);

    if (configProxy.isAccountBlacklisted(receiver)) revert Blacklisted();
    if (subAccounts[receiver]) revert InvalidValue();

    if (assets == 0) revert ZeroAmount();

    IERC20(collateralToken).safeTransferFrom(depositor, address(this), assets);

    shares = convertToShares(assets);
    if (shares == 0) revert ZeroAmount();

    // M-3: capture the receiver's share balance BEFORE the mint — it's the weight for the
    // receiver's existing anti-JIT clock in the amount-weighted update below.
    uint256 receiverSharesBefore = shareOf[receiver];
    unchecked {
      shareOf[receiver] = receiverSharesBefore + shares;
      totalShares += shares;
    }

    if (totalAssets() > maxTVL) revert MaxTVLReached();

    _incrementSequence();

    uint256 currentTime = _getChainTimestampMs();

    // M-3: amount-weighted, RECEIVER-keyed anti-JIT clock. AtomicLiquidity's internal shares
    // are non-transferable, so keying by the receiver (who redeems them) is correct once the
    // weighting neutralizes dust-grief. The weight is the receiver's share balance before this
    // deposit PLUS any shares they've already queued for withdrawal — `redeemShares` moves
    // queued shares out of `shareOf` into the pending pool, so without the pending term a
    // mid-withdrawal receiver would weigh in at ~0 and a dust deposit front-running
    // `processWithdrawalRequests` could reset the clock the queued request reads at processing.
    if (address(vaultValidator) != address(0)) {
      uint256 oldWeight = receiverSharesBefore + accounts[receiver].totalPendingWithdrawalShares;
      vaultValidator.recordWeightedDeposit(address(this), receiver, oldWeight, shares, currentTime);
    }

    emit VaultDeposit(
      address(this),
      depositor,
      receiver,
      assets,
      shares,
      totalShares,
      currentTime,
      sequenceNumber
    );

    return shares;
  }
}
