// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {
  IERC20Metadata,
  IERC20
} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

import { OApp, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OAppOptionsType3 } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OAppOptionsType3.sol";
import { OAppPreCrimeSimulator } from "@layerzerolabs/oapp-evm/contracts/precrime/OAppPreCrimeSimulator.sol";
import { IOAppMsgInspector } from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppMsgInspector.sol";

import {
  IOFT,
  SendParam,
  OFTLimit,
  OFTReceipt,
  OFTFeeDetail,
  MessagingReceipt,
  MessagingFee
} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { OFTMsgCodec } from "@layerzerolabs/oft-evm/contracts/libs/OFTMsgCodec.sol";

import { IBridgeable } from "./interfaces/IBridgeable.sol";
import { IEmberProtocolConfig } from "./interfaces/IEmberProtocolConfig.sol";

/**
 * @title EmberVaultMintBurnOFTAdapter
 * @notice OFT Adapter that uses mint/burn for cross-chain receipt token bridging
 * @dev This adapter is designed for unified vault architectures where:
 *      - Multiple vaults exist across different chains (EVM, Sui, etc.)
 *      - All vaults share the same underlying deposit token
 *      - Receipt tokens can be freely moved between chains
 *      - 1:1 backing is computed across all vaults combined
 *
 * @dev Flow:
 *      - Send (EVM → other chain): Burns receipt tokens on EVM
 *      - Receive (other chain → EVM): Mints receipt tokens on EVM
 *
 * @dev The vault contract must implement IBridgeable interface and authorize this adapter
 */
