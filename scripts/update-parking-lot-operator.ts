import { ethers } from "hardhat";
import * as fs from "fs";

type DeploymentInfo = {
  contracts?: {
    depositParkingLots?: Record<string, ParkingLotRecord>;
  };
};

type ParkingLotRecord = {
  proxyAddress?: string;
  vault?: string;
  operator?: string;
  operatorUpdatedAt?: string;
  [key: string]: unknown;
};

/**
 * Updates the operator on one or more deposit parking lots.
 * The lot operator forwards queued deposits into the vault; it is separate from
 * the vault's own operator, so changing one does not change the other.
 *
 * Usage:
 *   NEW_OPERATOR=0x... PARKING_LOT_KEYS=<KEY_1>,<KEY_2> yarn admin:update-parking-lot-operator --network <NETWORK>
 *
 * Required ENV variables:
 *   NEW_OPERATOR     - Address of the new operator
 *
 * Optional ENV variables:
 *   PARKING_LOT_KEYS - Comma-separated keys under contracts.depositParkingLots
 *                      (omit to process all parking lots)
 *
 * Notes:
 * - Calls EmberDepositParkingLot.setOperator directly (not via the protocol
 *   config). It is onlyVaultAdmin: the signer must be the admin of the vault
 *   each lot is bound to (admin is per-vault).
 * - Rejects the zero address and protocol-blacklisted accounts, and reverts
 *   SameValue if unchanged — all checked before sending.
 * - The deployment JSON's `operator` field is updated for each lot that
 *   confirms successfully. Failures are reported but do not abort the loop.
 */
