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
 * @title ERC20Token
 * @dev Upgradeable ERC20 token using UUPS proxies with EIP-2612 permit support
 */
contract ERC20Token is
  Initializable,
  ERC20Upgradeable,
  ERC20PermitUpgradeable,
  OwnableUpgradeable,
  UUPSUpgradeable
{
  // State variables
  uint8 public customDecimals;

  /**
   * @dev Reserved storage gap for future upgrades.
   * This allows adding new state variables without shifting storage slots.
   */
  uint256[50] private __gap;

  /// @notice Emitted when tokens are minted
  event TokenMinted(address indexed to, uint256 amount);
  /// @notice Emitted when tokens are burned
  event TokenBurned(address indexed from, uint256 amount);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @dev Initialize the upgradeable token
   * @param initialOwner Owner of the token
   * @param tokenName Token name
   * @param tokenSymbol Token symbol
   * @param tokenDecimals Token decimals
   * @param initialSupply Tokens minted to owner during initialization
   */
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
      emit TokenMinted(initialOwner, initialSupply);
    }
  }

  function decimals() public view virtual override returns (uint8) {
    return customDecimals;
  }

  /**
   * @dev Mint tokens (owner only)
   * @param to Recipient address
   * @param amount Amount to mint
   */
  function mint(address to, uint256 amount) public virtual onlyOwner {
    _mint(to, amount);
    emit TokenMinted(to, amount);
  }

  function burn(address from, uint256 amount) public virtual onlyOwner {
    _burn(from, amount);
    emit TokenBurned(from, amount);
  }

  /**
   * @return Version identifier for V1
   */
  function version() external pure virtual returns (string memory) {
    return "1";
  }

  /**
   * @dev Authorization hook for UUPS upgrades.
   *      Authorization is handled by the onlyOwner modifier.
   * @param newImplementation Address of the new implementation (unused, validated by UUPS)
   */
  function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
    // solhint-disable-next-line no-empty-blocks
    // Authorization is handled by onlyOwner modifier; no additional logic needed
  }
}
