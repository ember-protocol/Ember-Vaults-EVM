// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {
  IOFT,
  SendParam,
  OFTLimit,
  OFTReceipt,
  OFTFeeDetail,
  MessagingReceipt,
  MessagingFee
} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { IBridgeable } from "./IBridgeable.sol";

/**
 * @title IEmberVaultMintBurnOFTAdapter
 * @notice Interface for EmberVaultMintBurnOFTAdapter
 * @dev This adapter enables cross-chain bridging of EmberVault receipt tokens
 *      using a mint/burn model via LayerZero V2
 */
interface IEmberVaultMintBurnOFTAdapter is IOFT {
  // ============ Events ============

  /**
   * @notice Emitted when the message inspector is updated
   * @param inspector The new inspector address (0x0 to disable)
   */
  event MsgInspectorSet(address inspector);

  // ============ View Functions ============

  /**
   * @notice Returns the bridgeable token (EmberVault) that supports mint/burn
   * @return The IBridgeable interface of the vault
   */
  function bridgeableToken() external view returns (IBridgeable);

  /**
   * @notice Returns the conversion rate between local decimals and shared decimals
   * @return The decimal conversion rate (10 ** (localDecimals - sharedDecimals))
   */
  function decimalConversionRate() external view returns (uint256);

  /**
   * @notice Returns the current message inspector address
   * @return The inspector address (0x0 if disabled)
   */
  function msgInspector() external view returns (address);

  /**
   * @notice Returns the shared decimals used for cross-chain transfers
   * @return The shared decimals (6 by default for max uint64 compatibility)
   */
  function sharedDecimals() external view returns (uint8);

  /**
   * @notice Checks if a peer is trusted for a given endpoint ID
   * @param _eid The endpoint ID
   * @param _peer The peer address as bytes32
   * @return True if the peer is trusted
   */
  function isPeer(uint32 _eid, bytes32 _peer) external view returns (bool);

  // ============ External Functions ============

  /**
   * @notice Sets the message inspector address
   * @param _msgInspector The inspector address (0x0 to disable)
   * @dev Only callable by owner
   */
  function setMsgInspector(address _msgInspector) external;
}
