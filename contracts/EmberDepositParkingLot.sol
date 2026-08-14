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
import "./interfaces/IEmberProtocolConfig.sol";
import "./interfaces/IEmberVault.sol";
import "./interfaces/IEmberVaultValidator.sol";

/// @notice Minimal view of the target vault used by the parking lot.
interface IAsyncVaultDeposit {
  function deposit(uint256 assets, address receiver) external returns (uint256 shares);

  function asset() external view returns (address);

  /// @notice The vault's per-operation pause flags: (deposits, withdrawals, privilegedOperations).
  function pauseStatus()
    external
    view
    returns (bool deposits, bool withdrawals, bool privilegedOperations);
}

// Custom errors (ZeroAddress / Unauthorized / Blacklisted / SameValue are declared in
// IEmberProtocolConfig and inherited via that import).
error ZeroAmount();
error OperationPaused();
error InvalidRequest();
error IndexOutOfBounds();
/// @notice `receiver` is an address that has no redemption path for minted shares (the parking
///         lot, the vault, or the collateral token), which would permanently lock them.
error InvalidReceiver();
/// @notice The collateral token charged a fee on transfer (balance diff < requested amount).
///         Neither the parking lot nor EmberVault supports fee-on-transfer collateral: the
///         vault trusts the forwarded amount and does not measure balance itself, so allowing
///         FoT would cause the vault to over-mint shares against the actual received amount.
///         Fail fast at park time instead of misaccounting downstream.
error FeeOnTransferNotSupported();
// Note: `DepositNotAllowed` (used by the deposit allow-list gate below) is declared in
// IEmberVault.sol and inherited via that import — do not re-declare it here.

/**
 * @title EmberDepositParkingLot
 * @notice Holds ("parks") user deposits until the operator forwards them
 *         into an EmberVault that has set this contract as its parking lot. A user calls
 *         {deposit}, which escrows their collateral here
 *         and queues a request. The operator later calls {processDeposits}, which deposits the
 *         escrowed collateral into the vault on the user's behalf (the vault mints shares
 *         directly to the user at the current rate). Users may {cancelDeposit} a pending request
 *         at any time to reclaim their escrow immediately.
 *
 * @dev The vault owner must set this contract as the vault's `parkingLot` (via
 *      EmberVault.setParkingLot) so that its forwarded {IAsyncVaultDeposit.deposit} calls are
 *      accepted while the gate is active. UUPS upgradeable.
 *
 *      TRUST ASSUMPTION (upgradeability): this contract custodies live user collateral in escrow
 *      between {deposit} and {processDeposits}/{cancelDeposit}, and is UUPS-upgradeable behind an
 *      owner-only {_authorizeUpgrade}. The owner can therefore upgrade to an implementation that
 *      moves escrowed funds, with no on-chain delay. The owner MUST be a Timelock (see
 *      Timelock.sol) and/or a multisig so that any upgrade is publicly visible for a delay window
 *      before it can execute. Deploying with an EOA owner is unsafe for production. This trust
 *      assumption should be disclosed to users of the async-deposit path.
 */