contract EmberVaultMintBurnOFTAdapter is
  IOFT,
  OApp,
  OAppPreCrimeSimulator,
  OAppOptionsType3,
  Pausable
{
  using SafeERC20 for IERC20;
  using OFTMsgCodec for bytes;
  using OFTMsgCodec for bytes32;

  // ============ Constants ============
  uint16 public constant SEND = 1;

  /// @notice Burn-style fallback recipient used when an inbound message targets address(0).
  ///         Aligns with the standard MintBurnOFTAdapter pattern: never revert on _credit so
  ///         in-flight LayerZero messages cannot be bricked.
  address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

  // ============ Custom Errors ============
  error ComposeNotSupported();
  error InvalidMsgInspector();
  error Unauthorized();
  error ZeroAddress();

  // ============ Immutables ============
  /// @notice The bridgeable token (EmberVault) that supports mint/burn
  IBridgeable public immutable bridgeableToken;

  /// @notice The token as IERC20 for balance checks and metadata
  IERC20 internal immutable innerToken;

  /// @notice Conversion rate between local decimals and shared decimals
  uint256 public immutable decimalConversionRate;

  /// @notice Protocol config that owns the guardian role. Reads `guardian()`
  ///         at call time so rotation/clear takes effect immediately on this
  ///         adapter without redeployment.
  IEmberProtocolConfig public immutable protocolConfig;

  // ============ Modifiers ============
  /// @notice Restricts to the protocol guardian. If guardian is address(0)
  ///         (unset) this naturally rejects all callers.
  modifier onlyGuardian() {
    if (msg.sender != protocolConfig.guardian()) revert Unauthorized();
    _;
  }

  // ============ State Variables ============
  /// @notice Optional message inspector for validating messages
  address public msgInspector;

  // ============ Events ============
  event MsgInspectorSet(address inspector);

  /**
   * @notice Constructs the EmberVaultMintBurnOFTAdapter
   * @param _token The address of the EmberVault (must implement IBridgeable)
   * @param _lzEndpoint The LayerZero V2 endpoint address
   * @param _delegate The delegate capable of making OApp configurations
   * @param _protocolConfig Address of EmberProtocolConfig (source of guardian role)
   */
  constructor(
    address _token,
    address _lzEndpoint,
    address _delegate,
    address _protocolConfig
  ) OApp(_lzEndpoint, _delegate) Ownable(_delegate) {
    if (_protocolConfig == address(0)) revert ZeroAddress();
    uint8 localDecimals = IERC20Metadata(_token).decimals();
    if (localDecimals < sharedDecimals()) revert InvalidLocalDecimals();
    decimalConversionRate = 10 ** (localDecimals - sharedDecimals());
    bridgeableToken = IBridgeable(_token);
    innerToken = IERC20(_token);
    protocolConfig = IEmberProtocolConfig(_protocolConfig);
  }

  // ============ External View Functions ============

  /**
   * @notice Returns the address of the underlying receipt token (vault)
   * @return The token address
   */
  function token() public view returns (address) {
    return address(innerToken);
  }

  /**
   * @notice Indicates whether approval is required for the token
   * @return requiresApproval False since we burn directly (no transfer to adapter)
   * @dev Note: User still needs to approve if the burn function uses transferFrom internally
   */
  function approvalRequired() external pure virtual returns (bool) {
    return false;
  }

  /**
   * @notice Returns the OFT interface ID and version
   * @return interfaceId The interface ID (0x02e49c2c)
   * @return version The version number
   */
  function oftVersion() external pure virtual returns (bytes4 interfaceId, uint64 version) {
    return (type(IOFT).interfaceId, 1);
  }

  /**
   * @notice Returns the shared decimals used for cross-chain transfers
   * @return The shared decimals (6 by default for max uint64 compatibility)
   */
  function sharedDecimals() public view virtual returns (uint8) {
    return 6;
  }

  /**
   * @notice Provides a quote for OFT parameters without sending
   * @param _sendParam The send parameters
   * @return oftLimit The OFT limits based on vault's bridge limits
   * @return oftFeeDetails The fee details (empty in default implementation)
   * @return oftReceipt The expected receipt amounts
   */
  function quoteOFT(
    SendParam calldata _sendParam
  )
    external
    view
    virtual
    returns (
      OFTLimit memory oftLimit,
      OFTFeeDetail[] memory oftFeeDetails,
      OFTReceipt memory oftReceipt
    )
  {
    // Query vault's bridge limits for accurate quote
    uint256 minAmountLD = bridgeableToken.minBridgeAmount();
    uint256 vaultMaxAmount = bridgeableToken.maxBridgeAmount();
    // Send burns from the sender, so the true upper bound is also bounded by total supply.
    // 0 means "no per-tx cap" — use total supply as the effective vault max in that case.
    uint256 supplyCap = IERC20(address(bridgeableToken)).totalSupply();
    uint256 effectiveVaultMax = vaultMaxAmount == 0 ? type(uint256).max : vaultMaxAmount;
    uint256 maxAmountLD = Math.min(effectiveVaultMax, supplyCap);
    oftLimit = OFTLimit(minAmountLD, maxAmountLD);

    oftFeeDetails = new OFTFeeDetail[](0);

    (uint256 amountSentLD, uint256 amountReceivedLD) = _debitView(
      _sendParam.amountLD,
      _sendParam.minAmountLD,
      _sendParam.dstEid
    );
    oftReceipt = OFTReceipt(amountSentLD, amountReceivedLD);
  }

  /**
   * @notice Provides a quote for the messaging fee
   * @param _sendParam The send parameters
   * @param _payInLzToken Whether to pay in LZ token
   * @return msgFee The messaging fee
   */
  function quoteSend(
    SendParam calldata _sendParam,
    bool _payInLzToken
  ) external view virtual returns (MessagingFee memory msgFee) {
    (, uint256 amountReceivedLD) = _debitView(
      _sendParam.amountLD,
      _sendParam.minAmountLD,
      _sendParam.dstEid
    );
    (bytes memory message, bytes memory options) = _buildMsgAndOptions(
      _sendParam,
      amountReceivedLD
    );
    return _quote(_sendParam.dstEid, message, options, _payInLzToken);
  }

  // ============ External Functions ============

  /**
   * @notice Sends tokens to another chain by burning on source
   * @param _sendParam The send parameters
   * @param _fee The messaging fee
   * @param _refundAddress The address to receive refunds
   * @return msgReceipt The messaging receipt
   * @return oftReceipt The OFT receipt
   */
  function send(
    SendParam calldata _sendParam,
    MessagingFee calldata _fee,
    address _refundAddress
  )
    external
    payable
    virtual
    whenNotPaused
    returns (MessagingReceipt memory msgReceipt, OFTReceipt memory oftReceipt)
  {
    return _send(_sendParam, _fee, _refundAddress);
  }

  /**
   * @notice Sets the message inspector address
   * @param _msgInspector The inspector address (0x0 to disable)
   * @dev Validates that the address is a contract. Owner must ensure it implements IOAppMsgInspector.
   */
  function setMsgInspector(address _msgInspector) public virtual onlyOwner {
    if (_msgInspector != address(0)) {
      uint256 codeSize;
      assembly {
        codeSize := extcodesize(_msgInspector)
      }
      if (codeSize == 0) revert InvalidMsgInspector();
    }
    msgInspector = _msgInspector;
    emit MsgInspectorSet(_msgInspector);
  }

  /**
   * @notice Pauses outgoing bridge operations (send only)
   * @dev Only callable by the protocol guardian (`EmberProtocolConfig.guardian()`).
   *      The owner is intentionally excluded — pause is an emergency action
   *      and must stay instant even after the adapter owner is moved behind
   *      the timelock. To rotate who can pause, the owner of the protocol
   *      config calls `setGuardian` (the guardian is read at call time, so
   *      rotation takes effect immediately without redeploying the adapter).
   */
  function pause() external onlyGuardian {
    _pause();
  }

  /**
   * @notice Unpauses bridge operations
   * @dev Only callable by the protocol guardian (see `pause` for rationale).
   */
  function unpause() external onlyGuardian {
    _unpause();
  }

  // ============ Internal Functions ============

  /**
   * @dev Internal send implementation - burns tokens and sends cross-chain message
   */
  function _send(
    SendParam calldata _sendParam,
    MessagingFee calldata _fee,
    address _refundAddress
  ) internal virtual returns (MessagingReceipt memory msgReceipt, OFTReceipt memory oftReceipt) {
    (uint256 amountSentLD, uint256 amountReceivedLD) = _debit(
      msg.sender,
      _sendParam.amountLD,
      _sendParam.minAmountLD,
      _sendParam.dstEid
    );

    (bytes memory message, bytes memory options) = _buildMsgAndOptions(
      _sendParam,
      amountReceivedLD
    );

    msgReceipt = _lzSend(_sendParam.dstEid, message, options, _fee, _refundAddress);
    oftReceipt = OFTReceipt(amountSentLD, amountReceivedLD);

    emit OFTSent(msgReceipt.guid, _sendParam.dstEid, msg.sender, amountSentLD, amountReceivedLD);
  }

  /**
   * @dev Builds the LayerZero message and options
   * @notice Compose messages are not supported - only simple token transfers allowed
   */
  function _buildMsgAndOptions(
    SendParam calldata _sendParam,
    uint256 _amountLD
  ) internal view virtual returns (bytes memory message, bytes memory options) {
    // Reject compose messages - not supported for security reasons
    if (_sendParam.composeMsg.length > 0) revert ComposeNotSupported();

    (message, ) = OFTMsgCodec.encode(
      _sendParam.to,
      _toSD(_amountLD),
      bytes("") // Always empty compose
    );
    options = combineOptions(_sendParam.dstEid, SEND, _sendParam.extraOptions);

    address inspector = msgInspector;
    if (inspector != address(0)) IOAppMsgInspector(inspector).inspect(message, options);
  }

  /**
   * @dev Handles incoming LayerZero messages - mints tokens on receive
   * @notice Compose messages are rejected for security - only simple transfers allowed
   */
  function _lzReceive(
    Origin calldata _origin,
    bytes32 _guid,
    bytes calldata _message,
    address /*_executor*/,
    bytes calldata /*_extraData*/
  ) internal virtual override {
    // Defense in depth: reject composed messages even if somehow received
    if (_message.isComposed()) revert ComposeNotSupported();

    address toAddress = _message.sendTo().bytes32ToAddress();
    uint256 amountReceivedLD = _credit(toAddress, _toLD(_message.amountSD()), _origin.srcEid);

    emit OFTReceived(_guid, _origin.srcEid, toAddress, amountReceivedLD);
  }

  /**
   * @dev Simulated receive for PreCrime
   */
  function _lzReceiveSimulate(
    Origin calldata _origin,
    bytes32 _guid,
    bytes calldata _message,
    address _executor,
    bytes calldata _extraData
  ) internal virtual override {
    _lzReceive(_origin, _guid, _message, _executor, _extraData);
  }

  /**
   * @dev Checks if a peer is trusted
   */
  function isPeer(uint32 _eid, bytes32 _peer) public view virtual override returns (bool) {
    return peers[_eid] == _peer;
  }

  /**
   * @dev Debits (BURNS) tokens from the sender for cross-chain transfer
   * @param _from The address to burn from
   * @param _amountLD The amount in local decimals
   * @param _minAmountLD The minimum amount (slippage protection)
   * @param _dstEid The destination endpoint ID
   * @return amountSentLD The amount sent in local decimals
   * @return amountReceivedLD The amount received in local decimals on remote
   */
  function _debit(
    address _from,
    uint256 _amountLD,
    uint256 _minAmountLD,
    uint32 _dstEid
  ) internal virtual returns (uint256 amountSentLD, uint256 amountReceivedLD) {
    (amountSentLD, amountReceivedLD) = _debitView(_amountLD, _minAmountLD, _dstEid);

    // BURN tokens from the sender
    bridgeableToken.bridgeBurn(_from, amountSentLD);
  }

  /**
   * @dev Credits (MINTS) tokens to the recipient from cross-chain transfer
   * @param _to The address to mint to
   * @param _amountLD The amount in local decimals
   * @return amountReceivedLD The amount received in local decimals
   */
  function _credit(
    address _to,
    uint256 _amountLD,
    uint32 /* _srcEid - unused */
  ) internal virtual returns (uint256 amountReceivedLD) {
    // Redirect zero-address recipients to 0xdead so an inbound message cannot brick itself.
    // The vault's bridgeMint reverts on address(0); reverting here would lock funds in flight.
    if (_to == address(0)) _to = DEAD_ADDRESS;

    // MINT tokens to the recipient
    // Note: Not paused here - allow in-flight messages to complete even when paused
    bridgeableToken.bridgeMint(_to, _amountLD);
    return _amountLD;
  }

  /**
   * @dev View function to calculate debit amounts
   */
  function _debitView(
    uint256 _amountLD,
    uint256 _minAmountLD,
    uint32 /*_dstEid*/
  ) internal view virtual returns (uint256 amountSentLD, uint256 amountReceivedLD) {
    amountSentLD = _removeDust(_amountLD);
    amountReceivedLD = amountSentLD;

    if (amountReceivedLD < _minAmountLD) {
      revert SlippageExceeded(amountReceivedLD, _minAmountLD);
    }
  }

  /**
   * @dev Removes dust from amount for cross-chain compatibility
   */
  function _removeDust(uint256 _amountLD) internal view virtual returns (uint256 amountLD) {
    return (_amountLD / decimalConversionRate) * decimalConversionRate;
  }

  /**
   * @dev Converts from shared decimals to local decimals
   */
  function _toLD(uint64 _amountSD) internal view virtual returns (uint256 amountLD) {
    return _amountSD * decimalConversionRate;
  }

  /**
   * @dev Converts from local decimals to shared decimals
   */
  function _toSD(uint256 _amountLD) internal view virtual returns (uint64 amountSD) {
    uint256 _amountSD = _amountLD / decimalConversionRate;
    if (_amountSD > type(uint64).max) revert AmountSDOverflowed(_amountSD);
    return uint64(_amountSD);
  }
}
