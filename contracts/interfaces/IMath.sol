/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.

  This source code is provided for transparency and verification only.
  Use, modification, reproduction, or redeployment of this code 
  requires prior written permission from the Ember Protocol Inc.
*/

pragma solidity ^0.8.22;

// Custom errors
error Overflow();
error DivisionByZero();

/// @title Math Interface
/// @notice Describes the functions exposed by `Math` contract for fixed-point arithmetic
interface IMath {
  /// @dev Replicates the initializer that must be called for upgradeable proxies.
  /// @param initialOwner The address that will own the contract
  function initialize(address initialOwner) external;

  /// @notice Base unit for fixed-point arithmetic (1e18)
  /// @return The BASE constant value
  function BASE() external pure returns (uint256);

  /// @notice Multiplies two uint256 values with fixed-point precision
  /// @param a The first value to multiply
  /// @param b The second value to multiply
  /// @return The result of the multiplication (a * b / BASE)
  /// @dev Reverts with Overflow if the multiplication overflows uint256
  function mul(uint256 a, uint256 b) external pure returns (uint256);

  /// @notice Divides two uint256 values with fixed-point precision
  /// @param a The dividend
  /// @param b The divisor
  /// @return The result of the division (a * BASE / b)
  /// @dev Reverts with DivisionByZero if the divisor is zero
  /// @dev Reverts with Overflow if the result overflows uint256
  function div(uint256 a, uint256 b) external pure returns (uint256);

  /// @notice Calculates the absolute difference between two uint256 values
  /// @param a The first value
  /// @param b The second value
  /// @return The absolute difference between the two values
  function diffAbs(uint256 a, uint256 b) external pure returns (uint256);

  /// @notice Calculates the percentage change from a to b
  /// @param a The first value (base value)
  /// @param b The second value (new value)
  /// @return The percentage difference between the two values (|a - b| * BASE / a)
  /// @dev Reverts with DivisionByZero if a is zero
  /// @dev Reverts with Overflow if the result overflows uint256
  function percentChangeFrom(uint256 a, uint256 b) external pure returns (uint256);

  /// @notice Divides two uint256 values and rounds up to the nearest integer
  /// @param a The dividend
  /// @param b The divisor
  /// @return The result of the division rounded up (ceil(a * BASE / b))
  /// @dev Reverts with DivisionByZero if the divisor is zero
  /// @dev Reverts with Overflow if the result overflows uint256
  /// @dev Uses the efficient ceiling formula: ceil(a/b) = (a + b - 1) / b
  function divCeil(uint256 a, uint256 b) external pure returns (uint256);
}
