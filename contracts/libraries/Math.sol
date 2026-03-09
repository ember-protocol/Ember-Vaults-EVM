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

/**
 * @title FixedPointMath
 * @dev Fixed-point math library for vault calculations
 * @notice All numbers use uint256 with BASE = 1e18 for fixed-point precision
 */
library FixedPointMath {
  // === Constants ===

  /// @notice Base unit for fixed-point arithmetic (1e18)
  uint256 internal constant BASE = 1e18;

  // === Internal Functions ===

  /// @notice Multiplies two uint256 values with fixed-point precision
  /// @param a The first value to multiply
  /// @param b The second value to multiply
  /// @return The result of the multiplication (a * b / BASE)
  /// @dev Reverts with Overflow if the multiplication overflows uint256
  function mul(uint256 a, uint256 b) internal pure returns (uint256) {
    // Early return for zero (saves gas)
    if (a == 0) {
      return 0;
    }

    // Check if a * b would overflow
    if (b > type(uint256).max / a) revert Overflow();

    // Division is safe after overflow check
    unchecked {
      return (a * b) / BASE;
    }
  }

  /// @notice Divides two uint256 values with fixed-point precision
  /// @param a The dividend
  /// @param b The divisor
  /// @return The result of the division (a * BASE / b)
  /// @dev Reverts with DivisionByZero if the divisor is zero
  /// @dev Reverts with Overflow if the result overflows uint256
  function div(uint256 a, uint256 b) internal pure returns (uint256) {
    if (b == 0) revert DivisionByZero();
    // Check for potential overflow: a * BASE might overflow
    if (a > type(uint256).max / BASE) revert Overflow();

    // Multiplication and division are safe after overflow check
    unchecked {
      return (a * BASE) / b;
    }
  }

  /// @notice Calculates the absolute difference between two uint256 values
  /// @param a The first value
  /// @param b The second value
  /// @return The absolute difference between the two values
  function diffAbs(uint256 a, uint256 b) internal pure returns (uint256) {
    // Subtraction is safe since we check which is larger first
    unchecked {
      return a > b ? a - b : b - a;
    }
  }

  /// @notice Calculates the percentage change from a to b
  /// @param a The first value (base value)
  /// @param b The second value (new value)
  /// @return The percentage difference between the two values (|a - b| * BASE / a)
  /// @dev Reverts with DivisionByZero if a is zero
  /// @dev Reverts with Overflow if the result overflows uint256
  function percentChangeFrom(uint256 a, uint256 b) internal pure returns (uint256) {
    return div(diffAbs(a, b), a);
  }

  /// @notice Divides two uint256 values and rounds up to the nearest integer
  /// @param a The dividend
  /// @param b The divisor
  /// @return The result of the division rounded up (ceil(a * BASE / b))
  /// @dev Reverts with DivisionByZero if the divisor is zero
  /// @dev Reverts with Overflow if the result overflows uint256
  /// @dev Uses the efficient ceiling formula: ceil(a/b) = (a + b - 1) / b
  function divCeil(uint256 a, uint256 b) internal pure returns (uint256) {
    if (b == 0) revert DivisionByZero();
    // Check for potential overflow: a * BASE might overflow
    if (a > type(uint256).max / BASE) revert Overflow();

    // All operations are safe after overflow check
    unchecked {
      uint256 numerator = a * BASE;
      // Check for overflow in ceiling calculation: numerator + b - 1
      if (numerator > type(uint256).max - (b - 1)) revert Overflow();
      // Use ceiling formula: (numerator + b - 1) / b
      return (numerator + b - 1) / b;
    }
  }
}
