/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.

  This source code is provided for transparency and verification only.
  Use, modification, reproduction, or redeployment of this code 
  requires prior written permission from the Ember Protocol Inc.
*/

pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IWETH
 * @notice Interface for Wrapped Ether (WETH) contract
 * @dev Extends IERC20 with ETH wrapping/unwrapping functions
 */
interface IWETH is IERC20 {
  /**
   * @notice Deposit ETH to receive WETH
   */
  function deposit() external payable;

  /**
   * @notice Withdraw WETH to receive ETH
   * @param amount Amount of WETH to unwrap
   */
  function withdraw(uint256 amount) external;
}
