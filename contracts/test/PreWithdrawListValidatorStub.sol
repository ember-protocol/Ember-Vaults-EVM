// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Test-only stand-in for a validator deployed before the withdrawal allow-list: it has
///         everything the vault calls on deposit and withdrawal except `validateWithdraw`, so a
///         test can prove a vault upgraded ahead of its validator still redeems. Not deployed.
contract PreWithdrawListValidatorStub {
  function validateDeposit(address, address) external pure {}

  function recordDeposit(address, address, uint256) external pure {}

  function recordWeightedDeposit(address, address, uint256, uint256, uint256) external pure {}

  function calculateWithdrawalFees(
    address,
    address,
    uint256,
    uint256
  ) external pure returns (uint256, uint256) {
    return (0, 0);
  }
}
