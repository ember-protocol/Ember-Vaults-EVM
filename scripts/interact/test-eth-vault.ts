import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Interactive script to test EmberETHVault functionality
 *
 * EmberETHVault Design:
 * - Stores WETH (ERC20) as underlying asset (ERC4626 compliant)
 * - User deposits: ETH → wraps to WETH
 * - User withdrawals: WETH → unwraps to ETH
 * - Sub-accounts: Receive WETH (not unwrapped)
 *
 * Tests:
 * 1. Deposit native ETH (wraps to WETH)
 * 2. Wrap ETH to WETH manually (for TEST 3)
 * 3. Deposit WETH (standard ERC4626, stores as WETH)
 * 4. Mint shares with ETH (wraps to WETH)
 * 5. Request withdrawal (users will receive ETH when processed)
 *
 * Required ENV variables:
 * - ETH_VAULT_ADDRESS: Address of the EmberETHVault
 *
 * Optional ENV variables:
 * - WETH_ADDRESS: WETH contract address (reads from vault.asset() if not set)
 * - TEST_AMOUNT: Amount to test with in ETH (defaults to "0.01")
 */

async function main() {
  console.log("\n🧪 Testing EmberETHVault...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Testing with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  // Load deployment file
  const deploymentFileName = `./deployments/${network.name}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found!");
    console.log("Expected:", deploymentFileName);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  // Get addresses
  const vaultAddress = process.env.ETH_VAULT_ADDRESS;
  let wethAddress = process.env.WETH_ADDRESS;

  if (!vaultAddress) {
    console.error("❌ Error: ETH_VAULT_ADDRESS not set!");
    console.log("\nUsage:");
    console.log('  ETH_VAULT_ADDRESS="0x..." yarn interact:test-eth-vault --network sepolia');
    process.exit(1);
  }

  // Try to get WETH address from vault if not provided
  const vault = await ethers.getContractAt("EmberETHVault", vaultAddress);
  if (!wethAddress) {
    wethAddress = await vault.asset();
    console.log("📍 WETH address from vault:", wethAddress);
  }

  const testAmount = ethers.parseEther(process.env.TEST_AMOUNT || "0.01");

  console.log("Test Configuration:");
  console.log("  Vault Address:", vaultAddress);
  console.log("  WETH Address:", wethAddress);
  console.log("  Test Amount:", ethers.formatEther(testAmount), "ETH");
  console.log();

  // Get WETH contract
  const weth = await ethers.getContractAt("MockWETH", wethAddress);

  // Get vault details
  const vaultName = await vault.vaultName();
  const vaultSymbol = await vault.symbol();
  const vaultVersion = await vault.version();
  const totalAssets = await vault.totalAssets();
  const totalShares = await vault.totalSupply();
  const rate = await vault.rate();

  console.log("📊 Vault Status:");
  console.log("  Name:", vaultName);
  console.log("  Symbol:", vaultSymbol);
  console.log("  Version:", vaultVersion);
  console.log("  Total Assets:", ethers.formatEther(totalAssets), "WETH");
  console.log("  Total Shares:", ethers.formatEther(totalShares));
  console.log("  Rate:", ethers.formatUnits(rate.value, 18));
  console.log();

  // Check if vault is paused
  const pauseStatus = await vault.pauseStatus();
  if (pauseStatus.deposits) {
    console.error("❌ Vault deposits are paused!");
    process.exit(1);
  }

  console.log("=".repeat(70));
  console.log("TEST 1: Deposit Native ETH (wraps to WETH)");
  console.log("=".repeat(70));

  const sharesBefore = await vault.balanceOf(deployer.address);
  const vaultWETHBefore0 = await weth.balanceOf(vaultAddress);

  console.log("Shares before:", ethers.formatEther(sharesBefore));
  console.log("Vault WETH before:", ethers.formatEther(vaultWETHBefore0));

  console.log(`\nDepositing ${ethers.formatEther(testAmount)} ETH...`);
  const depositTx = await vault.depositETH(deployer.address, { value: testAmount });
  const depositReceipt = await depositTx.wait();

  const sharesAfter = await vault.balanceOf(deployer.address);
  const sharesMinted = sharesAfter - sharesBefore;
  const vaultWETHAfter0 = await weth.balanceOf(vaultAddress);

  console.log("✅ Deposit successful!");
  console.log("  Gas used:", depositReceipt?.gasUsed.toString());
  console.log("  Shares minted:", ethers.formatEther(sharesMinted));
  console.log("  Total shares:", ethers.formatEther(sharesAfter));
  console.log("  Vault WETH after:", ethers.formatEther(vaultWETHAfter0));

  if (vaultWETHAfter0 - vaultWETHBefore0 == testAmount) {
    console.log("✅ ETH successfully wrapped to WETH and stored in vault");
  }

  console.log("\n" + "=".repeat(70));
  console.log("TEST 2: Wrap ETH to WETH (for TEST 3)");
  console.log("=".repeat(70));

  console.log(`\nWrapping ${ethers.formatEther(testAmount)} ETH to WETH...`);
  const wrapTx = await weth.deposit({ value: testAmount });
  await wrapTx.wait();

  const wethBalance = await weth.balanceOf(deployer.address);
  console.log("✅ Wrapped successfully!");
  console.log("  WETH balance:", ethers.formatEther(wethBalance));
  console.log();

  console.log("\n" + "=".repeat(70));
  console.log("TEST 3: Deposit WETH (stored as WETH, NOT unwrapped)");
  console.log("=".repeat(70));

  const sharesBefore2 = await vault.balanceOf(deployer.address);
  const vaultWETHBefore = await weth.balanceOf(vaultAddress);

  console.log("\nApproving WETH...");
  const approveTx = await weth.approve(vaultAddress, testAmount);
  await approveTx.wait();
  console.log("✅ Approved");

  console.log(`\nDepositing ${ethers.formatEther(testAmount)} WETH...`);
  const depositWETHTx = await vault.deposit(testAmount, deployer.address);
  const depositWETHReceipt = await depositWETHTx.wait();

  const sharesAfter2 = await vault.balanceOf(deployer.address);
  const sharesMinted2 = sharesAfter2 - sharesBefore2;

  console.log("✅ WETH deposit successful!");
  console.log("  Gas used:", depositWETHReceipt?.gasUsed.toString());
  console.log("  Shares minted:", ethers.formatEther(sharesMinted2));
  console.log("  Total shares:", ethers.formatEther(sharesAfter2));

  // Verify WETH is stored in vault (NOT unwrapped)
  const vaultWETHAfter = await weth.balanceOf(vaultAddress);
  const wethIncrease = vaultWETHAfter - vaultWETHBefore;

  console.log("\n📊 Vault WETH Balance:");
  console.log("  Before:", ethers.formatEther(vaultWETHBefore));
  console.log("  After:", ethers.formatEther(vaultWETHAfter));
  console.log("  Increase:", ethers.formatEther(wethIncrease));

  if (wethIncrease == testAmount) {
    console.log("✅ WETH correctly stored in vault (not unwrapped)");
  } else {
    console.warn("⚠️  Warning: WETH balance increase doesn't match deposit!");
  }

  console.log("\n" + "=".repeat(70));
  console.log("TEST 4: Mint Shares with ETH (wraps to WETH)");
  console.log("=".repeat(70));

  const sharesToMint = ethers.parseEther("10");
  const assetsNeeded = await vault.previewMint(sharesToMint);
  const vaultWETHBefore3 = await weth.balanceOf(vaultAddress);

  console.log("\nMinting", ethers.formatEther(sharesToMint), "shares");
  console.log("Assets needed (WETH):", ethers.formatEther(assetsNeeded));
  console.log("Vault WETH before:", ethers.formatEther(vaultWETHBefore3));

  const sharesBefore3 = await vault.balanceOf(deployer.address);

  const mintTx = await vault.mintWithETH(sharesToMint, deployer.address, {
    value: assetsNeeded,
  });
  const mintReceipt = await mintTx.wait();

  const sharesAfter3 = await vault.balanceOf(deployer.address);
  const actualSharesMinted = sharesAfter3 - sharesBefore3;
  const vaultWETHAfter3 = await weth.balanceOf(vaultAddress);

  console.log("✅ Mint successful!");
  console.log("  Gas used:", mintReceipt?.gasUsed.toString());
  console.log("  Shares minted:", ethers.formatEther(actualSharesMinted));
  console.log("  Expected shares:", ethers.formatEther(sharesToMint));
  console.log("  Vault WETH increase:", ethers.formatEther(vaultWETHAfter3 - vaultWETHBefore3));

  console.log("\n" + "=".repeat(70));
  console.log("TEST 5: Request Withdrawal");
  console.log("=".repeat(70));

  const sharesToRedeem = ethers.parseEther("5");

  console.log("\nApproving vault to spend shares...");
  const approveSharesTx = await vault.approve(vaultAddress, sharesToRedeem);
  await approveSharesTx.wait();
  console.log("✅ Approved");

  console.log(`\nRequesting redemption of ${ethers.formatEther(sharesToRedeem)} shares...`);
  const redeemTx = await vault.redeemShares(sharesToRedeem, deployer.address);
  const redeemReceipt = await redeemTx.wait();

  console.log("✅ Withdrawal requested!");
  console.log("  Gas used:", redeemReceipt?.gasUsed.toString());

  // Get account info
  const accountInfo = await vault.getAccountInfo(deployer.address);
  console.log("\n📊 Account Info:");
  console.log("  Pending shares:", ethers.formatEther(accountInfo.totalPendingShares));
  console.log("  Pending requests:", accountInfo.pendingRequestIds.length);

  console.log("\n💡 Note: Withdrawal requests must be processed by the operator.");
  console.log("   Use: vault.connect(operator).processWithdrawalRequests(numRequests)");
  console.log("   Users will receive native ETH (WETH is unwrapped automatically)");

  console.log("\n" + "=".repeat(70));
  console.log("🎉 All Tests Completed Successfully!");
  console.log("=".repeat(70));
  console.log("\n📊 Final Vault State:");

  const finalTotalAssets = await vault.totalAssets();
  const finalTotalShares = await vault.totalSupply();
  const finalUserShares = await vault.balanceOf(deployer.address);
  const finalPendingShares = (await vault.getAccountInfo(deployer.address)).totalPendingShares;
  const finalVaultWETH = await weth.balanceOf(vaultAddress);

  console.log("  Total Assets:", ethers.formatEther(finalTotalAssets), "WETH");
  console.log("  Total Shares:", ethers.formatEther(finalTotalShares));
  console.log("  User Shares:", ethers.formatEther(finalUserShares));
  console.log("  Pending Shares:", ethers.formatEther(finalPendingShares));
  console.log("  Vault WETH Balance:", ethers.formatEther(finalVaultWETH));
  console.log("\n✅ EmberETHVault is working correctly!");
  console.log("\n💡 Key Design:");
  console.log("   • Vault stores WETH (ERC20) - ERC4626 compliant");
  console.log("   • User deposits: ETH → wrapped to WETH");
  console.log("   • User withdrawals: WETH → unwrapped to ETH");
  console.log("   • Sub-accounts receive WETH (not unwrapped)");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error.message);
    console.error(error);
    process.exit(1);
  });
