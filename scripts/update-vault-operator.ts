import { ethers } from "hardhat";
import * as fs from "fs";

type DeploymentInfo = {
  contracts?: {
    protocolConfig?: {
      proxyAddress?: string;
    };
    vaults?: Record<string, VaultDeploymentRecord>;
    ethVaults?: Record<string, VaultDeploymentRecord>;
  };
};

type VaultDeploymentRecord = {
  proxyAddress?: string;
  name?: string;
  operator?: string;
  operatorUpdatedAt?: string;
  [key: string]: unknown;
};

/**
 * Updates the operator on one or more vaults.
 * The operator can update vault rates and process withdrawals.
 *
 * Usage:
 *   NEW_OPERATOR=0x... yarn admin:update-operator --network <NETWORK>
 *   NEW_OPERATOR=0x... VAULT_KEYS=<KEY_1>,<KEY_2> yarn admin:update-operator --network <NETWORK>
 *   NEW_OPERATOR=0x... IS_ETH_VAULT=true yarn admin:update-operator --network <NETWORK>
 *
 * Required ENV variables:
 *   NEW_OPERATOR - Address of the new operator
 *
 * Optional ENV variables:
 *   VAULT_KEYS   - Comma-separated vault keys from deployment JSON
 *                  (omit to process all vaults in the selected collection)
 *   IS_ETH_VAULT - "true" to target ethVaults instead of vaults
 *
 * Notes:
 * - Only the vault ADMIN can change the operator. The signer must be admin
 *   on every targeted vault (admin is per-vault).
 * - Per-vault checks (sub-account, blacklist, role collision) are simulated
 *   via staticCall before sending the real transaction.
 * - The deployment JSON's `operator` field is updated for each vault that
 *   confirms successfully. Failures are reported but do not abort the loop.
 */
