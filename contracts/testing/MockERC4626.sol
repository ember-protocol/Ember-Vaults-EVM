// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal ERC-4626 vault used as a strategy in AtomicLiquidity tests.
/// @dev Inherits the canonical OZ ERC4626 implementation; no custom logic. Yield can be
///      simulated in tests by transferring underlying tokens directly to this contract.
contract MockERC4626 is ERC4626 {
  constructor(
    IERC20 asset_,
    string memory name_,
    string memory symbol_
  ) ERC20(name_, symbol_) ERC4626(asset_) {}
}
