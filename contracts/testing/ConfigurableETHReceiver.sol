/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.

  This source code is provided for transparency and verification only.
  Use, modification, reproduction, or redeployment of this code
  requires prior written permission from the Ember Protocol Inc.
*/

pragma solidity ^0.8.22;

/**
 * @title ConfigurableETHReceiver
 * @notice TESTING-ONLY contract that can be toggled to accept or reject incoming ETH. Used
 *         to exercise the EmberETHVault "withdrawal deferred to claimable" path: while
 *         rejecting, a direct send reverts; after accepting, the escrowed balance is
 *         claimable.
 */
contract ConfigurableETHReceiver {
  bool public accept;

  function setAccept(bool value) external {
    accept = value;
  }

  /// @notice Forwards an arbitrary call (testing-only) so this contract can, e.g., invoke
  ///         `EmberETHVault.claimWithdrawalTo` on its own behalf even while it rejects ETH.
  function callTarget(address target, bytes calldata data) external returns (bytes memory ret) {
    bool ok;
    (ok, ret) = target.call(data);
    require(ok, "call failed");
  }

  receive() external payable {
    require(accept, "ETH rejected");
  }
}
