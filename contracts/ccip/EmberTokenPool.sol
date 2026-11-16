// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ITypeAndVersion } from "@chainlink/contracts/src/v0.8/shared/interfaces/ITypeAndVersion.sol";
import { Pool } from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";
import { TokenPool } from "@chainlink/contracts-ccip/contracts/pools/TokenPool.sol";
// Must come from CCIP's own OpenZeppelin alias: TokenPool's constructor takes that exact
// IERC20 declaration, and the same interface from a different file is a different type.
import { IERC20 } from "@openzeppelin/contracts@5.3.0/token/ERC20/IERC20.sol";

import { IEmberProtocolConfig } from "../interfaces/IEmberProtocolConfig.sol";
import { IEmberVaultToken } from "../interfaces/IEmberVaultToken.sol";

/**
 * @title EmberTokenPool
 * @notice CCIP burn/mint token pool for Ember vault share tokens (e.g. pALPHA).
 *
 * @dev Drop-in replacement for {EmberVaultMintBurnOFTAdapter}: this pool must be set as the
 *      vault's `bridgeAdapter` so it is authorized to call `bridgeBurn` / `bridgeMint`.
 *
 *      Outbound: the CCIP onRamp has already transferred the sender's shares to this pool by
 *      the time `lockOrBurn` runs, so the pool burns its own balance.
 *      Inbound: the offRamp calls `releaseOrMint`, which mints straight to the receiver.
 *
 *      All CCIP security validation — onRamp/offRamp authorization via the Router, RMN curse
 *      checks, remote-pool verification, decimals conversion and rate limiting — is inherited
 *      from {TokenPool}. Do not override the external entrypoints without calling `super`.
 *
 *      Derived from smartcontractkit/ember-custom-token-pool, with two Ember-specific additions
 *      documented below.
 */