contract EmberDepositParkingLot is
  Initializable,
  UUPSUpgradeable,
  OwnableUpgradeable,
  ReentrancyGuardUpgradeable
{
  using SafeERC20 for IERC20;

  /// @notice A parked deposit awaiting the operator. `depositor == address(0)` means the slot
  ///         has been settled (processed or cancelled).
  struct DepositRequest {
    address depositor; // escrowed the collateral; receives refunds on cancel/skip
    address receiver; // receives the minted vault shares when processed
    uint256 assets; // escrowed collateral amount (net received)
    // Park time in ms. Informational only — recorded for off-chain tracking (emitted in
    // DepositRequested and returned by getPendingDeposit); NOT read by any on-chain logic. In
    // particular it does NOT feed the vault's time-based-fee clock (see {deposit} notes).
    uint256 timestamp;
  }

  /// @notice Protocol config (global pause + blacklist source)
  IEmberProtocolConfig public protocolConfig;

  /// @notice Target EmberVault that escrowed deposits are forwarded into
  IAsyncVaultDeposit public vault;

  /// @notice Underlying collateral token (the vault's asset)
  IERC20 public collateralToken;

  /// @notice Operator authorized to process the queue into the vault
  address public operator;

  /// @notice When true, new deposits are blocked (processing + cancellation remain available)
  bool public depositsPaused;

  /// @notice Monotonic request counter and queue key for each request. Also the FIFO TAIL:
  ///         requests are assigned strictly increasing seqs (1, 2, 3, …), so the seq IS the queue
  ///         position — no separate index array is needed.
  uint256 public sequenceNumber;

  /// @notice FIFO HEAD: the highest request seq already consumed by {processDeposits}. The pending
  ///         (unprocessed) requests are exactly the seqs in `(queueStartIndex, sequenceNumber]`.
  ///         Advances monotonically and is never reset — so there is no growing array to free and
  ///         no O(n) cleanup; head/tail bookkeeping is O(1) per request.
  uint256 public queueStartIndex;

  /// @notice seq => request. Deleted (depositor zeroed) when processed or cancelled.
  mapping(uint256 => DepositRequest) public depositRequests;

  /// @notice Total collateral currently escrowed across all pending requests
  uint256 public totalPendingAssets;

  /// @notice Pull-payment balances. Collateral from a refund that could not be delivered during
  ///         {processDeposits} or {cancelDeposit} (e.g. the depositor is token-blacklisted, or is
  ///         a contract that reverts on receipt) is credited here and withdrawn later via {claim}.
  ///         This is what keeps a single undeliverable refund from wedging the FIFO queue.
  mapping(address => uint256) public claimable;

  /// @notice Operator-managed deposit allow-list. When it is NON-EMPTY
  ///         (`depositAllowListCount > 0`), only listed addresses may {deposit}; when it is empty
  ///         (the default), deposits are open to everyone. Backwards-compatible: a fresh parking
  ///         lot starts with an empty list, so behaviour is unchanged until the operator adds an
  ///         entry.
  mapping(address => bool) public depositAllowList;

  /// @notice Number of addresses currently on `depositAllowList`. Gates the list: 0 = open.
  uint256 public depositAllowListCount;

  /// @dev Reserved storage gap for future upgrades. Decremented by 2 when `depositAllowList` and
  ///      `depositAllowListCount` were added (was 43).
  uint256[41] private __gap;

  // Events
  //
  // Every parking-lot event carries the bound vault address as its first
  // (indexed) field so downstream indexers can attribute events to a vault
  // without maintaining a parking-lot -> vault side-table. The parking lot
  // is 1:1 with a vault (immutable at init), so `vault` on every event
  // matches the value emitted in {ParkingLotInitialized}.
  event ParkingLotInitialized(
    address indexed vault,
    address indexed collateralToken,
    address operator
  );
  event OperatorUpdated(
    address indexed vault,
    address indexed previousOperator,
    address indexed newOperator
  );
  event DepositsPausedUpdated(address indexed vault, bool paused);
  event DepositRequested(
    address indexed vault,
    address indexed depositor,
    address indexed receiver,
    uint256 assets,
    uint256 totalPendingAssets,
    uint256 sequenceNumber,
    uint256 timestamp
  );
  event DepositCancelled(
    address indexed vault,
    address indexed depositor,
    uint256 assets,
    uint256 sequenceNumber
  );
  event DepositForwarded(
    address indexed vault,
    address indexed depositor,
    address indexed receiver,
    uint256 assets,
    uint256 sharesMinted,
    uint256 sequenceNumber
  );
  event DepositSkipped(
    address indexed vault,
    address indexed depositor,
    address indexed receiver,
    uint256 assets,
    uint256 sequenceNumber
  );
  /// @notice A refund could not be delivered to `depositor` (e.g. token-level blacklist or a
  ///         reverting receiver) and was recorded as a {claimable} pull-payment instead.
  event RefundCredited(address indexed vault, address indexed depositor, uint256 assets);
  /// @notice `depositor` withdrew their accrued pull-payment balance via {claim}.
  event Claimed(address indexed vault, address indexed depositor, uint256 assets);
  /// @notice The operator added (`status=true`) or removed (`status=false`) `account` from the
  ///         deposit allow-list. `count` is the resulting number of allow-listed addresses
  ///         (0 = deposits open to everyone).
  event DepositAllowListUpdated(
    address indexed vault,
    address indexed account,
    bool status,
    uint256 count
  );

  modifier onlyOperator() {
    if (msg.sender != operator) revert Unauthorized();
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /// @param _protocolConfig Protocol config (pause + blacklist)
  /// @param _vault Target EmberVault (its owner must set this contract as the vault's parkingLot)
  /// @param _operator Address allowed to process the queue
  /// @param initialOwner Owner (admin) of this contract
  function initialize(
    address _protocolConfig,
    address _vault,
    address _operator,
    address initialOwner
  ) public initializer {
    if (
      _protocolConfig == address(0) ||
      _vault == address(0) ||
      _operator == address(0) ||
      initialOwner == address(0)
    ) revert ZeroAddress();

    __Ownable_init(initialOwner);
    __UUPSUpgradeable_init();
    __ReentrancyGuard_init();

    protocolConfig = IEmberProtocolConfig(_protocolConfig);
    vault = IAsyncVaultDeposit(_vault);
    collateralToken = IERC20(IAsyncVaultDeposit(_vault).asset());
    operator = _operator;

    emit ParkingLotInitialized(_vault, address(collateralToken), _operator);
  }

  // ============ Admin ============

  /// @dev Verifies caller is the bound vault's admin. The parking lot is 1:1 with a
  ///      vault (immutable binding), so we read the current admin off the vault at
  ///      call time — no separate role state to keep in sync.
  modifier onlyVaultAdmin() {
    if (msg.sender != IEmberVault(address(vault)).roles().admin) revert Unauthorized();
    _;
  }

  /// @notice Sets the operator authorised to process the deposit queue.
  /// @dev Callable by the vault admin. The parking lot's own `owner` is reserved for
  ///      the UUPS upgrade key and is deliberately separate: upgrades must live
  ///      behind a timelock/multisig, operational role changes must not.
  function setOperator(address newOperator) external onlyVaultAdmin {
    if (newOperator == address(0)) revert ZeroAddress();
    // Reject a protocol-blacklisted operator, for consistency with the rest of the system's
    // role/allow-list setters (e.g. EmberProtocolConfig.setVaultDepositAllowList).
    if (protocolConfig.isAccountBlacklisted(newOperator)) revert Blacklisted();
    if (newOperator == operator) revert SameValue();
    emit OperatorUpdated(address(vault), operator, newOperator);
    operator = newOperator;
  }

  /// @notice Pauses or unpauses new deposits (processing + cancellation remain available).
  /// @dev Callable by the bound vault's admin OR the protocol guardian. The admin path mirrors
  ///      the vault's own per-operation pause authority (setPausedStatus is admin-only via
  ///      ProtocolConfig); the guardian path mirrors the guardian's emergency-pause authority
  ///      over non-admin operations elsewhere in the protocol
  ///      (see IEmberProtocolConfig.guardianPauseNonAdminOperations). When the guardian is unset
  ///      (address(0)) only the vault admin can call this.
  function setDepositsPaused(bool paused) external {
    if (
      msg.sender != IEmberVault(address(vault)).roles().admin &&
      msg.sender != protocolConfig.guardian()
    ) revert Unauthorized();
    if (paused == depositsPaused) revert SameValue();
    depositsPaused = paused;
    emit DepositsPausedUpdated(address(vault), paused);
  }

  /// @notice Adds (`status=true`) or removes (`status=false`) `account` from the deposit
  ///         allow-list. While the list is non-empty, only listed addresses may {deposit}; an
  ///         empty list leaves deposits open to everyone.
  /// @dev Operator-gated — the operator, who also processes the queue, controls who may park.
  ///      Rejects adding a protocol-blacklisted account, for consistency with the rest of the
  ///      system's allow-list setters. Reverts `SameValue` if the flag is already set.
  /// @param account Address to add to / remove from the allow-list
  /// @param status True to allow-list, false to remove
  function setDepositAllowListStatus(address account, bool status) external onlyOperator {
    if (account == address(0)) revert ZeroAddress();
    if (status && protocolConfig.isAccountBlacklisted(account)) revert Blacklisted();
    if (depositAllowList[account] == status) revert SameValue();

    depositAllowList[account] = status;
    unchecked {
      // Guarded by the SameValue check above, so the count only moves on a real transition and
      // can never underflow (a false→removal only runs when the entry was true).
      if (status) depositAllowListCount++;
      else depositAllowListCount--;
    }

    emit DepositAllowListUpdated(address(vault), account, status, depositAllowListCount);
  }

  /// @notice Whether `account` may currently deposit: true if the allow-list is empty (open to
  ///         everyone) or `account` is explicitly on it.
  function isDepositAllowed(address account) public view returns (bool) {
    return depositAllowListCount == 0 || depositAllowList[account];
  }

  // ============ User: park / cancel ============

  /// @notice Escrows collateral and queues a deposit to be forwarded to the vault.
  /// @dev Neither fee-on-transfer nor rebasing collateral is supported. The vault mints shares
  ///      from the argument passed to {IAsyncVaultDeposit.deposit}, not from the balance it
  ///      actually receives, so any token whose `transfer`/`transferFrom` moves less than the
  ///      requested amount would cause the vault to over-mint against its actual holdings.
  ///      To make that failure mode impossible instead of subtle, this function measures
  ///      `balanceOf` around the transfer and reverts with {FeeOnTransferNotSupported} if
  ///      the received amount is not exactly `assets`. Deploy this parking lot only against
  ///      non-rebasing, non-FoT collateral.
  ///
  ///      FEE-CLOCK NOTE: the vault records the receiver's time-based-withdrawal-fee clock at
  ///      FORWARD time (when {processDeposits} calls the vault), not at park time. So time spent
  ///      waiting in this queue does NOT count toward the receiver's time-based-fee threshold —
  ///      operator latency effectively lengthens their early-withdrawal lockout. The stored park
  ///      `timestamp` is informational and is not used to backdate the clock.
  /// @param assets Amount of collateral to pull from the caller. Must equal the amount the
  ///        parking lot actually receives (no fee-on-transfer).
  /// @param receiver Address that will receive the vault shares once processed
  /// @return seq The sequence number of the queued request (used to cancel / track)
  function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 seq) {
    if (protocolConfig.getProtocolPauseStatus()) revert OperationPaused();
    if (depositsPaused) revert OperationPaused();
    // Fail fast if the vault itself has deposits paused: a forward would revert and the request
    // would only be skipped + refunded later, so don't let users escrow into a queue that can't
    // currently settle. Mirrors the protocol-pause and local-pause checks above.
    (bool vaultDepositsPaused, , ) = vault.pauseStatus();
    if (vaultDepositsPaused) revert OperationPaused();
    if (assets == 0) revert ZeroAmount();
    if (receiver == address(0)) revert ZeroAddress();
    // Reject receivers with no redemption path for the minted shares (would lock them forever):
    // the parking lot itself, the vault, or the collateral token.
    if (
      receiver == address(this) ||
      receiver == address(vault) ||
      receiver == address(collateralToken)
    ) revert InvalidReceiver();
    // Also reject receivers that the vault itself would refuse to mint shares to at
    // forward time (vault roles + sub-accounts — see EmberVault._validateDeposit).
    // Rejecting up front avoids escrowing collateral that we know will be skipped + refunded.
    IEmberVault.Roles memory vaultRoles = IEmberVault(address(vault)).roles();
    if (
      receiver == vaultRoles.admin ||
      receiver == vaultRoles.operator ||
      receiver == vaultRoles.rateManager ||
      IEmberVault(address(vault)).subAccounts(receiver)
    ) revert InvalidReceiver();
    if (protocolConfig.isAccountBlacklisted(msg.sender)) revert Blacklisted();
    if (protocolConfig.isAccountBlacklisted(receiver)) revert Blacklisted();
    // Deposit allow-list gate: while the list is non-empty, only listed depositors may park;
    // an empty list is open to everyone. Gates the depositor (msg.sender), not the receiver.
    if (!isDepositAllowed(msg.sender)) revert DepositNotAllowed();

    // Escrow collateral. Reject fee-on-transfer tokens up front (see {FeeOnTransferNotSupported}
    // and the function NatSpec): the vault mints shares against `assets`, not against what it
    // actually receives, so a token that skims a fee on transfer would cause the vault to
    // over-mint on forward. Measuring the balance diff here catches this class of token
    // regardless of how it advertises itself.
    uint256 balanceBefore = collateralToken.balanceOf(address(this));
    collateralToken.safeTransferFrom(msg.sender, address(this), assets);
    if (collateralToken.balanceOf(address(this)) - balanceBefore != assets) {
      revert FeeOnTransferNotSupported();
    }

    unchecked {
      seq = ++sequenceNumber;
      totalPendingAssets += assets;
    }

    depositRequests[seq] = DepositRequest({
      depositor: msg.sender,
      receiver: receiver,
      assets: assets,
      timestamp: _nowMs()
    });
    // No queue array to push: the seq itself is the FIFO position (see `sequenceNumber`).

    emit DepositRequested(
      address(vault),
      msg.sender,
      receiver,
      assets,
      totalPendingAssets,
      seq,
      _nowMs()
    );
  }

  /// @notice Cancels the caller's pending request and refunds the escrowed collateral now.
  /// @dev If the cancelled slot is the queue head, the head is advanced past it (and any
  ///      contiguous already-settled slots behind it), so the operator never has to iterate dead
  ///      slots — this makes cancel-then-redeposit "queue stuffing" pay for its own skip cost
  ///      (the head advance is bounded by, and charged to, the canceller). A cancel of a non-head
  ///      slot just zeroes it; it is skipped (one SLOAD) when {processDeposits} reaches it.
  /// @param seq The sequence number of the request to cancel
  function cancelDeposit(uint256 seq) external nonReentrant {
    DepositRequest memory request = depositRequests[seq];
    // Zero depositor => already settled; non-matching => not the caller's. Both invalid.
    if (request.depositor != msg.sender) revert InvalidRequest();

    uint256 assets = request.assets;

    // Effects before interaction (CEI).
    delete depositRequests[seq];
    unchecked {
      totalPendingAssets -= assets;
    }

    // If this was the head slot, advance the head past it and any contiguous settled slots so the
    // operator skips zero dead slots at the front.
    if (seq == queueStartIndex + 1) {
      uint256 newHead = seq;
      uint256 tail = sequenceNumber;
      while (newHead < tail && depositRequests[newHead + 1].depositor == address(0)) {
        unchecked {
          newHead++;
        }
      }
      queueStartIndex = newHead;
    }

    // Refund now, or — if the transfer can't be delivered (e.g. caller is token-blacklisted) —
    // record a pull-payment claim so the cancel still succeeds and the escrow isn't stuck.
    _refundOrCredit(msg.sender, assets);

    emit DepositCancelled(address(vault), msg.sender, assets, seq);
  }

  /// @notice Withdraws the caller's accrued pull-payment balance — collateral from a refund that
  ///         could not be delivered during {processDeposits} or {cancelDeposit}.
  /// @return amount Collateral transferred to the caller.
  function claim() external nonReentrant returns (uint256 amount) {
    amount = claimable[msg.sender];
    if (amount == 0) revert ZeroAmount();
    claimable[msg.sender] = 0;
    collateralToken.safeTransfer(msg.sender, amount);
    emit Claimed(address(vault), msg.sender, amount);
  }

  // ============ Operator: process ============

  /// @notice Forwards up to `numRequests` queued deposits into the vault (FIFO). Each live
  ///         request is deposited into the vault (shares minted to its receiver). A request
  ///         whose vault deposit reverts (e.g. receiver blacklisted, vault paused, max TVL) is
  ///         skipped and its escrow refunded to the depositor. The refund can never revert the
  ///         batch: if it can't be delivered (token-level blacklist on the depositor, reverting
  ///         receiver), it is recorded as a {claimable} pull-payment instead. So no single entry —
  ///         not even one with an undeliverable refund — can wedge the queue. Cancelled entries
  ///         are skipped silently.
  /// @param numRequests Maximum number of queued requests to process this call
  function processDeposits(uint256 numRequests) external nonReentrant onlyOperator {
    if (protocolConfig.getProtocolPauseStatus()) revert OperationPaused();
    if (numRequests == 0) revert ZeroAmount();

    // FIFO over seqs in (head, tail]. head advances monotonically; there is no array to grow or
    // delete, so freeing each consumed slot is O(1) (a single `delete depositRequests[seq]`).
    uint256 head = queueStartIndex;
    uint256 tail = sequenceNumber;
    {
      uint256 available = tail - head; // head never exceeds tail
      if (numRequests > available) numRequests = available;
    }

    for (uint256 i = 0; i < numRequests; ) {
      unchecked {
        head++; // next seq to process (seqs are 1-based and contiguous)
        i++;
      }
      uint256 seq = head;

      DepositRequest memory request = depositRequests[seq];
      if (request.depositor == address(0)) {
        // Cancelled (already refunded) — skip silently.
        continue;
      }

      // Settle bookkeeping for this slot before any external call (CEI).
      delete depositRequests[seq];
      unchecked {
        totalPendingAssets -= request.assets;
      }

      _forward(request, seq);
    }

    queueStartIndex = head;
  }

  /// @dev Deposits one request's escrow into the vault, or refunds the depositor if the vault
  ///      deposit reverts. Approval is set just-in-time and cleared on failure.
  function _forward(DepositRequest memory request, uint256 seq) private {
    // Re-check the ORIGINAL depositor against the protocol blacklist. The vault
    // itself validates against `msg.sender` (the parking lot) — which is never
    // blacklisted — so without this check a user who was clean at park time but
    // was blacklisted before forward would have their deposit delivered anyway.
    // If blacklisted, skip + refund (routed through the same pull-payment path
    // used for vault-rejected forwards; the refund transfer itself may also be
    // undeliverable if the token layer enforces the blacklist, in which case
    // {_refundOrCredit} records a {claimable} balance instead of reverting).
    if (protocolConfig.isAccountBlacklisted(request.depositor)) {
      _refundOrCredit(request.depositor, request.assets);
      emit DepositSkipped(address(vault), request.depositor, request.receiver, request.assets, seq);
      return;
    }

    collateralToken.forceApprove(address(vault), request.assets);

    try vault.deposit(request.assets, request.receiver) returns (uint256 sharesMinted) {
      // The vault sees `msg.sender = this parking lot` on the forwarded deposit
      // and records the parking lot's anti-JIT clock. Correct that here by
      // recording the ORIGINAL depositor's clock via the validator's parking-
      // lot-scoped entry point. Without this, the depositor's next direct
      // withdrawal would hit the "no recorded deposit → fee fires" branch of
      // `calculateWithdrawalFees` even though they had already deposited.
      IEmberVaultValidator validator = IEmberVault(address(vault)).vaultValidator();
      if (address(validator) != address(0)) {
        validator.recordDepositFor(address(vault), request.depositor, block.timestamp * 1000);
      }
      emit DepositForwarded(
        address(vault),
        request.depositor,
        request.receiver,
        request.assets,
        sharesMinted,
        seq
      );
    } catch {
      // Vault rejected the deposit (blacklist / paused / max TVL / not the parking lot): clear the
      // dangling approval and refund the depositor so the queue keeps moving. The refund itself
      // must NOT be allowed to revert — otherwise an undeliverable refund (e.g. a token-level
      // blacklist on the depositor) at the FIFO head would wedge the entire queue. _refundOrCredit
      // pays out when it can and records a {claimable} pull-payment when it can't, never reverting.
      collateralToken.forceApprove(address(vault), 0);
      _refundOrCredit(request.depositor, request.assets);
      emit DepositSkipped(address(vault), request.depositor, request.receiver, request.assets, seq);
    }
  }

  /// @dev Pays `assets` of collateral to `to` now; if that transfer cannot be delivered for any
  ///      reason (token-level blacklist on `to`, a reverting receiver hook, or a `false` return),
  ///      the amount is instead recorded as a {claimable} pull-payment and `RefundCredited` is
  ///      emitted. Never reverts, so callers (the FIFO processor and cancel) can always advance.
  ///      Uses a low-level call rather than SafeERC20 so a failure is swallowed, not bubbled; the
  ///      success check mirrors SafeERC20 (empty return data == success). Return data shorter than
  ///      a word (1–31 bytes) is treated as a failed transfer rather than decoded, so a
  ///      non-compliant token cannot make this helper itself revert (which would re-wedge the FIFO
  ///      queue) — the guarantee that this function never reverts is therefore total.
  function _refundOrCredit(address to, uint256 assets) private {
    if (assets == 0) return;
    (bool success, bytes memory ret) = address(collateralToken).call(
      abi.encodeWithSelector(IERC20.transfer.selector, to, assets)
    );
    if (success && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))))) {
      return;
    }
    unchecked {
      claimable[to] += assets;
    }
    emit RefundCredited(address(vault), to, assets);
  }

  // ============ Views ============

  /// @notice Returns the pending request at `index` (0-based from the queue head). Note: like the
  ///         processing loop, this includes slots that were cancelled but not yet skipped (their
  ///         `depositor` is zero).
  function getPendingDeposit(uint256 index) external view returns (DepositRequest memory) {
    uint256 seq = queueStartIndex + index + 1; // head is the last consumed seq; +1 = first pending
    if (seq > sequenceNumber) revert IndexOutOfBounds();
    return depositRequests[seq];
  }

  /// @notice Number of unprocessed request SLOTS still in the queue (head..tail), including any
  ///         cancelled-but-not-yet-swept entries (whose `depositor` is zero). This is the cheap
  ///         O(1) raw count; for the real backlog excluding cancelled slots use
  ///         {getLivePendingDepositsCount}.
  function getPendingDepositsLength() external view returns (uint256) {
    return sequenceNumber - queueStartIndex;
  }

  /// @notice Real backlog: count of pending requests that are still LIVE (not cancelled), i.e. the
  ///         number the operator will actually forward. Excludes cancelled-but-not-yet-swept slots
  ///         that {getPendingDepositsLength} includes.
  /// @dev O(n) over the pending range — intended for off-chain reads (eth_call), not on-chain use.
  function getLivePendingDepositsCount() external view returns (uint256 count) {
    uint256 tail = sequenceNumber;
    for (uint256 seq = queueStartIndex + 1; seq <= tail; ) {
      if (depositRequests[seq].depositor != address(0)) {
        unchecked {
          count++;
        }
      }
      unchecked {
        seq++;
      }
    }
  }

  // ============ Internal ============

  function _nowMs() internal view returns (uint256) {
    return block.timestamp * 1000;
  }

  function version() external pure virtual returns (string memory) {
    return "v1.1.0";
  }

  /// @dev Owner-gated UUPS upgrade hook. Because this contract holds live user escrow, an upgrade
  ///      can move those funds — so the owner MUST be a Timelock and/or multisig (see the contract
  ///      NatSpec "TRUST ASSUMPTION"). UUPSUpgradeable emits `Upgraded(newImplementation)`.
  function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
