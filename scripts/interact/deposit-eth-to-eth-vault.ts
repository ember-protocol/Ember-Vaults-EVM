import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Deposit native ETH into an EmberETHVault using depositETH()
 * ETH is automatically wrapped to WETH inside the vault
 *
 * Usage:
 *   VAULT=<VAULT_KEY> AMOUNT=<AMOUNT> yarn interact:deposit-eth --network <NETWORK>
 *
 * Environment Variables:
 *   VAULT   - ETH Vault key from deployment JSON (required)
 *   AMOUNT  - Amount of ETH to deposit (e.g., 0.1, 1, 10) (required)
 *
 * Examples:
 *   VAULT=emberEthVault AMOUNT=0.1 yarn interact:deposit-eth --network sepolia
 */

async function main() {
  console.log("\n💰 Depositing ETH to EmberETHVault (auto-wraps to WETH)...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Depositing with account:", signer.address);

  const ethBalance = await ethers.provider.getBalance(signer.address);
  console.log("Account ETH balance:", ethers.formatEther(ethBalance), "ETH\n");

  // Read environment variables
  const vaultKey = process.env.VAULT;
  const amountInput = process.env.AMOUNT;

  if (!vaultKey || !amountInput) {
    console.error("❌ Error: Missing required environment variables!\n");
    console.log("Usage:");
    console.log(
      "  VAULT=<VAULT_KEY> AMOUNT=<AMOUNT> yarn interact:deposit-eth --network <NETWORK>\n"
    );
    console.log("Environment Variables:");
    console.log("  VAULT   - ETH Vault key from deployment JSON (required)");
    console.log("  AMOUNT  - Amount of ETH to deposit (e.g., 0.1, 1, 10) (required)\n");
    console.log("Examples:");
    console.log("  VAULT=emberEthVault AMOUNT=0.1 yarn interact:deposit-eth --network sepolia");
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
  console.log("  Collateral (WETH):", vaultInfo.collateralToken);

  // Parse amount
  let amountInWei: bigint;
  try {
    amountInWei = ethers.parseEther(amountInput);
  } catch {
    console.error("\n❌ Error: Invalid amount format!");
    process.exit(1);
  }

  if (amountInWei <= 0n) {
    console.error("❌ Error: Amount must be greater than 0");
    process.exit(1);
  }

  // Check ETH balance (need extra for gas)
  const estimatedGas = ethers.parseEther("0.01"); // Reserve for gas
  if (ethBalance < amountInWei + estimatedGas) {
    console.error("\n❌ Error: Insufficient ETH balance!");
    console.log("Required:", amountInput, "ETH + gas");
    console.log("Available:", ethers.formatEther(ethBalance), "ETH");
    process.exit(1);
  }

  console.log("\nDeposit Parameters:");
  console.log("  Depositor:", signer.address);
  console.log("  Amount:", amountInput, "ETH");
  console.log("  Amount (wei):", amountInWei.toString());

  // Get vault contract
  const vault = await ethers.getContractAt("EmberETHVault", vaultAddress);

  // Get shares before deposit
  const sharesBefore = await vault.balanceOf(signer.address);
  const sharesSymbol = await vault.symbol();

  console.log("\nShares before deposit:", ethers.formatEther(sharesBefore), sharesSymbol);

  // Perform depositETH (sends native ETH, vault wraps to WETH)
  console.log("\n⏳ Depositing ETH to vault (wrapping to WETH)...");
  const depositTx = await vault.depositETH(signer.address, { value: amountInWei });
  console.log("Deposit tx:", depositTx.hash);
  const receipt = await depositTx.wait();
  console.log("✅ Deposit confirmed in block:", receipt?.blockNumber);

  // Get shares after deposit
  const sharesAfter = await vault.balanceOf(signer.address);
  const sharesReceived = sharesAfter - sharesBefore;

  console.log("\nShares after deposit:", ethers.formatEther(sharesAfter), sharesSymbol);
  console.log("Shares received:", ethers.formatEther(sharesReceived), sharesSymbol);

  // Get updated ETH balance
  const ethBalanceAfter = await ethers.provider.getBalance(signer.address);
  console.log("\nETH balance after:", ethers.formatEther(ethBalanceAfter), "ETH");

  // Get vault TVL
  const tvl = await vault.totalAssets();
  console.log("Vault TVL:", ethers.formatEther(tvl), "WETH");

  console.log("\n" + "=".repeat(60));
  console.log("🎉 ETH Deposit successful!");
  console.log("   ETH was wrapped to WETH inside the vault");
  console.log("=".repeat(60) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
