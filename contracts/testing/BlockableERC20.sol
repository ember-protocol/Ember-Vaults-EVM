// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title BlockableERC20
/// @notice Minimal test ERC-20 that can block transfers TO specific addresses, simulating a
///         token-level blacklist (e.g. USDC/USDT). Used to exercise refund-failure paths where a
///         recipient can no longer receive the token. Mint is open; blocking is settable by anyone
///         (tests only — not for production).
contract BlockableERC20 is ERC20 {
  mapping(address => bool) public blocked;

  constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  /// @notice Block (or unblock) `account` from RECEIVING this token. Mirrors a USDC-style
  ///         blacklist where transfers to a blocked address revert.
  function setBlocked(address account, bool isBlocked) external {
    blocked[account] = isBlocked;
  }

  /// @dev Reverts any transfer/mint whose recipient is blocked (mint excluded would let tests
  ///      fund accounts; here we only guard non-zero recipients that are flagged).
  function _update(address from, address to, uint256 value) internal override {
    require(!blocked[to], "BlockableERC20: recipient blocked");
    super._update(from, to, value);
  }
}
