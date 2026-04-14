// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../../contracts/EmberVault.sol";
import "../../contracts/EmberProtocolConfig.sol";
import "../../contracts/testing/ERC20Token.sol";

/**
 * @title EmberVault Conversion Fuzz Tests
 * @notice Property-based tests for rate-based conversion logic
 * @dev Tests critical properties of the custom rate-based ERC-4626 implementation
 */
contract EmberVaultConversionsFuzzTest is Test {
  EmberVault public vault;
  EmberProtocolConfig public protocolConfig;
  ERC20Token public token;

  address public owner = address(0x1);
  address public admin = address(0x2);
  address public operator = address(0x3);
  address public rateManager = address(0x4);
  address public feeRecipient = address(0x5);
  address public user = address(0x6);

  uint256 constant INITIAL_RATE = 1e18; // 1:1
  uint256 constant MAX_TVL = type(uint128).max;

  function setUp() public {
    vm.startPrank(owner);

    // Deploy protocol config
    protocolConfig = new EmberProtocolConfig();
    protocolConfig.initialize(owner, feeRecipient);

    // Deploy test token
    token = new ERC20Token();
    token.initialize(owner, "Test USDC", "USDC", 6, 0);

    // Deploy vault
    vault = new EmberVault();

    EmberVault.VaultInitParams memory params = EmberVault.VaultInitParams({
      name: "Test Vault",
      receiptTokenSymbol: "tvUSDC",
      collateralToken: address(token),
      admin: admin,
      operator: operator,
      rateManager: rateManager,
      maxRateChangePerUpdate: 0.1e18, // 10%
      feePercentage: 0.01e18, // 1%
      minWithdrawableShares: 1e6,
      rateUpdateInterval: 1 hours,
      maxTVL: MAX_TVL
    });

    address[] memory subAccounts = new address[](0);
    vault.initialize(owner, address(protocolConfig), params, subAccounts);

    vm.stopPrank();
  }

  /*//////////////////////////////////////////////////////////////
                        CONVERSION ROUND-TRIP TESTS
    //////////////////////////////////////////////////////////////*/

  /**
   * @notice Test that converting assets to shares and back preserves value (within precision)
   * @dev Property: convertToAssets(convertToShares(assets)) ≈ assets
   */
  function testFuzz_ConversionRoundTrip_AssetsToShares(uint256 assets) public {
    // Bound inputs to reasonable values
    assets = bound(assets, 1, type(uint128).max);

    // Convert assets → shares → assets
    uint256 shares = vault.convertToShares(assets);
    uint256 backToAssets = vault.convertToAssets(shares);

    // Allow up to 1 wei precision loss due to rounding
    assertApproxEqAbs(backToAssets, assets, 1, "Round trip assets should match");
  }

  /**
   * @notice Test that converting shares to assets and back preserves value (within precision)
   * @dev Property: convertToShares(convertToAssets(shares)) ≈ shares
   */
  function testFuzz_ConversionRoundTrip_SharesToAssets(uint256 shares) public {
    // Bound inputs to reasonable values
    shares = bound(shares, 1, type(uint128).max);

    // Convert shares → assets → shares
    uint256 assets = vault.convertToAssets(shares);
    uint256 backToShares = vault.convertToShares(assets);

    // Allow up to 1 wei precision loss due to rounding
    assertApproxEqAbs(backToShares, shares, 1, "Round trip shares should match");
  }

  /*//////////////////////////////////////////////////////////////
                        ROUNDING DIRECTION TESTS
    //////////////////////////////////////////////////////////////*/

  /**
   * @notice Test that deposit conversion rounds down (favors vault)
   * @dev Property: User gets equal or fewer shares than perfect calculation
   */
  function testFuzz_DepositRoundsDown(uint256 assets) public {
    assets = bound(assets, 1e6, 1e12); // 1 to 1M USDC (6 decimals)

    uint256 shares = vault.convertToShares(assets);

    // Perfect calculation: shares = assets * rate / BASE
    uint256 perfectShares = (assets * INITIAL_RATE) / 1e18;

    // Shares should be <= perfect (rounds down, favors vault)
    assertLe(shares, perfectShares, "Deposit should round down");
  }

  /**
   * @notice Test that mint conversion rounds up (favors vault)
   * @dev Property: User pays equal or more assets than perfect calculation
   */
  function testFuzz_MintRoundsUp(uint256 shares) public {
    shares = bound(shares, 1e6, 1e12);

    // Use internal _convertToAssets with Ceil rounding (like mint does)
    vm.prank(address(this));
    uint256 assets = vault.previewMint(shares);

    // Perfect calculation: assets = shares * BASE / rate
    uint256 perfectAssets = (shares * 1e18) / INITIAL_RATE;

    // Assets should be >= perfect (rounds up, favors vault)
    assertGe(assets, perfectAssets, "Mint should round up");
  }

  /*//////////////////////////////////////////////////////////////
                        RATE RELATIONSHIP TESTS
    //////////////////////////////////////////////////////////////*/

  /**
   * @notice Test that higher rate gives more shares for same assets
   * @dev Property: shares(rate2) > shares(rate1) when rate2 > rate1
   */
  function testFuzz_HigherRateGivesMoreShares(uint256 assets, uint256 rateMultiplier) public {
    assets = bound(assets, 1e6, 1e12);
    rateMultiplier = bound(rateMultiplier, 1.1e18, 2e18); // 110% to 200%

    // Shares at initial rate
    uint256 sharesAtRate1 = vault.convertToShares(assets);

    // Update rate (must be rate manager)
    uint256 newRate = (INITIAL_RATE * rateMultiplier) / 1e18;
    vm.prank(rateManager);
    vault.updateVaultRate(newRate);

    // Shares at higher rate
    uint256 sharesAtRate2 = vault.convertToShares(assets);

    // Higher rate should give more shares
    assertGt(sharesAtRate2, sharesAtRate1, "Higher rate should give more shares");
  }

  /**
   * @notice Test that total assets calculation is consistent with conversions
   * @dev Property: totalAssets() = convertToAssets(totalSupply())
   */
  function testFuzz_TotalAssetsConsistency(uint256 depositAmount) public {
    depositAmount = bound(depositAmount, 1e6, 1e9); // Up to 1000 USDC

    // Mint tokens to user
    vm.prank(owner);
    token.mint(user, depositAmount);

    // User deposits
    vm.startPrank(user);
    token.approve(address(vault), depositAmount);
    vault.deposit(depositAmount, user);
    vm.stopPrank();

    // Calculate total assets both ways
    uint256 reportedTotalAssets = vault.totalAssets();
    uint256 calculatedTotalAssets = vault.convertToAssets(vault.totalSupply());

    // Should be exactly equal
    assertEq(reportedTotalAssets, calculatedTotalAssets, "Total assets calculation mismatch");
  }

  /*//////////////////////////////////////////////////////////////
                        ZERO HANDLING TESTS
    //////////////////////////////////////////////////////////////*/

  /**
   * @notice Test that zero assets converts to zero shares
   * @dev Property: convertToShares(0) = 0
   */
  function testFuzz_ZeroAssetsGivesZeroShares() public {
    uint256 shares = vault.convertToShares(0);
    assertEq(shares, 0, "Zero assets should give zero shares");
  }

  /**
   * @notice Test that zero shares converts to zero assets
   * @dev Property: convertToAssets(0) = 0
   */
  function testFuzz_ZeroSharesGivesZeroAssets() public {
    uint256 assets = vault.convertToAssets(0);
    assertEq(assets, 0, "Zero shares should give zero assets");
  }

  /*//////////////////////////////////////////////////////////////
                        MONOTONICITY TESTS
    //////////////////////////////////////////////////////////////*/

  /**
   * @notice Test that more assets always gives more shares (or equal)
   * @dev Property: convertToShares(a2) >= convertToShares(a1) when a2 > a1
   */
  function testFuzz_SharesMonotonic(uint256 assets1, uint256 assets2) public {
    assets1 = bound(assets1, 1, type(uint64).max);
    assets2 = bound(assets2, 1, type(uint64).max);

    if (assets1 > assets2) {
      (assets1, assets2) = (assets2, assets1);
    }

    uint256 shares1 = vault.convertToShares(assets1);
    uint256 shares2 = vault.convertToShares(assets2);

    assertGe(shares2, shares1, "More assets should give more shares");
  }

  /**
   * @notice Test that more shares always gives more assets (or equal)
   * @dev Property: convertToAssets(s2) >= convertToAssets(s1) when s2 > s1
   */
  function testFuzz_AssetsMonotonic(uint256 shares1, uint256 shares2) public {
    shares1 = bound(shares1, 1, type(uint64).max);
    shares2 = bound(shares2, 1, type(uint64).max);

    if (shares1 > shares2) {
      (shares1, shares2) = (shares2, shares1);
    }

    uint256 assets1 = vault.convertToAssets(shares1);
    uint256 assets2 = vault.convertToAssets(shares2);

    assertGe(assets2, assets1, "More shares should give more assets");
  }

  /*//////////////////////////////////////////////////////////////
                        MAX FUNCTIONS TESTS
    //////////////////////////////////////////////////////////////*/

  /**
   * @notice Test that maxWithdraw equals convertToAssets(balance)
   * @dev Property: maxWithdraw(user) = convertToAssets(balanceOf(user))
   */
  function testFuzz_MaxWithdrawConsistency(uint256 depositAmount) public {
    depositAmount = bound(depositAmount, 1e6, 1e9);

    // Setup: user deposits
    vm.prank(owner);
    token.mint(user, depositAmount);

    vm.startPrank(user);
    token.approve(address(vault), depositAmount);
    vault.deposit(depositAmount, user);
    vm.stopPrank();

    // Check maxWithdraw
    uint256 maxWithdraw = vault.maxWithdraw(user);
    uint256 expectedMax = vault.convertToAssets(vault.balanceOf(user));

    assertEq(maxWithdraw, expectedMax, "maxWithdraw should equal convertToAssets(balance)");
  }

  /**
   * @notice Test that maxMint respects TVL limits
   * @dev Property: After minting maxMint, TVL should not exceed maxTVL
   */
  function testFuzz_MaxMintRespectsTVL(uint256 currentTVL) public {
    currentTVL = bound(currentTVL, 0, MAX_TVL - 1e12);

    // Setup: deposit to reach currentTVL
    if (currentTVL > 0) {
      vm.prank(owner);
      token.mint(user, currentTVL);

      vm.startPrank(user);
      token.approve(address(vault), currentTVL);
      vault.deposit(currentTVL, user);
      vm.stopPrank();
    }

    uint256 maxMintable = vault.maxMint(user);
    uint256 remainingCapacity = MAX_TVL - vault.totalAssets();
    uint256 expectedMaxMint = vault.convertToShares(remainingCapacity);

    assertEq(maxMintable, expectedMaxMint, "maxMint should match remaining capacity");
  }
}
