// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IEmberVaultToken
 * @notice Minimal view of an Ember vault (which is itself the receipt ERC-20) as the CCIP
 *         token pool needs to see it.
 * @dev Deliberately does NOT extend IERC20. `TokenPool`'s constructor expects the IERC20
 *      declared under CCIP's own OpenZeppelin alias, and two identical interfaces from
 *      different files are distinct Solidity types. Keeping this interface free of IERC20
 *      lets `EmberTokenPool` do the cast at the one place it matters.
 *
 *      `bridgeMint` / `bridgeBurn` mirror {IBridgeable}; the rest are the vault's public
 *      getters the pool relies on.
 */
interface IEmberVaultToken {
  /// @notice Mints `amount` to `to`. Only callable by the vault's configured bridge adapter.
  function bridgeMint(address to, uint256 amount) external;

  /// @notice Burns `amount` from `from`. Only callable by the vault's configured bridge adapter.
  function bridgeBurn(address from, uint256 amount) external;

  /// @notice The address currently authorized to call bridgeMint / bridgeBurn.
  function bridgeAdapter() external view returns (address);

  /// @notice The protocol config this vault reads policy (pause, blacklist) from.
  function protocolConfig() external view returns (address);

  /// @notice ERC-20 decimals, validated against the pool's configured decimals at construction.
  function decimals() external view returns (uint8);

  /// @notice Minimum per-bridge-operation amount (0 = no minimum).
  function minBridgeAmount() external view returns (uint256);

  /// @notice Maximum per-bridge-operation amount (0 = no maximum).
  function maxBridgeAmount() external view returns (uint256);
}
