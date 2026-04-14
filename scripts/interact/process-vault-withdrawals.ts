import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Process pending withdrawal requests from EmberVault (Operator only)
 * Withdrawals are sent as the vault collateral ERC20 token
 *
 * Usage:
 *   VAULT=<VAULT_KEY> COUNT=<NUM_REQUESTS> yarn interact:process-withdrawals --network <NETWORK>
 *
 * Environment Variables:
 *   VAULT  - Vault key from deployment JSON (required)
 *   COUNT  - Number of requests to process (optional, defaults to all pending)
 *
 * Examples:
 *   VAULT=emberErc4626TestVault yarn interact:process-withdrawals --network sepolia
 *   VAULT=emberErc4626TestVault COUNT=5 yarn interact:process-withdrawals --network sepolia
 */

async function main() {
  console.log("\n⚙️ Processing Withdrawal Requests from EmberVault...\n");

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
    console.log("  VAULT=<VAULT_KEY> yarn interact:process-withdrawals --network <NETWORK>\n");
    console.log("Environment Variables:");
    console.log("  VAULT  - Vault key from deployment JSON (required)");
    console.log("  COUNT  - Number of requests to process (optional)\n");
    console.log("Examples:");
    console.log(
      "  VAULT=emberErc4626TestVault yarn interact:process-withdrawals --network sepolia"
    );
    process.exit(1);
  }

  // Load deployment file
  const deploymentFileName = `deployments/${network.name}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error(`❌ Error: Deployment file not found: ${deploymentFileName}`);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  // Check if standard vault exists
  if (!deploymentInfo.contracts?.vaults?.[vaultKey]) {
    console.error(`❌ Error: Vault '${vaultKey}' not found!\n`);
    console.log("Available vaults:");
    if (deploymentInfo.contracts?.vaults) {
      Object.keys(deploymentInfo.contracts.vaults).forEach((key) => {
        const vault = deploymentInfo.contracts.vaults[key];
        console.log(`  - ${key}: ${vault.name}`);
      });
    } else {
      console.log("  (none)");
    }
    process.exit(1);
  }

  const vaultInfo = deploymentInfo.contracts.vaults[vaultKey];
  const vaultAddress = vaultInfo.proxyAddress;

  console.log("Vault Information:");
  console.log("  Name:", vaultInfo.name);
  console.log("  Address:", vaultAddress);
  console.log("  Operator:", vaultInfo.operator);

  // Get vault contract
  const vault = await ethers.getContractAt("EmberVault", vaultAddress);

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

  // Get vault collateral token balance
  const assetAddress = await vault.asset();
  const asset = new ethers.Contract(
    assetAddress,
    [
      "function balanceOf(address) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
    ],
    ethers.provider
  );
  const [vaultAssetBalance, assetDecimals, assetSymbol] = await Promise.all([
    asset.balanceOf(vaultAddress),
    asset.decimals(),
    asset.symbol(),
  ]);
  console.log(
    "\nVault asset balance:",
    ethers.formatUnits(vaultAssetBalance, assetDecimals),
    assetSymbol
  );

  // Process withdrawals
  console.log("\n⏳ Processing withdrawal requests...");
  console.log("   (Assets will be transferred as vault collateral token)");

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
          "  Assets withdrawn:",
          ethers.formatUnits(parsed.args.totalAmountWithdrawn, assetDecimals),
          assetSymbol
        );
      }
    }
  }

  // Get updated stats
  const pendingAfter = await vault.getPendingWithdrawalsLength();
  const vaultAssetAfter = await asset.balanceOf(vaultAddress);

  console.log("\nAfter processing:");
  console.log("  Remaining pending requests:", pendingAfter.toString());
  console.log(
    "  Vault asset balance:",
    ethers.formatUnits(vaultAssetAfter, assetDecimals),
    assetSymbol
  );

  console.log("\n" + "=".repeat(60));
  console.log("🎉 Withdrawal requests processed!");
  console.log("   Recipients have received collateral assets");
  console.log("=".repeat(60) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
