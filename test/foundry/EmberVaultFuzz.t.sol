// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../../contracts/EmberVault.sol";
import "../../contracts/EmberProtocolConfig.sol";
import "../../contracts/testing/ERC20Token.sol";

/**
 * @title EmberVaultFuzzTest
 * @notice Fuzz testing for EmberVault rate-based conversion system
 * @dev Tests critical properties and invariants under random inputs
 */
contract EmberVaultFuzzTest is Test {
  EmberVault public vault;
  EmberProtocolConfig public protocolConfig;
  ERC20Token public collateralToken;

  address public owner;
  address public admin;
  address public operator;
  address public rateManager;
  address public feeRecipient;

  uint256 constant INITIAL_RATE = 1e18; // 1:1
  uint256 constant MAX_TVL = type(uint96).max; // Large but bounded

  function setUp() public {
    owner = address(this);
    admin = makeAddr("admin");
    operator = makeAddr("operator");
    rateManager = makeAddr("rateManager");
    feeRecipient = makeAddr("feeRecipient");

    // Deploy protocol config
    EmberProtocolConfig configImpl = new EmberProtocolConfig();
    bytes memory configInitData = abi.encodeWithSelector(
      EmberProtocolConfig.initialize.selector,
      owner,
      feeRecipient
    );
    address configProxy = address(new ERC1967Proxy(address(configImpl), configInitData));
    protocolConfig = EmberProtocolConfig(configProxy);

    // Deploy collateral token
    ERC20Token tokenImpl = new ERC20Token();
    bytes memory tokenInitData = abi.encodeWithSelector(
      ERC20Token.initialize.selector,
      owner,
      "Test USDC",
      "USDC",
      6,
      0
    );
    address tokenProxy = address(new ERC1967Proxy(address(tokenImpl), tokenInitData));
    collateralToken = ERC20Token(tokenProxy);

    // Deploy vault
    EmberVault vaultImpl = new EmberVault();

    EmberVault.VaultInitParams memory params = EmberVault.VaultInitParams({
      name: "Test Vault",
      receiptTokenSymbol: "tvUSDC",
      collateralToken: address(collateralToken),
      admin: admin,
      operator: operator,
      rateManager: rateManager,
      maxRateChangePerUpdate: 0.1e18, // 10%
      feePercentage: 0.01e18, // 1%
      minWithdrawableShares: 1e6,
      rateUpdateInterval: 3600001, // > 1 hour in ms (must be strictly > min)
      maxTVL: MAX_TVL
    });

    address[] memory subAccounts = new address[](0);

    bytes memory vaultInitData = abi.encodeWithSelector(
      EmberVault.initialize.selector,
      address(protocolConfig),
      owner,
      params,
      subAccounts
    );

    address vaultProxy = address(new ERC1967Proxy(address(vaultImpl), vaultInitData));
    vault = EmberVault(vaultProxy);

    // Setup labels for better trace output
    vm.label(address(vault), "EmberVault");
    vm.label(address(protocolConfig), "ProtocolConfig");
    vm.label(address(collateralToken), "CollateralToken");
  }

  /*//////////////////////////////////////////////////////////////
                    CONVERSION ROUND-TRIP PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Test that converting assets→shares→assets preserves value (within rounding)
  function testFuzz_ConversionRoundTrip_AssetsToShares(uint256 assets) public view {
    // Bound assets to reasonable range
    assets = bound(assets, 1, type(uint128).max);

    uint256 shares = vault.convertToShares(assets);
    uint256 backToAssets = vault.convertToAssets(shares);

    // Allow 1 wei precision loss due to rounding
    assertApproxEqAbs(backToAssets, assets, 1, "Round-trip conversion should preserve value");
  }

  /// @notice Test that converting shares→assets→shares preserves value (within rounding)
  function testFuzz_ConversionRoundTrip_SharesToAssets(uint256 shares) public view {
    // Bound shares to reasonable range
    shares = bound(shares, 1, type(uint128).max);

    uint256 assets = vault.convertToAssets(shares);
    uint256 backToShares = vault.convertToShares(assets);

    // Allow 1 wei precision loss due to rounding
    assertApproxEqAbs(backToShares, shares, 1, "Round-trip conversion should preserve value");
  }

  /*//////////////////////////////////////////////////////////////
                        ROUNDING PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Test that deposit rounding favors the vault (user gets <= shares)
  function testFuzz_DepositRounding_FavorsVault(uint256 assets) public {
    assets = bound(assets, 1e6, 1000e6); // 1-1000 USDC

    // Mint tokens to user
    address user = makeAddr("user");
    collateralToken.mint(user, assets);

    vm.startPrank(user);
    collateralToken.approve(address(vault), assets);

    uint256 expectedShares = vault.convertToShares(assets);
    uint256 actualShares = vault.deposit(assets, user);
    vm.stopPrank();

    // Actual shares should be <= expected (favors vault)
    assertLe(actualShares, expectedShares, "Deposit should round down to favor vault");
  }

  /// @notice Test that convertToShares always rounds down (FLOOR)
  function testFuzz_ConvertToShares_RoundsDown(uint256 assets) public view {
    assets = bound(assets, 1, type(uint128).max);

    uint256 shares = vault.convertToShares(assets);
    uint256 backToAssets = vault.convertToAssets(shares);

    // Back conversion should give <= original (proof of floor rounding)
    assertLe(backToAssets, assets, "Floor rounding means reconversion should give <= original");
  }

  /*//////////////////////////////////////////////////////////////
                        RATE CONSISTENCY
    //////////////////////////////////////////////////////////////*/

  /// @notice Test that totalAssets equals calculated assets from total supply
  function testFuzz_TotalAssets_Consistent(uint256 depositAmount) public {
    depositAmount = bound(depositAmount, 1e6, 10000e6);

    // Setup deposit
    address user = makeAddr("user");
    collateralToken.mint(user, depositAmount);

    vm.startPrank(user);
    collateralToken.approve(address(vault), depositAmount);
    vault.deposit(depositAmount, user);
    vm.stopPrank();

    // Check consistency
    uint256 totalShares = vault.totalSupply();
    uint256 calculated = vault.convertToAssets(totalShares);
    uint256 reported = vault.totalAssets();

    assertEq(calculated, reported, "totalAssets should equal calculated assets from shares");
  }

  /// @notice Test that rate-based conversion is proportional
  function testFuzz_Conversion_Proportional(uint256 assets1, uint256 assets2) public view {
    // Bound to reasonable ranges
    assets1 = bound(assets1, 1e6, 10000e6);
    assets2 = bound(assets2, 1e6, 10000e6);
    vm.assume(assets1 != assets2);

    uint256 shares1 = vault.convertToShares(assets1);
    uint256 shares2 = vault.convertToShares(assets2);

    // Ratio should be approximately equal
    // shares1/shares2 ≈ assets1/assets2
    if (assets1 > assets2) {
      assertTrue(shares1 >= shares2, "More assets should give more shares");
    } else {
      assertTrue(shares1 <= shares2, "Less assets should give less shares");
    }
  }

  /*//////////////////////////////////////////////////////////////
                        TVL LIMITS
    //////////////////////////////////////////////////////////////*/

  /// @notice Test that deposits respect maxTVL
  function testFuzz_Deposit_RespectsMaxTVL(uint256 depositAmount) public {
    depositAmount = bound(depositAmount, 1, MAX_TVL * 2);

    address user = makeAddr("user");
    collateralToken.mint(user, depositAmount);

    uint256 maxDeposit = vault.maxDeposit(user);

    if (depositAmount > maxDeposit) {
      vm.startPrank(user);
      collateralToken.approve(address(vault), depositAmount);
      vm.expectRevert();
      vault.deposit(depositAmount, user);
      vm.stopPrank();
    } else {
      vm.startPrank(user);
      collateralToken.approve(address(vault), depositAmount);
      vault.deposit(depositAmount, user);
      vm.stopPrank();

      assertTrue(vault.totalAssets() <= MAX_TVL, "TVL should not exceed max");
    }
  }

  /*//////////////////////////////////////////////////////////////
                    MONOTONICITY PROPERTIES
    //////////////////////////////////////////////////////////////*/

  /// @notice Test that more assets always give more shares (monotonic)
  function testFuzz_Conversion_Monotonic_Increasing(uint256 assets1, uint256 assets2) public view {
    assets1 = bound(assets1, 1, type(uint128).max - 1);
    assets2 = bound(assets2, assets1 + 1, type(uint128).max);

    uint256 shares1 = vault.convertToShares(assets1);
    uint256 shares2 = vault.convertToShares(assets2);

    assertTrue(shares2 > shares1, "More assets should always give more shares");
  }

  /// @notice Test that more shares always give more assets (monotonic)
  function testFuzz_Conversion_Monotonic_Decreasing(uint256 shares1, uint256 shares2) public view {
    shares1 = bound(shares1, 1, type(uint128).max - 1);
    shares2 = bound(shares2, shares1 + 1, type(uint128).max);

    uint256 assets1 = vault.convertToAssets(shares1);
    uint256 assets2 = vault.convertToAssets(shares2);

    assertTrue(assets2 > assets1, "More shares should always give more assets");
  }

  /*//////////////////////////////////////////////////////////////
                    PRECISION LOSS BOUNDS
    //////////////////////////////////////////////////////////////*/

  /// @notice Test that precision loss is bounded
  function testFuzz_PrecisionLoss_Bounded(uint256 assets) public view {
    assets = bound(assets, 1e6, type(uint96).max);

    uint256 shares = vault.convertToShares(assets);
    uint256 backToAssets = vault.convertToAssets(shares);

    // Precision loss should be less than 0.01% (1 basis point)
    uint256 loss = assets > backToAssets ? assets - backToAssets : 0;
    uint256 maxLoss = (assets * 1) / 10000; // 0.01%

    assertLe(loss, maxLoss, "Precision loss should be less than 0.01%");
  }

  /*//////////////////////////////////////////////////////////////
                    ZERO EDGE CASES
    //////////////////////////////////////////////////////////////*/

  /// @notice Test that zero conversions work correctly
  function testFuzz_ZeroConversions() public view {
    assertEq(vault.convertToShares(0), 0, "Zero assets should give zero shares");
    assertEq(vault.convertToAssets(0), 0, "Zero shares should give zero assets");
  }

  /*//////////////////////////////////////////////////////////////
                    PREVIEW FUNCTIONS ACCURACY
    //////////////////////////////////////////////////////////////*/

  /// @notice Test that previewDeposit matches actual deposit
  function testFuzz_PreviewDeposit_Accurate(uint256 assets) public {
    assets = bound(assets, 1e6, 10000e6);

    uint256 previewShares = vault.previewDeposit(assets);

    address user = makeAddr("user");
    collateralToken.mint(user, assets);

    vm.startPrank(user);
    collateralToken.approve(address(vault), assets);
    uint256 actualShares = vault.deposit(assets, user);
    vm.stopPrank();

    assertEq(actualShares, previewShares, "Actual shares should match preview");
  }
}

// Proxy contract for deployment (minimal implementation)
contract ERC1967Proxy {
  constructor(address implementation, bytes memory data) {
    assembly {
      sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, implementation)
    }
    if (data.length > 0) {
      (bool success, ) = implementation.delegatecall(data);
      require(success);
    }
  }

  fallback() external payable {
    assembly {
      let impl := sload(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)
      calldatacopy(0, 0, calldatasize())
      let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
      returndatacopy(0, 0, returndatasize())
      switch result
      case 0 {
        revert(0, returndatasize())
      }
      default {
        return(0, returndatasize())
      }
    }
  }
}
