pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IEmberVaultValidator.sol";
import "./interfaces/IEmberVault.sol";
import "./interfaces/IEmberProtocolConfig.sol";
import "./libraries/Math.sol";

/// @notice Minimal view surface used by `recordDepositFor` to authenticate the
///         caller against the vault's registered parking lot. Only EmberVault
///         exposes `parkingLot()`; the call reverts on vaults that do not have
///         one (ALV, ETH vault), which is the correct behavior — `recordDepositFor`
///         is meaningful only for parking-lot-mediated deposits.
interface IEmberVaultWithParkingLot {
  function parkingLot() external view returns (address);
}

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

  /// @notice Records the last deposit timestamp against the depositor (msg.sender
  ///         of the deposit call on the vault), NOT the receiver of the minted
  ///         shares.
  /// @dev    Only callable by the vault itself. Without this guard anyone could
  ///         reset a user's deposit clock and force them to pay time-based
  ///         withdrawal fees.
  ///
  ///         Keying by depositor closes the following griefing vector: originally
  ///         callers passed the `receiver`, so anyone could submit a dust deposit
  ///         naming a victim as receiver, which reset the victim's anti-JIT clock —
  ///         their next processed withdrawal would then pay the time-based fee even
  ///         though they never deposited. Post-fix, only the depositor's own clock
  ///         moves.
  ///
  ///         Custodial-flow caveat: when depositor != receiver (a smart wallet, an
  ///         aggregator, a bridge forwarder), the receiver's clock is not touched.
  ///         If the receiver later withdraws with the shares they received, they will
  ///         trip the "no recorded deposit → fee fires" branch of
  ///         `calculateWithdrawalFees`. Operators must fee-exempt such recipients
  ///         via `setFeeExemptionListStatus`.
  function recordDeposit(address vault, address depositor, uint256 timestamp) external {
    if (msg.sender != vault) revert Unauthorized();
    _lastDepositTimestamp[vault][depositor] = timestamp;
  }

  /// @notice Records the last-deposit timestamp on behalf of the ORIGINAL depositor
  ///         when the deposit was forwarded by the vault's parking lot. Direct
  ///         deposits use `recordDeposit`; the parking-lot flow needs this
  ///         because at forward time the vault sees `msg.sender = parkingLot`
  ///         and its `recordDeposit(vault, msg.sender, ts)` call would attribute
  ///         the anti-JIT clock to the parking lot rather than the actual user.
  /// @dev    Caller MUST be the vault's registered parking lot. Restricting to
  ///         the parking lot (which authenticates the original depositor via
  ///         its own request-tracking) keeps this from becoming a free
  ///         grief primitive — only the trusted forwarder can attribute a
  ///         deposit to a specific address on the vault's behalf.
  ///
  ///         Vaults without a parking lot (ALV, ETH vault) revert on the
  ///         `parkingLot()` staticcall, naturally rejecting the auth attempt.
  function recordDepositFor(address vault, address depositor, uint256 timestamp) external {
    address lot = IEmberVaultWithParkingLot(vault).parkingLot();
    if (lot == address(0) || msg.sender != lot) revert Unauthorized();
    _lastDepositTimestamp[vault][depositor] = timestamp;
  }

  /// @notice M-3: amount-weighted last-deposit timestamp for the time-based (anti-JIT)
  ///         withdrawal fee, keyed by the RECEIVER (the account that holds and later redeems
  ///         the shares). Used by AtomicLiquidity, whose internal shares are non-transferable,
  ///         so receiver-keying is safe once the weighting neutralizes dust-grief.
  /// @dev    Only callable by the vault itself. Blends the deposit time into the receiver's
  ///         existing clock by share weight:
  ///           new_ts = (oldWeight*oldTs + newShares*now) / (oldWeight + newShares)
  ///         where `oldWeight` is the receiver's share balance BEFORE this deposit plus any
  ///         shares they have already queued for withdrawal (counting the queued shares keeps a
  ///         mid-withdrawal receiver at full weight, so a dust deposit — even one front-running
  ///         withdrawal processing — can't reset the clock the queued request reads). A receiver
  ///         with no recorded clock weights `oldTs` as `now`, so a brand-new receiver
  ///         (oldWeight == 0) records exactly `now`. The result lies in [oldTs, now], so it
  ///         never records a future timestamp.
  function recordWeightedDeposit(
    address vault,
    address receiver,
    uint256 oldWeight,
    uint256 newShares,
    uint256 timestamp
  ) external {
    if (msg.sender != vault) revert Unauthorized();
    uint256 denom = oldWeight + newShares;
    // newShares > 0 at every real call site (deposit mints > 0 shares); guard defensively so a
    // zero-weight call can never divide by zero.
    if (denom == 0) return;
    uint256 stored = _lastDepositTimestamp[vault][receiver];
    uint256 oldTs = stored == 0 ? timestamp : stored;
    _lastDepositTimestamp[vault][receiver] = (oldWeight * oldTs + newShares * timestamp) / denom;
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
      // If no deposit timestamp is recorded (e.g., shares received via transfer or bridge
      // mint), treat the holder as still within the lockout window so the time-based fee
      // cannot be bypassed by routing shares through a fresh address.
      //
      // L-5: written overflow-safe. `timeBasedFeeThreshold` is admin-set with no upper bound,
      // so the naive `lastDeposit + threshold > currentTime` could revert on a checked-add
      // overflow and wedge the whole withdrawal loop. `threshold > currentTime - lastDeposit`
      // is exactly equivalent (for currentTime >= lastDeposit) without the addition.
      if (
        lastDeposit == 0 ||
        currentTime < lastDeposit ||
        fee.timeBasedFeeThreshold > currentTime - lastDeposit
      ) {
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
    return "v1.1.0";
  }

  function _authorizeUpgrade(address) internal override onlyOwner {}

  uint256[43] private __gap;
}
