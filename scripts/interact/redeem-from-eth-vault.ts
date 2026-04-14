import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Request withdrawal from EmberETHVault by redeeming shares
 * Creates a withdrawal request that will be processed by the operator
 * When processed, user will receive native ETH (WETH is unwrapped)
 *
 * Usage:
 *   VAULT=<VAULT_KEY> SHARES=<AMOUNT> yarn interact:redeem-eth-vault --network <NETWORK>
 *
 * Environment Variables:
 *   VAULT    - ETH Vault key from deployment JSON (required)
 *   SHARES   - Amount of shares to redeem (e.g., 0.1, 1, 10) (required)
 *   RECEIVER - Address to receive ETH when processed (optional, defaults to signer)
 *
 * Examples:
 *   VAULT=emberEthVault SHARES=1 yarn interact:redeem-eth-vault --network sepolia
 *   VAULT=emberEthVault SHARES=10 RECEIVER=0x123... yarn interact:redeem-eth-vault --network sepolia
 */

async function main() {
  console.log("\n📤 Requesting Withdrawal from EmberETHVault...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Requesting with account:", signer.address);
  console.log(
    "Account ETH balance:",
    ethers.formatEther(await ethers.provider.getBalance(signer.address)),
    "ETH\n"
  );

  // Read environment variables
  const vaultKey = process.env.VAULT;
  const sharesInput = process.env.SHARES;
  const receiver = process.env.RECEIVER || signer.address;

  if (!vaultKey || !sharesInput) {
    console.error("❌ Error: Missing required environment variables!\n");
    console.log("Usage:");
    console.log(
      "  VAULT=<VAULT_KEY> SHARES=<AMOUNT> yarn interact:redeem-eth-vault --network <NETWORK>\n"
    );
    console.log("Environment Variables:");
    console.log("  VAULT    - ETH Vault key from deployment JSON (required)");
    console.log("  SHARES   - Amount of shares to redeem (e.g., 0.1, 1, 10) (required)");
    console.log("  RECEIVER - Address to receive ETH when processed (optional)\n");
    console.log("Examples:");
    console.log("  VAULT=emberEthVault SHARES=1 yarn interact:redeem-eth-vault --network sepolia");
    process.exit(1);
  }

  // Validate receiver address
  if (!ethers.isAddress(receiver)) {
    console.error("❌ Error: Invalid receiver address:", receiver);
    process.exit(1);
  }

  // Load deployment file
  const deploymentFileName = `deployments/${network.name}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error(`❌ Error: Deployment file not found: ${deploymentFileName}`);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  // Check if ETH vault exists
  if (!deploymentInfo.contracts?.ethVaults?.[vaultKey]) {
    console.error(`❌ Error: ETH Vault '${vaultKey}' not found!\n`);
    console.log("Available ETH vaults:");
    if (deploymentInfo.contracts?.ethVaults) {
      Object.keys(deploymentInfo.contracts.ethVaults).forEach((key) => {
        const vault = deploymentInfo.contracts.ethVaults[key];
        console.log(`  - ${key}: ${vault.name}`);
      });
    } else {
      console.log("  (none)");
    }
    process.exit(1);
  }

  const vaultInfo = deploymentInfo.contracts.ethVaults[vaultKey];
  const vaultAddress = vaultInfo.proxyAddress;

  console.log("Vault Information:");
  console.log("  Name:", vaultInfo.name);
  console.log("  Address:", vaultAddress);

  // Parse shares amount (18 decimals)
  let sharesInWei: bigint;
  try {
    sharesInWei = ethers.parseEther(sharesInput);
  } catch {
    console.error("\n❌ Error: Invalid shares amount!");
    process.exit(1);
  }

  if (sharesInWei <= 0n) {
    console.error("❌ Error: Shares must be greater than 0");
    process.exit(1);
  }

  // Get vault contract
  const vault = await ethers.getContractAt("EmberETHVault", vaultAddress);
  const sharesSymbol = await vault.symbol();

  // Check user's share balance
  const shareBalance = await vault.balanceOf(signer.address);
  console.log("\nYour share balance:", ethers.formatEther(shareBalance), sharesSymbol);

  if (shareBalance < sharesInWei) {
    console.error("\n❌ Error: Insufficient share balance!");
    console.log("Requested:", sharesInput, sharesSymbol);
    console.log("Available:", ethers.formatEther(shareBalance), sharesSymbol);
    process.exit(1);
  }

  // Check minimum withdrawable shares
  const minWithdrawable = await vault.minWithdrawableShares();
  if (sharesInWei < minWithdrawable) {
    console.error("\n❌ Error: Shares below minimum withdrawable!");
    console.log("Requested:", ethers.formatEther(sharesInWei), sharesSymbol);
    console.log("Minimum:", ethers.formatEther(minWithdrawable), sharesSymbol);
    process.exit(1);
  }

  // Preview withdrawal amount
  const estimatedETH = await vault.convertToAssets(sharesInWei);
  console.log("\nRedemption Parameters:");
  console.log("  Shares to redeem:", sharesInput, sharesSymbol);
  console.log("  Receiver:", receiver);
  console.log("  Estimated ETH:", ethers.formatEther(estimatedETH), "ETH");

  // Approve vault to take shares
  const currentAllowance = await vault.allowance(signer.address, vaultAddress);
  console.log("\nCurrent share allowance:", ethers.formatEther(currentAllowance), sharesSymbol);

  if (currentAllowance < sharesInWei) {
    console.log("\n⏳ Approving vault to spend shares...");
    const approveTx = await vault.approve(vaultAddress, sharesInWei);
    console.log("Approval tx:", approveTx.hash);
    await approveTx.wait();
    console.log("✅ Approval confirmed");
  } else {
    console.log("✅ Sufficient allowance already set");
  }

  // Request redemption
  console.log("\n⏳ Submitting redemption request...");
  const redeemTx = await vault.redeemShares(sharesInWei, receiver);
  console.log("Transaction hash:", redeemTx.hash);
  const receipt = await redeemTx.wait();
  console.log("✅ Redemption request confirmed in block:", receipt?.blockNumber);

  // Get updated share balance
  const shareBalanceAfter = await vault.balanceOf(signer.address);
  console.log("\nShare balance after:", ethers.formatEther(shareBalanceAfter), sharesSymbol);

  // Get pending withdrawals info
  const pendingLength = await vault.getPendingWithdrawalsLength();
  console.log("Pending withdrawal requests in queue:", pendingLength.toString());

  console.log("\n" + "=".repeat(60));
  console.log("🎉 Withdrawal request submitted!");
  console.log("=".repeat(60));
  console.log("\n📋 Next Steps:");
  console.log("   1. Wait for operator to process withdrawal requests");
  console.log("   2. When processed, you will receive", ethers.formatEther(estimatedETH), "ETH");
  console.log("   3. ETH will be sent to:", receiver);
  console.log("\n⚠️  Note: Actual ETH received may vary based on rate at processing time\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
