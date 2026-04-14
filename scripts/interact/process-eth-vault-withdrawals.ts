import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Process pending withdrawal requests from EmberETHVault (Operator only)
 * Withdrawals are sent as native ETH (WETH is unwrapped automatically)
 *
 * Usage:
 *   VAULT=<VAULT_KEY> COUNT=<NUM_REQUESTS> yarn interact:process-eth-withdrawals --network <NETWORK>
 *
 * Environment Variables:
 *   VAULT  - ETH Vault key from deployment JSON (required)
 *   COUNT  - Number of requests to process (optional, defaults to all pending)
 *
 * Examples:
 *   VAULT=emberEthVault yarn interact:process-eth-withdrawals --network sepolia
 *   VAULT=emberEthVault COUNT=5 yarn interact:process-eth-withdrawals --network sepolia
 */

async function main() {
  console.log("\n⚙️ Processing Withdrawal Requests from EmberETHVault...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Processing with account:", signer.address);
  console.log(
    "Account ETH balance:",
    ethers.formatEther(await ethers.provider.getBalance(signer.address)),
    "ETH\n"
  );

  // Read environment variables
  const vaultKey = process.env.VAULT;
  const countInput = process.env.COUNT;

  if (!vaultKey) {
    console.error("❌ Error: Missing VAULT environment variable!\n");
    console.log("Usage:");
    console.log("  VAULT=<VAULT_KEY> yarn interact:process-eth-withdrawals --network <NETWORK>\n");
    console.log("Environment Variables:");
    console.log("  VAULT  - ETH Vault key from deployment JSON (required)");
    console.log("  COUNT  - Number of requests to process (optional)\n");
    console.log("Examples:");
    console.log("  VAULT=emberEthVault yarn interact:process-eth-withdrawals --network sepolia");
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
  console.log("  Operator:", vaultInfo.operator);

  // Get vault contract
  const vault = await ethers.getContractAt("EmberETHVault", vaultAddress);

  // Check if signer is operator
  const roles = await vault.roles();
  if (roles.operator.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("\n❌ Error: Only the operator can process withdrawals!");
    console.log("Operator:", roles.operator);
    console.log("Your address:", signer.address);
    process.exit(1);
  }

  // Get pending withdrawals count
  const pendingLength = await vault.getPendingWithdrawalsLength();
  console.log("\nPending withdrawal requests:", pendingLength.toString());

  if (pendingLength === 0n) {
    console.log("\n✅ No pending withdrawal requests to process.");
    process.exit(0);
  }

  // Determine how many to process
  let numToProcess = pendingLength;
  if (countInput) {
    const requested = BigInt(countInput);
    numToProcess = requested < pendingLength ? requested : pendingLength;
  }

  console.log("Requests to process:", numToProcess.toString());

  // Get vault WETH balance
  const wethAddress = await vault.asset();
  const weth = await ethers.getContractAt("MockWETH", wethAddress);
  const vaultWethBalance = await weth.balanceOf(vaultAddress);
  console.log("\nVault WETH balance:", ethers.formatEther(vaultWethBalance), "WETH");

  // Process withdrawals
  console.log("\n⏳ Processing withdrawal requests...");
  console.log("   (WETH will be unwrapped and sent as ETH to recipients)");

  const tx = await vault.processWithdrawalRequests(numToProcess);
  console.log("Transaction hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ Processing confirmed in block:", receipt?.blockNumber);

  // Parse events from receipt
  if (receipt?.logs) {
    const processedEvents = receipt.logs.filter((log) => {
      try {
        const parsed = vault.interface.parseLog({ topics: [...log.topics], data: log.data });
        return parsed?.name === "ProcessRequestsSummary";
      } catch {
        return false;
      }
    });

    if (processedEvents.length > 0) {
      const parsed = vault.interface.parseLog({
        topics: [...processedEvents[0].topics],
        data: processedEvents[0].data,
      });
      if (parsed) {
        console.log("\n📊 Processing Summary:");
        console.log("  Total processed:", parsed.args.totalRequestProcessed.toString());
        console.log("  Skipped:", parsed.args.requestsSkipped.toString());
        console.log("  Cancelled:", parsed.args.requestsCancelled.toString());
        console.log("  Shares burnt:", ethers.formatEther(parsed.args.totalSharesBurnt));
        console.log(
          "  ETH withdrawn:",
          ethers.formatEther(parsed.args.totalAmountWithdrawn),
          "ETH"
        );
      }
    }
  }

  // Get updated stats
  const pendingAfter = await vault.getPendingWithdrawalsLength();
  const vaultWethAfter = await weth.balanceOf(vaultAddress);

  console.log("\nAfter processing:");
  console.log("  Remaining pending requests:", pendingAfter.toString());
  console.log("  Vault WETH balance:", ethers.formatEther(vaultWethAfter), "WETH");

  console.log("\n" + "=".repeat(60));
  console.log("🎉 Withdrawal requests processed!");
  console.log("   Recipients have received native ETH");
  console.log("=".repeat(60) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
