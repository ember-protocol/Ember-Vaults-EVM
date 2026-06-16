// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Minimal stub of the LayerZero V2 endpoint surface that the
///         `OApp` constructor (`setDelegate`) touches. Only used by tests
///         that exercise paths which never send or receive cross-chain
///         messages (e.g. pause / unpause / view-only checks).
contract LayerZeroEndpointStub {
  mapping(address => address) public delegates;

  function setDelegate(address _delegate) external {
    delegates[msg.sender] = _delegate;
  }
}
