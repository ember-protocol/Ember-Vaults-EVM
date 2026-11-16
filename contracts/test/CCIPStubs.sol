// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Minimal stub of the CCIP Router surface that {TokenPool} touches.
/// @dev TokenPool calls the router through the `IRouter` type, so a matching function
///      signature is all that's required — the stub does not need to inherit the interface,
///      which keeps it on the repo's default 0.8.22 compiler.
contract CCIPRouterStub {
  mapping(uint64 => address) internal s_onRamps;
  mapping(uint64 => mapping(address => bool)) internal s_offRamps;

  function setOnRamp(uint64 chainSelector, address onRamp) external {
    s_onRamps[chainSelector] = onRamp;
  }

  function setOffRamp(uint64 chainSelector, address offRamp, bool allowed) external {
    s_offRamps[chainSelector][offRamp] = allowed;
  }

  function getOnRamp(uint64 destChainSelector) external view returns (address) {
    return s_onRamps[destChainSelector];
  }

  function isOffRamp(uint64 sourceChainSelector, address offRamp) external view returns (bool) {
    return s_offRamps[sourceChainSelector][offRamp];
  }
}

/// @notice Minimal stub of the RMN proxy surface that {TokenPool} touches.
/// @dev Both the global and per-subject `isCursed` overloads exist upstream; the pool only
///      uses the subject form, but the global one is kept so the stub matches the real shape.
contract CCIPRMNStub {
  bool internal s_globalCurse;
  mapping(bytes16 => bool) internal s_cursedSubjects;

  function setGlobalCurse(bool cursed) external {
    s_globalCurse = cursed;
  }

  function setCursedSubject(bytes16 subject, bool cursed) external {
    s_cursedSubjects[subject] = cursed;
  }

  /// @notice Curses a whole lane, addressed the way the pool addresses it.
  function setCursedChain(uint64 chainSelector, bool cursed) external {
    s_cursedSubjects[bytes16(uint128(chainSelector))] = cursed;
  }

  function isCursed() external view returns (bool) {
    return s_globalCurse;
  }

  function isCursed(bytes16 subject) external view returns (bool) {
    return s_globalCurse || s_cursedSubjects[subject];
  }
}