async function main() {
  console.log("\n👤 Updating Vault Operator...\n");

  const isEthVault = process.env.IS_ETH_VAULT === "true";

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

  const protocolConfigAddress = deploymentInfo.contracts?.protocolConfig?.proxyAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: Protocol config not found in deployment file!");
    process.exit(1);
  }

  const vaults = isEthVault
    ? deploymentInfo.contracts?.ethVaults
    : deploymentInfo.contracts?.vaults;
  if (!vaults || Object.keys(vaults).length === 0) {
    console.error("❌ Error: No vaults found in deployment file!");
    process.exit(1);
  }

  const newOperator = process.env.NEW_OPERATOR;
  if (!newOperator) {
    console.error("❌ Error: Missing required environment variable NEW_OPERATOR!");
    console.log("\nRequired variables:");
    console.log("  NEW_OPERATOR - Address of the new operator");
    console.log("\nOptional variables:");
    console.log("  VAULT_KEYS   - Comma-separated vault keys (omit to update all)");
    console.log("  IS_ETH_VAULT - 'true' to target ethVaults");

    console.log("\nAvailable vaults:");
    Object.keys(vaults).forEach((key) => {
      const vault = vaults[key];
      console.log(`  - ${key}: ${vault.name ?? "Unknown"}`);
      console.log(`      Address: ${vault.proxyAddress ?? "Missing"}`);
      console.log(`      Current Operator: ${vault.operator ?? "Unknown"}`);
    });
    process.exit(1);
  }

  if (!ethers.isAddress(newOperator)) {
    console.error(`❌ Error: Invalid NEW_OPERATOR address: ${newOperator}`);
    process.exit(1);
  }

  const contractName = isEthVault ? "EmberETHVault" : "EmberVault";

  const vaultKeysEnv = process.env.VAULT_KEYS;
  let vaultKeysToProcess: string[];

  if (vaultKeysEnv) {
    vaultKeysToProcess = vaultKeysEnv.split(",").map((key) => key.trim());
    console.log("🎯 Processing specific vaults:", vaultKeysToProcess.join(", "));
  } else {
    vaultKeysToProcess = Object.keys(vaults);
    console.log("🎯 Processing ALL vaults:", vaultKeysToProcess.join(", "));
  }

  for (const vaultKey of vaultKeysToProcess) {
    if (!vaults[vaultKey]) {
      console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!`);
      console.log("Available vaults:");
      Object.keys(vaults).forEach((key) => {
        console.log(`  - ${key}`);
      });
      process.exit(1);
    }
  }

  console.log("Protocol Config:", protocolConfigAddress);
  console.log("Target Operator:", newOperator);
  console.log("Vault Type:", isEthVault ? "ethVaults" : "vaults");

  console.log("\n" + "=".repeat(70));
  console.log("📋 Vaults to Process:");
  console.log("=".repeat(70));
  for (const vaultKey of vaultKeysToProcess) {
    const vaultInfo = vaults[vaultKey];
    console.log(`\n${vaultKey}:`);
    console.log(`  Name: ${vaultInfo.name ?? "Unknown"}`);
    console.log(`  Address: ${vaultInfo.proxyAddress ?? "Missing"}`);
    console.log(`  Stored Operator: ${String(vaultInfo.operator ?? "Not set")}`);
  }
  console.log("\n" + "=".repeat(70));

  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);

  const results: Array<{
    vaultKey: string;
    success: boolean;
    skipped?: boolean;
    reason?: string;
    blockNumber?: number;
    txHash?: string;
    error?: string;
  }> = [];

  let deploymentJsonChanged = false;

  for (const vaultKey of vaultKeysToProcess) {
    const vaultInfo = vaults[vaultKey];

    console.log("\n" + "-".repeat(70));
    console.log(`🛠️ Processing ${vaultKey}`);
    console.log("-".repeat(70));

    try {
      if (!vaultInfo.proxyAddress) {
        throw new Error("Vault proxy address not found in deployment file");
      }

      const vault = await ethers.getContractAt(contractName, vaultInfo.proxyAddress);
      const vaultRoles = await vault.roles();
      const currentAdmin = vaultRoles.admin;
      const currentOperator = vaultRoles.operator;
      const currentRateManager = vaultRoles.rateManager;

      console.log("Vault Address:", vaultInfo.proxyAddress);
      console.log("Current Admin:", currentAdmin);
      console.log("Current Operator:", currentOperator);
      console.log("Current Rate Manager:", currentRateManager);

      // Already at the target operator — skip the on-chain call but still
      // sync the deployment JSON if it's stale.
      if (currentOperator.toLowerCase() === newOperator.toLowerCase()) {
        console.log("✅ Operator already set on-chain. Skipping contract update.");
        if (vaultInfo.operator !== newOperator) {
          vaultInfo.operator = newOperator;
          deploymentJsonChanged = true;
          console.log("📝 Deployment JSON operator field synchronized.");
        }
        results.push({
          vaultKey,
          success: true,
          skipped: true,
          reason: "Operator already set",
        });
        continue;
      }

      // Per-vault preflight checks (mirrors EmberProtocolConfig.updateVaultOperator)
      if (signer.address.toLowerCase() !== currentAdmin.toLowerCase()) {
        throw new Error(
          `Signer (${signer.address}) is not the vault admin (${currentAdmin}). Only the vault admin can change the operator.`
        );
      }
      if (newOperator.toLowerCase() === currentAdmin.toLowerCase()) {
        throw new Error("New operator cannot be the current admin");
      }
      if (newOperator.toLowerCase() === currentRateManager.toLowerCase()) {
        throw new Error("New operator cannot be the current rate manager");
      }
      if (await vault.subAccounts(newOperator)) {
        throw new Error("New operator is registered as a sub-account on this vault");
      }
      if (await protocolConfig.isAccountBlacklisted(newOperator)) {
        throw new Error("New operator is blacklisted at the protocol level");
      }

      // Static-call simulation for a clearer revert reason on failure
      try {
        await protocolConfig.updateVaultOperator.staticCall(vaultInfo.proxyAddress, newOperator);
      } catch (staticCallError: any) {
        const detail = staticCallError.reason ?? staticCallError.message ?? "unknown";
        throw new Error(`Static-call simulation reverted: ${detail}`);
      }

      console.log("Updating operator on-chain...");
      const tx = await protocolConfig.updateVaultOperator(vaultInfo.proxyAddress, newOperator);
      console.log("Transaction hash:", tx.hash);

      const receipt = await tx.wait();
      console.log("Transaction confirmed in block:", receipt?.blockNumber);

      const updatedRoles = await vault.roles();
      if (updatedRoles.operator.toLowerCase() !== newOperator.toLowerCase()) {
        throw new Error(
          `Operator verification failed. Expected ${newOperator} but got ${updatedRoles.operator}`
        );
      }

      console.log("✅ Operator updated successfully.");

      vaultInfo.operator = newOperator;
      vaultInfo.operatorUpdatedAt = new Date().toISOString();
      deploymentJsonChanged = true;

      results.push({
        vaultKey,
        success: true,
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
      });
    } catch (error: any) {
      console.error(`❌ Failed to process ${vaultKey}:`, error.message);
      results.push({
        vaultKey,
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
  console.log("📊 OPERATOR UPDATE SUMMARY");
  console.log("=".repeat(70));
  console.log(`\n✅ Updated: ${successful.length}`);
  console.log(`⏭️ Skipped: ${skipped.length}`);
  console.log(`❌ Failed: ${failed.length}`);

  for (const result of successful) {
    console.log(`  - ${result.vaultKey} -> block ${String(result.blockNumber ?? "n/a")}`);
  }

  for (const result of skipped) {
    console.log(`  - ${result.vaultKey} -> ${result.reason}`);
  }

  for (const result of failed) {
    console.log(`  - ${result.vaultKey} -> ${result.error}`);
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
