// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Stub of the protocol-config surface the vault and the CCIP pool read policy from.
contract EmberProtocolConfigStub {
  mapping(address => bool) internal s_blacklisted;
  bool internal s_protocolPaused;

  function setBlacklisted(address account, bool blacklisted) external {
    s_blacklisted[account] = blacklisted;
  }

  function setProtocolPauseStatus(bool paused) external {
    s_protocolPaused = paused;
  }

  function isAccountBlacklisted(address account) external view returns (bool) {
    return s_blacklisted[account];
  }

  function getProtocolPauseStatus() external view returns (bool) {
    return s_protocolPaused;
  }
}

/**
 * @notice Stub of an Ember vault's receipt-token surface, as {EmberTokenPool} sees it.
 * @dev Deliberately mirrors {EmberVault}'s real bridge semantics, including the detail this
 *      whole migration hinges on: `bridgeBurn` checks the blacklist against `from`, which
 *      under CCIP is the pool rather than the user. Reproducing that faithfully is what lets
 *      the test suite demonstrate both the bypass and the pool-level fix.
 *
 *      Not a substitute for the real vault — the 1000+ vault tests cover that. This exists so
 *      pool behaviour can be tested without standing up a fully initialized vault.
 */
contract EmberVaultTokenStub is ERC20 {
  error Unauthorized();
  error ZeroAddress();
  error ZeroAmount();
  error InsufficientShares();
  error Blacklisted();
  error ProtocolPaused();
  error BridgeAmountTooSmall();
  error BridgeAmountTooLarge();

  event BridgeMint(address indexed vault, address indexed to, uint256 amount);
  event BridgeBurn(address indexed vault, address indexed from, uint256 amount);

  address public bridgeAdapter;
  address public protocolConfig;
  uint256 public minBridgeAmount;
  uint256 public maxBridgeAmount;

  uint8 internal immutable i_decimals;

  constructor(
    string memory name_,
    string memory symbol_,
    uint8 decimals_,
    address protocolConfig_
  ) ERC20(name_, symbol_) {
    i_decimals = decimals_;
    protocolConfig = protocolConfig_;
  }

  function decimals() public view override returns (uint8) {
    return i_decimals;
  }

  function setBridgeAdapter(address newAdapter) external {
    bridgeAdapter = newAdapter;
  }

  function setBridgeLimits(uint256 minAmount, uint256 maxAmount) external {
    minBridgeAmount = minAmount;
    maxBridgeAmount = maxAmount;
  }

  /// @notice Test helper — the real vault mints shares through its deposit flow.
  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  modifier onlyBridgeAdapter() {
    if (msg.sender != bridgeAdapter) revert Unauthorized();
    _;
  }

  function bridgeMint(address to, uint256 amount) external onlyBridgeAdapter {
    if (to == address(0)) revert ZeroAddress();
    if (amount == 0) revert ZeroAmount();
    _mint(to, amount);
    emit BridgeMint(address(this), to, amount);
  }

  function bridgeBurn(address from, uint256 amount) external onlyBridgeAdapter {
    if (from == address(0)) revert ZeroAddress();
    if (amount == 0) revert ZeroAmount();
    if (balanceOf(from) < amount) revert InsufficientShares();

    if (EmberProtocolConfigStub(protocolConfig).getProtocolPauseStatus()) revert ProtocolPaused();
    // Mirrors the real vault: enforced against `from`, which is the pool under CCIP.
    if (EmberProtocolConfigStub(protocolConfig).isAccountBlacklisted(from)) revert Blacklisted();

    if (minBridgeAmount > 0 && amount < minBridgeAmount) revert BridgeAmountTooSmall();
    if (maxBridgeAmount > 0 && amount > maxBridgeAmount) revert BridgeAmountTooLarge();

    _burn(from, amount);
    emit BridgeBurn(address(this), from, amount);
  }
}