contract EmberTokenPool is TokenPool, ITypeAndVersion {
  /// @notice Thrown when a blacklisted account attempts to bridge shares out.
  error SenderBlacklisted(address sender);

  /// @notice Thrown when the destination-chain recipient is blacklisted at the protocol level.
  error ReceiverBlacklisted(address receiver);

  /**
   * @notice Emitted on the source chain for every outbound bridge.
   * @dev Exists because neither CCIP's `LockedOrBurned` nor the vault's `BridgeBurn` identifies
   *      the user: the former's `sender` is the onRamp, and the latter's `from` is this pool
   *      (we burn our own balance). Indexers must attribute the transfer to `originalSender`.
   *
   *      Emitting this here rather than reading the ramp events keeps user attribution stable
   *      across the CCIP 1.6 -> 2.0 ramp upgrade, which changes `CCIPMessageSent`'s shape.
   * @param remoteChainSelector Destination chain selector.
   * @param originalSender The account that called `Router.ccipSend` — the real user.
   * @param receiver Destination-chain recipient, ABI-encoded (32 bytes for EVM).
   * @param amountGross Amount taken from the sender, before any pool transfer fee.
   * @param amountBurned Amount actually burned, i.e. what the destination will mint.
   */
  event EmberBridgeSent(
    uint64 indexed remoteChainSelector,
    address indexed originalSender,
    bytes receiver,
    uint256 amountGross,
    uint256 amountBurned
  );

  /**
   * @notice Emitted on the destination chain for every inbound bridge.
   * @param remoteChainSelector Source chain selector.
   * @param receiver Local recipient of the minted shares.
   * @param originalSender Source-chain sender, encoded in the source chain's address format.
   * @param amount Amount minted locally, after any decimals conversion.
   */
  event EmberBridgeReceived(
    uint64 indexed remoteChainSelector,
    address indexed receiver,
    bytes originalSender,
    uint256 amount
  );

  /**
   * @notice Emitted when a transfer fee is retained by this pool, in vault shares.
   * @dev On the IPoolV2 path `destTokenAmount` can be below the gross taken from the sender; the
   *      difference stays here as vault shares and is withdrawn later via `withdrawFeeTokens`.
   *      Nothing else records it: `EmberBridgeSent` reports gross and burned, the vault's
   *      `BridgeBurn` reports only the burned part, and the eventual payout is a plain ERC-20
   *      `Transfer` the indexer cannot attribute. Those shares were never bridged, so they
   *      legitimately remain in local supply — this event is what makes them reconcilable.
   * @param remoteChainSelector Destination chain the fee was charged on.
   * @param amount Shares retained by this pool.
   */
  event EmberBridgeFeeRetained(uint64 indexed remoteChainSelector, uint256 amount);

  constructor(
    IEmberVaultToken token,
    uint8 localTokenDecimals,
    address advancedPoolHooks,
    address rmnProxy,
    address router
  ) TokenPool(IERC20(address(token)), localTokenDecimals, advancedPoolHooks, rmnProxy, router) {}

  function typeAndVersion() external pure virtual override returns (string memory) {
    return "EmberBurnMintTokenPool 1.0.0";
  }

  // ================================================================
  // │                        Lock or Burn                          │
  // ================================================================

  /// @inheritdoc TokenPool
  /// @dev IPoolV2 entrypoint, used by CCIP 2.0 ramps.
  function lockOrBurn(
    Pool.LockOrBurnInV1 calldata lockOrBurnIn,
    bytes4 requestedFinalityConfig,
    bytes calldata tokenArgs
  ) public virtual override returns (Pool.LockOrBurnOutV1 memory out, uint256 destTokenAmount) {
    _enforceSendPolicy(lockOrBurnIn.originalSender, lockOrBurnIn.receiver);

    (out, destTokenAmount) = super.lockOrBurn(lockOrBurnIn, requestedFinalityConfig, tokenArgs);

    emit EmberBridgeSent({
      remoteChainSelector: lockOrBurnIn.remoteChainSelector,
      originalSender: lockOrBurnIn.originalSender,
      receiver: lockOrBurnIn.receiver,
      amountGross: lockOrBurnIn.amount,
      amountBurned: destTokenAmount
    });

    if (lockOrBurnIn.amount > destTokenAmount) {
      emit EmberBridgeFeeRetained(
        lockOrBurnIn.remoteChainSelector,
        lockOrBurnIn.amount - destTokenAmount
      );
    }
  }

  /// @inheritdoc TokenPool
  /// @dev IPoolV1 entrypoint, used by CCIP 1.6 ramps. Kept for lanes whose ramps have not moved
  ///      to 2.0; the production Ethereum <-> Pharos lanes run 2.0 OnRamps and therefore take the
  ///      IPoolV2 entrypoint above, not this one.
  ///      The legacy path charges no pool fee, so gross == burned.
  function lockOrBurn(
    Pool.LockOrBurnInV1 calldata lockOrBurnIn
  ) public virtual override returns (Pool.LockOrBurnOutV1 memory out) {
    _enforceSendPolicy(lockOrBurnIn.originalSender, lockOrBurnIn.receiver);

    out = super.lockOrBurn(lockOrBurnIn);

    emit EmberBridgeSent({
      remoteChainSelector: lockOrBurnIn.remoteChainSelector,
      originalSender: lockOrBurnIn.originalSender,
      receiver: lockOrBurnIn.receiver,
      amountGross: lockOrBurnIn.amount,
      amountBurned: lockOrBurnIn.amount
    });
  }

  /// @notice Burns shares held by this pool via the vault's `bridgeBurn`.
  /// @dev The onRamp transferred `amount` here before calling `lockOrBurn`.
  function _lockOrBurn(uint64, /* remoteChainSelector */ uint256 amount) internal virtual override {
    IEmberVaultToken(address(i_token)).bridgeBurn(address(this), amount);
  }

  // ================================================================
  // │                      Release or Mint                         │
  // ================================================================

  /// @inheritdoc TokenPool
  /// @dev The IPoolV1 entrypoint delegates here with default finality, so overriding this one
  ///      covers both ramp generations.
  function releaseOrMint(
    Pool.ReleaseOrMintInV1 calldata releaseOrMintIn,
    bytes4 requestedFinalityConfig
  ) public virtual override returns (Pool.ReleaseOrMintOutV1 memory out) {
    out = super.releaseOrMint(releaseOrMintIn, requestedFinalityConfig);

    emit EmberBridgeReceived({
      remoteChainSelector: releaseOrMintIn.remoteChainSelector,
      receiver: releaseOrMintIn.receiver,
      originalSender: releaseOrMintIn.originalSender,
      amount: out.destinationAmount
    });
  }

  /// @notice Mints shares to the receiver via the vault's `bridgeMint`.
  function _releaseOrMint(
    address receiver,
    uint256 amount,
    uint64 /* remoteChainSelector */
  ) internal virtual override {
    IEmberVaultToken(address(i_token)).bridgeMint(receiver, amount);
  }

  // ================================================================
  // │                          Blacklist                           │
  // ================================================================

  /**
   * @notice Every send-side policy the vault would have applied to a direct exit.
   * @dev All of it is enforced here rather than on arrival, matching the vault: `bridgeMint`
   *      deliberately applies no policy so an inbound message can never get stuck, which means
   *      anything not checked before the burn is not checked at all.
   *
   *      - Sender blacklist: restores the check `bridgeBurn` can no longer make, since under
   *        CCIP its `from` is this pool.
   *      - Receiver blacklist: without it a clean sender can name a blacklisted address as the
   *        destination recipient and the far side mints straight to it. Shares transfer freely,
   *        so that address can then pass them on and redeem.
   *
   *      The vault's withdrawal allow-list is deliberately NOT applied here. Bridging moves
   *      shares between chains rather than redeeming them, and the list is enforced where value
   *      actually leaves the system: `redeemShares`, `instantWithdraw`, and the AtomicLiquidity
   *      swap. Note the consequence — a holder barred from redeeming on this chain can bridge to
   *      one where the list is empty, or where they are listed, and redeem there.
   */
  function _enforceSendPolicy(address sender, bytes memory receiver) internal view {
    IEmberProtocolConfig config = IEmberProtocolConfig(
      IEmberVaultToken(address(i_token)).protocolConfig()
    );

    if (config.isAccountBlacklisted(sender)) revert SenderBlacklisted(sender);

    // An EVM recipient reaches us in one of two widths and both must be checked.
    //
    // CCIP 2.0's OnRamp normalises `receiver` to the destination family's own address width
    // before the pool ever sees it — `_validateDestChainAddress(receiver, addressBytesLength)`,
    // where addressBytesLength is 20 for EVM — so on a 2.0 EVM lane the receiver arrives as 20
    // RAW bytes, never as a 32-byte ABI word. A 1.6 ramp passes the 32-byte encoding through
    // untouched. Checking only the 32-byte shape therefore left the receiver blacklist dead on
    // exactly the lanes that run in production.
    //
    // Any other length belongs to a non-EVM family whose address space this blacklist does not
    // describe, so there is nothing to check rather than something to reject.
    address to;
    if (receiver.length == 32) {
      to = abi.decode(receiver, (address));
    } else if (receiver.length == 20) {
      // Raw 20 bytes, left-aligned in the word after the length slot. Load the word and shift
      // the 12 trailing bytes out, which is what abi.decode cannot do for an unpadded value.
      bytes20 raw;
      assembly {
        raw := mload(add(receiver, 32))
      }
      to = address(raw);
    } else {
      return;
    }

    if (config.isAccountBlacklisted(to)) revert ReceiverBlacklisted(to);
  }
}
