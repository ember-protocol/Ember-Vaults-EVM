// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title FeeOnTransferERC20
/// @notice Minimal test ERC-20 that charges a transfer fee (in basis points), routed to a sink, so
///         the recipient receives less than the amount sent. Used to exercise escrow accounting
///         under fee-on-transfer collateral. Mints and burns are fee-free. Test-only.
contract FeeOnTransferERC20 is ERC20 {
  uint256 public immutable feeBps; // e.g. 100 = 1%
  address public constant FEE_SINK = address(0xFEE);

  constructor(string memory name_, string memory symbol_, uint256 feeBps_) ERC20(name_, symbol_) {
    feeBps = feeBps_;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  /// @dev Charges `feeBps` on ordinary transfers (recipient gets `value - fee`, fee goes to the
  ///      sink). Mint (`from == 0`) and burn (`to == 0`) pass through fee-free.
  function _update(address from, address to, uint256 value) internal override {
    if (from == address(0) || to == address(0) || feeBps == 0) {
      super._update(from, to, value);
      return;
    }
    uint256 fee = (value * feeBps) / 10_000;
    super._update(from, to, value - fee);
    if (fee > 0) {
      super._update(from, FEE_SINK, fee);
    }
  }
}