async function main() {
  console.log("\n👤 Updating Parking Lot Operator...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(signer.address)),
    "ETH\n"
  );

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  console.log("📂 Loading deployment file:", deploymentFileName);
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8")) as DeploymentInfo;

  const lots = deploymentInfo.contracts?.depositParkingLots;
  if (!lots || Object.keys(lots).length === 0) {
    console.error("❌ Error: No parking lots found in deployment file!");
    process.exit(1);
  }

  const newOperator = process.env.NEW_OPERATOR;
  if (!newOperator) {
    console.error("❌ Error: Missing required environment variable NEW_OPERATOR!");
    console.log("\nRequired variables:");
    console.log("  NEW_OPERATOR     - Address of the new operator");
    console.log("\nOptional variables:");
    console.log("  PARKING_LOT_KEYS - Comma-separated parking lot keys (omit to update all)");

    console.log("\nAvailable parking lots:");
    Object.keys(lots).forEach((key) => {
      const lot = lots[key];
      console.log(`  - ${key}`);
      console.log(`      Address: ${lot.proxyAddress ?? "Missing"}`);
      console.log(`      Vault: ${lot.vault ?? "Unknown"}`);
      console.log(`      Current Operator: ${lot.operator ?? "Unknown"}`);
    });
    process.exit(1);
  }

  if (!ethers.isAddress(newOperator) || newOperator === ethers.ZeroAddress) {
    console.error(`❌ Error: Invalid NEW_OPERATOR address: ${newOperator}`);
    process.exit(1);
  }

  const lotKeysEnv = process.env.PARKING_LOT_KEYS;
  let lotKeysToProcess: string[];

  if (lotKeysEnv) {
    lotKeysToProcess = lotKeysEnv.split(",").map((key) => key.trim());
    console.log("🎯 Processing specific parking lots:", lotKeysToProcess.join(", "));
  } else {
    lotKeysToProcess = Object.keys(lots);
    console.log("🎯 Processing ALL parking lots:", lotKeysToProcess.join(", "));
  }

  for (const lotKey of lotKeysToProcess) {
    if (!lots[lotKey]) {
      console.error(`❌ Error: Parking lot '${lotKey}' not found in deployment file!`);
      console.log("Available parking lots:");
      Object.keys(lots).forEach((key) => {
        console.log(`  - ${key}`);
      });
      process.exit(1);
    }
  }

  console.log("Target Operator:", newOperator);

  console.log("\n" + "=".repeat(70));
  console.log("📋 Parking Lots to Process:");
  console.log("=".repeat(70));
  for (const lotKey of lotKeysToProcess) {
    const lotInfo = lots[lotKey];
    console.log(`\n${lotKey}:`);
    console.log(`  Address: ${lotInfo.proxyAddress ?? "Missing"}`);
    console.log(`  Vault: ${lotInfo.vault ?? "Unknown"}`);
    console.log(`  Stored Operator: ${String(lotInfo.operator ?? "Not set")}`);
  }
  console.log("\n" + "=".repeat(70));

  const results: Array<{
    lotKey: string;
    success: boolean;
    skipped?: boolean;
    reason?: string;
    blockNumber?: number;
    txHash?: string;
    error?: string;
  }> = [];

  let deploymentJsonChanged = false;

  for (const lotKey of lotKeysToProcess) {
    const lotInfo = lots[lotKey];

    console.log("\n" + "-".repeat(70));
    console.log(`🛠️ Processing ${lotKey}`);
    console.log("-".repeat(70));

    try {
      if (!lotInfo.proxyAddress) {
        throw new Error("Parking lot proxy address not found in deployment file");
      }

      const lot = await ethers.getContractAt("EmberDepositParkingLot", lotInfo.proxyAddress);
      const currentOperator = await lot.operator();
      // Read the binding and admin off chain rather than trusting the JSON: the
      // contract checks msg.sender against the bound vault's live admin.
      const vaultAddress = await lot.vault();
      const vault = await ethers.getContractAt("EmberVault", vaultAddress);
      const currentAdmin = (await vault.roles()).admin;
      const protocolConfig = await ethers.getContractAt(
        "EmberProtocolConfig",
        await lot.protocolConfig()
      );

      console.log("Parking Lot Address:", lotInfo.proxyAddress);
      console.log("Bound Vault:", vaultAddress);
      console.log("Vault Admin:", currentAdmin);
      console.log("Current Operator:", currentOperator);

      // Already at the target operator — skip the on-chain call but still
      // sync the deployment JSON if it's stale.
      if (currentOperator.toLowerCase() === newOperator.toLowerCase()) {
        console.log("✅ Operator already set on-chain. Skipping contract update.");
        if (lotInfo.operator !== newOperator) {
          lotInfo.operator = newOperator;
          deploymentJsonChanged = true;
          console.log("📝 Deployment JSON operator field synchronized.");
        }
        results.push({
          lotKey,
          success: true,
          skipped: true,
          reason: "Operator already set",
        });
        continue;
      }

      // Preflight checks (mirror EmberDepositParkingLot.setOperator)
      if (signer.address.toLowerCase() !== currentAdmin.toLowerCase()) {
        throw new Error(
          `Signer (${signer.address}) is not the vault admin (${currentAdmin}). Only the admin of the bound vault can change the parking lot operator.`
        );
      }
      if (await protocolConfig.isAccountBlacklisted(newOperator)) {
        throw new Error("New operator is blacklisted at the protocol level");
      }

      // Static-call simulation for a clearer revert reason on failure
      try {
        await lot.setOperator.staticCall(newOperator);
      } catch (staticCallError: any) {
        const detail = staticCallError.reason ?? staticCallError.message ?? "unknown";
        throw new Error(`Static-call simulation reverted: ${detail}`);
      }

      console.log("Updating operator on-chain...");
      const tx = await lot.setOperator(newOperator);
      console.log("Transaction hash:", tx.hash);

      const receipt = await tx.wait();
      console.log("Transaction confirmed in block:", receipt?.blockNumber);

      const updatedOperator = await lot.operator();
      if (updatedOperator.toLowerCase() !== newOperator.toLowerCase()) {
        throw new Error(
          `Operator verification failed. Expected ${newOperator} but got ${updatedOperator}`
        );
      }

      console.log("✅ Operator updated successfully.");

      lotInfo.operator = newOperator;
      lotInfo.operatorUpdatedAt = new Date().toISOString();
      deploymentJsonChanged = true;

      results.push({
        lotKey,
        success: true,
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
      });
    } catch (error: any) {
      console.error(`❌ Failed to process ${lotKey}:`, error.message);
      results.push({
        lotKey,
        success: false,
        error: error.message,
      });
    }
  }

  if (deploymentJsonChanged) {
    fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
    console.log("\n✅ Deployment file updated:", deploymentFileName);
  } else {
    console.log("\nℹ️ Deployment file unchanged.");
  }

  const successful = results.filter((result) => result.success && !result.skipped);
  const skipped = results.filter((result) => result.success && result.skipped);
  const failed = results.filter((result) => !result.success);

  console.log("\n" + "=".repeat(70));
  console.log("📊 PARKING LOT OPERATOR UPDATE SUMMARY");
  console.log("=".repeat(70));
  console.log(`\n✅ Updated: ${successful.length}`);
  console.log(`⏭️ Skipped: ${skipped.length}`);
  console.log(`❌ Failed: ${failed.length}`);

  for (const result of successful) {
    console.log(`  - ${result.lotKey} -> block ${String(result.blockNumber ?? "n/a")}`);
  }

  for (const result of skipped) {
    console.log(`  - ${result.lotKey} -> ${result.reason}`);
  }

  for (const result of failed) {
    console.log(`  - ${result.lotKey} -> ${result.error}`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
