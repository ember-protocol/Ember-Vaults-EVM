/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.

  This source code is provided for transparency and verification only.
  Use, modification, reproduction, or redeployment of this code 
  requires prior written permission from the Ember Protocol Inc.
*/

pragma solidity ^0.8.22;

import { FixedPointMath } from "../libraries/Math.sol";

/**
 * @title FixedPointMathWrapper
 * @dev Wrapper contract for testing FixedPointMath library functions
 * @notice This contract is only for testing purposes
 */
contract FixedPointMathWrapper {
  /// @notice Base unit for fixed-point arithmetic (1e18)
  function BASE() external pure returns (uint256) {
    return FixedPointMath.BASE;
  }

  /// @notice Multiplies two uint256 values with fixed-point precision
  function mul(uint256 a, uint256 b) external pure returns (uint256) {
    return FixedPointMath.mul(a, b);
  }

  /// @notice Divides two uint256 values with fixed-point precision
  function div(uint256 a, uint256 b) external pure returns (uint256) {
    return FixedPointMath.div(a, b);
  }

  /// @notice Calculates the absolute difference between two uint256 values
  function diffAbs(uint256 a, uint256 b) external pure returns (uint256) {
    return FixedPointMath.diffAbs(a, b);
  }

  /// @notice Calculates the percentage change from a to b
  function percentChangeFrom(uint256 a, uint256 b) external pure returns (uint256) {
    return FixedPointMath.percentChangeFrom(a, b);
  }

  /// @notice Divides two uint256 values and rounds up to the nearest integer
  function divCeil(uint256 a, uint256 b) external pure returns (uint256) {
    return FixedPointMath.divCeil(a, b);
  }
}
