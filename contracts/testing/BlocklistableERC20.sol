/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.

  This source code is provided for transparency and verification only.
  Use, modification, reproduction, or redeployment of this code
  requires prior written permission from the Ember Protocol Inc.
*/

pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";

/**
 * @title BlocklistableERC20
 * @notice TESTING-ONLY collateral mock that mirrors ERC20Token's initialize signature but
 *         can reject transfers to/from blocklisted addresses (USDC-style). Used to exercise
 *         the holdback "transfer deferred to claimable" path in AtomicLiquidity.
 */
contract BlocklistableERC20 is
  Initializable,
  ERC20Upgradeable,
  ERC20PermitUpgradeable,
  OwnableUpgradeable,
  UUPSUpgradeable
{
  uint8 public customDecimals;
  mapping(address => bool) public blocked;

  error AddressBlocked();

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(
    address initialOwner,
    string memory tokenName,
    string memory tokenSymbol,
    uint8 tokenDecimals,
    uint256 initialSupply
  ) public initializer {
    __ERC20_init(tokenName, tokenSymbol);
    __ERC20Permit_init(tokenName);
    __Ownable_init(initialOwner);
    __UUPSUpgradeable_init();

    customDecimals = tokenDecimals;
    if (initialSupply > 0) {
      _mint(initialOwner, initialSupply);
    }
  }

  function decimals() public view virtual override returns (uint8) {
    return customDecimals;
  }

  /// @notice Toggle whether transfers touching `account` revert (simulates USDC blocklist).
  function setBlocked(address account, bool isBlocked) external onlyOwner {
    blocked[account] = isBlocked;
  }

  function mint(address to, uint256 amount) external onlyOwner {
    _mint(to, amount);
  }

  function _update(address from, address to, uint256 value) internal virtual override {
    if (blocked[from] || blocked[to]) revert AddressBlocked();
    super._update(from, to, value);
  }

  function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
