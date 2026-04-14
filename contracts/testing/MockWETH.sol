/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.

  This source code is provided for transparency and verification only.
  Use, modification, reproduction, or redeployment of this code 
  requires prior written permission from the Ember Protocol Inc.
*/

pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "../interfaces/IWETH.sol";

/**
 * @title MockWETH
 * @notice Mock Wrapped Ether (WETH) implementation for testing
 * @dev Implements IWETH interface with ERC20Permit support
 *
 * Features:
 * - Standard WETH functionality (wrap/unwrap ETH)
 * - ERC20Permit (EIP-2612) for gasless approvals
 * - Useful for testing EmberETHVault on testnets
 *
 * Note: Real WETH on mainnet does NOT support permit.
 *       This mock includes permit for comprehensive testing.
 */
contract MockWETH is ERC20, ERC20Permit, IWETH {
  event Deposit(address indexed dst, uint256 wad);
  event Withdrawal(address indexed src, uint256 wad);

  constructor() ERC20("Wrapped Ether", "WETH") ERC20Permit("Wrapped Ether") {}

  /**
   * @notice Deposit ETH to receive WETH
   * @dev Mints WETH tokens equal to msg.value
   */
  function deposit() external payable override {
    _mint(msg.sender, msg.value);
    emit Deposit(msg.sender, msg.value);
  }

  /**
   * @notice Withdraw WETH to receive ETH
   * @dev Burns WETH tokens and sends equivalent ETH
   * @dev For testing: if contract doesn't have enough ETH, only burns tokens
   * @param amount Amount of WETH to unwrap
   */
  function withdraw(uint256 amount) external override {
    require(balanceOf(msg.sender) >= amount, "Insufficient WETH balance");
    _burn(msg.sender, amount);

    // For testing: only send ETH if contract has sufficient balance
    // This allows testing with minted WETH that isn't backed by ETH
    if (address(this).balance >= amount) {
      (bool success, ) = msg.sender.call{ value: amount }("");
      require(success, "ETH transfer failed");
    }

    emit Withdrawal(msg.sender, amount);
  }

  /**
   * @notice Allow contract to receive ETH
   * @dev Required for withdraw() to send ETH back to users
   */
  receive() external payable {
    _mint(msg.sender, msg.value);
    emit Deposit(msg.sender, msg.value);
  }

  /**
   * @notice Fallback function to receive ETH
   */
  fallback() external payable {
    _mint(msg.sender, msg.value);
    emit Deposit(msg.sender, msg.value);
  }

  /**
   * @notice Get decimals (18 for WETH/ETH)
   */
  function decimals() public pure override returns (uint8) {
    return 18;
  }
}
