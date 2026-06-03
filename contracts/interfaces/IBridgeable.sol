// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IBridgeable
 * @notice Interface for tokens that support bridge mint/burn operations
 */
interface IBridgeable {
  /// @notice Mints tokens to a recipient (only callable by authorized bridge adapter)
  /// @param to The recipient address
  /// @param amount The amount to mint
  function bridgeMint(address to, uint256 amount) external;

  /// @notice Burns tokens from an account (only callable by authorized bridge adapter)
  /// @param from The account to burn from
  /// @param amount The amount to burn
  function bridgeBurn(address from, uint256 amount) external;

  /// @notice Returns the minimum bridge amount (0 = no minimum)
  function minBridgeAmount() external view returns (uint256);

  /// @notice Returns the maximum bridge amount (0 = no maximum)
  function maxBridgeAmount() external view returns (uint256);
}
