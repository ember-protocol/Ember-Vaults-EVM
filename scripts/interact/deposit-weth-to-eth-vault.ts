import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Deposit WETH into an EmberETHVault using standard ERC4626 deposit()
 *
 * Usage:
 *   VAULT=<VAULT_KEY> AMOUNT=<AMOUNT> yarn interact:deposit-weth --network <NETWORK>
 *
 * Environment Variables:
 *   VAULT   - ETH Vault key from deployment JSON (required)
 *   AMOUNT  - Amount of WETH to deposit (e.g., 0.1, 1, 10) (required)
 *
 * Examples:
 *   VAULT=emberEthVault AMOUNT=0.1 yarn interact:deposit-weth --network sepolia
 */

async function main() {
  console.log("\n💰 Depositing WETH to EmberETHVault...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Depositing with account:", signer.address);
  console.log(
    "Account ETH balance:",
    ethers.formatEther(await ethers.provider.getBalance(signer.address)),
    "ETH\n"
  );

  // Read environment variables
  const vaultKey = process.env.VAULT;
  const amountInput = process.env.AMOUNT;

  if (!vaultKey || !amountInput) {
    console.error("❌ Error: Missing required environment variables!\n");
    console.log("Usage:");
    console.log(
      "  VAULT=<VAULT_KEY> AMOUNT=<AMOUNT> yarn interact:deposit-weth --network <NETWORK>\n"
    );
    console.log("Environment Variables:");
    console.log("  VAULT   - ETH Vault key from deployment JSON (required)");
    console.log("  AMOUNT  - Amount of WETH to deposit (e.g., 0.1, 1, 10) (required)\n");
    console.log("Examples:");
    console.log("  VAULT=emberEthVault AMOUNT=0.1 yarn interact:deposit-weth --network sepolia");
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
  const wethAddress = vaultInfo.collateralToken;

  console.log("Vault Information:");
  console.log("  Name:", vaultInfo.name);
  console.log("  Address:", vaultAddress);
  console.log("  WETH Address:", wethAddress);

  // Parse amount (18 decimals for WETH)
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

  console.log("\nDeposit Parameters:");
  console.log("  Depositor:", signer.address);
  console.log("  Amount:", amountInput, "WETH");
  console.log("  Amount (wei):", amountInWei.toString());

  // Get contract instances
  const weth = await ethers.getContractAt("MockWETH", wethAddress);
  const vault = await ethers.getContractAt("EmberETHVault", vaultAddress);

  // Check WETH balance
  const wethBalance = await weth.balanceOf(signer.address);
  console.log("\nWETH balance:", ethers.formatEther(wethBalance), "WETH");

  if (wethBalance < amountInWei) {
    console.error("\n❌ Error: Insufficient WETH balance!");
    console.log("Required:", amountInput, "WETH");
    console.log("Available:", ethers.formatEther(wethBalance), "WETH");
    console.log("\n💡 Tip: Wrap ETH to WETH first using: weth.deposit({ value: amount })");
    process.exit(1);
  }

  // Check and set allowance
  const currentAllowance = await weth.allowance(signer.address, vaultAddress);
  console.log("Current allowance:", ethers.formatEther(currentAllowance), "WETH");

  if (currentAllowance < amountInWei) {
    console.log("\n⏳ Approving vault to spend WETH...");
    const approveTx = await weth.approve(vaultAddress, amountInWei);
    console.log("Approval tx:", approveTx.hash);
    await approveTx.wait();
    console.log("✅ Approval confirmed");
  } else {
    console.log("✅ Sufficient allowance already set");
  }

  // Get shares before deposit
  const sharesBefore = await vault.balanceOf(signer.address);
  const sharesSymbol = await vault.symbol();

  console.log("\nShares before deposit:", ethers.formatEther(sharesBefore), sharesSymbol);

  // Perform deposit
  console.log("\n⏳ Depositing WETH to vault...");
  const depositTx = await vault.deposit(amountInWei, signer.address);
  console.log("Deposit tx:", depositTx.hash);
  const receipt = await depositTx.wait();
  console.log("✅ Deposit confirmed in block:", receipt?.blockNumber);

  // Get shares after deposit
  const sharesAfter = await vault.balanceOf(signer.address);
  const sharesReceived = sharesAfter - sharesBefore;

  console.log("\nShares after deposit:", ethers.formatEther(sharesAfter), sharesSymbol);
  console.log("Shares received:", ethers.formatEther(sharesReceived), sharesSymbol);

  // Get vault TVL
  const tvl = await vault.totalAssets();
  console.log("\nVault TVL:", ethers.formatEther(tvl), "WETH");

  console.log("\n" + "=".repeat(60));
  console.log("🎉 WETH Deposit successful!");
  console.log("=".repeat(60) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
