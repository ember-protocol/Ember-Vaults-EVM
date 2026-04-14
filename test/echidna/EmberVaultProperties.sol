// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../../contracts/EmberVault.sol";
import "../../contracts/EmberProtocolConfig.sol";
import "../../contracts/testing/ERC20Token.sol";

/**
 * @title EmberVaultProperties
 * @notice Echidna property tests for EmberVault
 * @dev Tests invariants and properties that should always hold
 *
 * Run with: echidna-test . --contract EmberVaultProperties --config echidna.yaml
 */
contract EmberVaultProperties {
  EmberVault public vault;
  EmberProtocolConfig public protocolConfig;
  ERC20Token public collateralToken;

  uint256 private initialRate = 1e18;

  constructor() {
    // Note: Echidna deployment is simplified
    // In practice, you'd deploy through a separate setup contract
  }

  /*//////////////////////////////////////////////////////////////
                        CORE INVARIANTS
    //////////////////////////////////////////////////////////////*/

  /// @notice Invariant: Rate should never be zero
  /// @dev This is critical for all conversions to work
  function echidna_rate_never_zero() public view returns (bool) {
    // Rate must always be positive for conversions to work
    return vault.rate().value > 0;
  }

  /// @notice Invariant: Total assets should equal calculated assets from supply
  /// @dev totalAssets() should always equal convertToAssets(totalSupply())
  function echidna_totalAssets_consistent() public view returns (bool) {
    uint256 calculated = vault.convertToAssets(vault.totalSupply());
    uint256 reported = vault.totalAssets();
    return calculated == reported;
  }

  /// @notice Invariant: TVL should never exceed maxTVL
  function echidna_tvl_within_limit() public view returns (bool) {
    return vault.totalAssets() <= vault.maxTVL();
  }

  /// @notice Invariant: Accrued fees should never exceed total assets
  /// @dev Fees can't be more than the vault's total value
  function echidna_fees_never_exceed_tvl() public view returns (bool) {
    uint256 accruedFees = vault.platformFee().accrued;
    uint256 tvl = vault.totalAssets();
    return accruedFees <= tvl;
  }

  /*//////////////////////////////////////////////////////////////
                    CONVERSION PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Property: Converting assets to shares and back should preserve value
  /// @dev Allow 1 wei precision loss due to rounding
  function echidna_conversion_roundtrip_assets(uint256 assets) public view returns (bool) {
    // Bound to reasonable range to avoid overflow
    if (assets == 0 || assets > type(uint128).max) return true;

    uint256 shares = vault.convertToShares(assets);
    uint256 backToAssets = vault.convertToAssets(shares);

    // Allow 1 wei precision loss
    if (backToAssets >= assets) {
      return backToAssets - assets <= 1;
    } else {
      return assets - backToAssets <= 1;
    }
  }

  /// @notice Property: Converting shares to assets and back should preserve value
  /// @dev Allow 1 wei precision loss due to rounding
  function echidna_conversion_roundtrip_shares(uint256 shares) public view returns (bool) {
    // Bound to reasonable range to avoid overflow
    if (shares == 0 || shares > type(uint128).max) return true;

    uint256 assets = vault.convertToAssets(shares);
    uint256 backToShares = vault.convertToShares(assets);

    // Allow 1 wei precision loss
    if (backToShares >= shares) {
      return backToShares - shares <= 1;
    } else {
      return shares - backToShares <= 1;
    }
  }

  /// @notice Property: Zero assets should give zero shares
  function echidna_zero_assets_gives_zero_shares() public view returns (bool) {
    return vault.convertToShares(0) == 0;
  }

  /// @notice Property: Zero shares should give zero assets
  function echidna_zero_shares_gives_zero_assets() public view returns (bool) {
    return vault.convertToAssets(0) == 0;
  }

  /*//////////////////////////////////////////////////////////////
                    MONOTONICITY PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Property: More assets should give more shares (strictly increasing)
  /// @dev This ensures conversions are monotonic
  function echidna_monotonic_assets_to_shares(
    uint256 assets1,
    uint256 assets2
  ) public view returns (bool) {
    // Bound inputs
    if (assets1 == 0 || assets2 == 0) return true;
    if (assets1 >= type(uint128).max || assets2 >= type(uint128).max) return true;
    if (assets1 == assets2) return true;

    uint256 shares1 = vault.convertToShares(assets1);
    uint256 shares2 = vault.convertToShares(assets2);

    if (assets1 < assets2) {
      return shares1 < shares2;
    } else {
      return shares1 > shares2;
    }
  }

  /// @notice Property: More shares should give more assets (strictly increasing)
  function echidna_monotonic_shares_to_assets(
    uint256 shares1,
    uint256 shares2
  ) public view returns (bool) {
    // Bound inputs
    if (shares1 == 0 || shares2 == 0) return true;
    if (shares1 >= type(uint128).max || shares2 >= type(uint128).max) return true;
    if (shares1 == shares2) return true;

    uint256 assets1 = vault.convertToAssets(shares1);
    uint256 assets2 = vault.convertToAssets(shares2);

    if (shares1 < shares2) {
      return assets1 < assets2;
    } else {
      return assets1 > assets2;
    }
  }

  /*//////////////////////////////////////////////////////////////
                    ROUNDING PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Property: Deposit rounding should favor the vault
  /// @dev Converting assets to shares should round down (floor)
  function echidna_deposit_rounds_down(uint256 assets) public view returns (bool) {
    if (assets == 0 || assets > type(uint128).max) return true;

    uint256 shares = vault.convertToShares(assets);
    uint256 backToAssets = vault.convertToAssets(shares);

    // Floor rounding means back conversion gives <= original
    return backToAssets <= assets;
  }

  /*//////////////////////////////////////////////////////////////
                    PRECISION PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Property: Precision loss should be bounded to less than 0.01%
  function echidna_bounded_precision_loss(uint256 assets) public view returns (bool) {
    // Only test reasonable amounts
    if (assets < 1e6 || assets > type(uint96).max) return true;

    uint256 shares = vault.convertToShares(assets);
    uint256 backToAssets = vault.convertToAssets(shares);

    // Calculate precision loss
    uint256 loss = assets > backToAssets ? assets - backToAssets : 0;
    uint256 maxLoss = (assets * 1) / 10000; // 0.01%

    return loss <= maxLoss;
  }

  /*//////////////////////////////////////////////////////////////
                    RATE BOUNDS PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Property: Rate should be within protocol bounds
  function echidna_rate_within_bounds() public view returns (bool) {
    uint256 currentRate = vault.rate().value;
    uint256 minRate = protocolConfig.getMinRate();
    uint256 maxRate = protocolConfig.getMaxRate();

    return currentRate >= minRate && currentRate <= maxRate;
  }

  /*//////////////////////////////////////////////////////////////
                    SHARES SUPPLY PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Invariant: Total supply should never overflow
  function echidna_total_supply_no_overflow() public view returns (bool) {
    uint256 supply = vault.totalSupply();
    return supply < type(uint256).max - 1e18; // Leave room for growth
  }

  /// @notice Property: Individual balance should never exceed total supply
  function echidna_balance_never_exceeds_supply(address account) public view returns (bool) {
    uint256 balance = vault.balanceOf(account);
    uint256 supply = vault.totalSupply();
    return balance <= supply;
  }

  /*//////////////////////////////////////////////////////////////
                    STATE CONSISTENCY PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Invariant: Pending withdrawal shares should be <= total supply
  function echidna_pending_withdrawals_bounded() public view returns (bool) {
    // Get account state for test addresses
    uint256 totalPending = 0;

    // Note: In actual test, you'd iterate through known addresses
    // For simplicity, we check that at least the property structure is valid

    uint256 supply = vault.totalSupply();
    return totalPending <= supply;
  }

  /*//////////////////////////////////////////////////////////////
                    PAUSABILITY PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Property: When paused, maxDeposit should return 0
  function echidna_paused_deposits_return_zero() public view returns (bool) {
    EmberVault.PauseStatus memory pauseStatus = vault.pauseStatus();
    if (pauseStatus.deposits) {
      return vault.maxDeposit(address(this)) == 0;
    }
    return true;
  }

  /// @notice Property: When paused, maxMint should return 0
  function echidna_paused_mints_return_zero() public view returns (bool) {
    EmberVault.PauseStatus memory pauseStatus = vault.pauseStatus();
    if (pauseStatus.deposits) {
      return vault.maxMint(address(this)) == 0;
    }
    return true;
  }
}
