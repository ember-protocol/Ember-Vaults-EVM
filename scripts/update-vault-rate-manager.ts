import { ethers } from "hardhat";
import * as fs from "fs";

type DeploymentInfo = {
  contracts?: {
    protocolConfig?: {
      proxyAddress?: string;
    };
    vaults?: Record<string, VaultDeploymentRecord>;
    ethVaults?: Record<string, VaultDeploymentRecord>;
    atomicLiquidityVaults?: Record<string, VaultDeploymentRecord>;
  };
};

type VaultDeploymentRecord = {
  proxyAddress?: string;
  name?: string;
  rateManager?: string;
  rateManagerUpdatedAt?: string;
  [key: string]: unknown;
};

/**
 * Updates the rate manager on one or more vaults.
 * The rate manager is the only role that can call updateVaultRate.
 *
 * Usage:
 *   NEW_RATE_MANAGER=0x... yarn admin:update-rate-manager --network <NETWORK>
 *   NEW_RATE_MANAGER=0x... VAULT_KEYS=<KEY_1>,<KEY_2> yarn admin:update-rate-manager --network <NETWORK>
 *   NEW_RATE_MANAGER=0x... IS_ETH_VAULT=true yarn admin:update-rate-manager --network <NETWORK>
 *   NEW_RATE_MANAGER=0x... IS_ATOMIC=true yarn admin:update-rate-manager --network <NETWORK>
 *
 * Required ENV variables:
 *   NEW_RATE_MANAGER - Address of the new rate manager
 *
 * Optional ENV variables:
 *   VAULT_KEYS   - Comma-separated vault keys from deployment JSON
 *                  (omit to process all vaults in the selected collection)
 *   IS_ETH_VAULT - "true" to target ethVaults instead of vaults
 *   IS_ATOMIC    - "true" to target atomicLiquidityVaults instead of vaults
 *
 * All collections route through EmberProtocolConfig.updateVaultRateManager, which
 * works uniformly for tokenized, ETH, and atomic-liquidity vaults (all implement
 * the IEmberVault roles()/subAccounts()/setRateManager interface).
 *
 * Notes:
 * - Only the vault ADMIN can change the rate manager. The signer must be admin
 *   on every targeted vault (admin is per-vault).
 * - Per-vault checks (sub-account, blacklist, role collision) are simulated
 *   via staticCall before sending the real transaction.
 * - The deployment JSON's `rateManager` field is updated for each vault that
 *   confirms successfully. Failures are reported but do not abort the loop.
 */
async function main() {
  console.log("\n👤 Updating Vault Rate Manager...\n");

  const isEthVault = process.env.IS_ETH_VAULT === "true";
  const isAtomic = process.env.IS_ATOMIC === "true";
  if (isEthVault && isAtomic) {
    console.error("❌ Error: set only one of IS_ETH_VAULT / IS_ATOMIC");
    process.exit(1);
  }

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

  const vaults = isAtomic
    ? deploymentInfo.contracts?.atomicLiquidityVaults
    : isEthVault
      ? deploymentInfo.contracts?.ethVaults
      : deploymentInfo.contracts?.vaults;
  if (!vaults || Object.keys(vaults).length === 0) {
    console.error("❌ Error: No vaults found in deployment file!");
    process.exit(1);
  }

  const newRateManager = process.env.NEW_RATE_MANAGER;
  if (!newRateManager) {
    console.error("❌ Error: Missing required environment variable NEW_RATE_MANAGER!");
    console.log("\nRequired variables:");
    console.log("  NEW_RATE_MANAGER - Address of the new rate manager");
    console.log("\nOptional variables:");
    console.log("  VAULT_KEYS   - Comma-separated vault keys (omit to update all)");
    console.log("  IS_ETH_VAULT - 'true' to target ethVaults");

    console.log("\nAvailable vaults:");
    Object.keys(vaults).forEach((key) => {
      const vault = vaults[key];
      console.log(`  - ${key}: ${vault.name ?? "Unknown"}`);
      console.log(`      Address: ${vault.proxyAddress ?? "Missing"}`);
      console.log(`      Current Rate Manager: ${vault.rateManager ?? "Unknown"}`);
    });
    process.exit(1);
  }

  if (!ethers.isAddress(newRateManager) || newRateManager === ethers.ZeroAddress) {
    console.error(`❌ Error: Invalid NEW_RATE_MANAGER address: ${newRateManager}`);
    process.exit(1);
  }

  const contractName = isAtomic ? "AtomicLiquidity" : isEthVault ? "EmberETHVault" : "EmberVault";

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
  console.log("Target Rate Manager:", newRateManager);
  console.log(
    "Vault Type:",
    isAtomic ? "atomicLiquidityVaults" : isEthVault ? "ethVaults" : "vaults"
  );

  console.log("\n" + "=".repeat(70));
  console.log("📋 Vaults to Process:");
  console.log("=".repeat(70));
  for (const vaultKey of vaultKeysToProcess) {
    const vaultInfo = vaults[vaultKey];
    console.log(`\n${vaultKey}:`);
    console.log(`  Name: ${vaultInfo.name ?? "Unknown"}`);
    console.log(`  Address: ${vaultInfo.proxyAddress ?? "Missing"}`);
    console.log(`  Stored Rate Manager: ${String(vaultInfo.rateManager ?? "Not set")}`);
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

      // Already at the target rate manager — skip the on-chain call but still
      // sync the deployment JSON if it's stale.
      if (currentRateManager.toLowerCase() === newRateManager.toLowerCase()) {
        console.log("✅ Rate manager already set on-chain. Skipping contract update.");
        if (vaultInfo.rateManager !== newRateManager) {
          vaultInfo.rateManager = newRateManager;
          deploymentJsonChanged = true;
          console.log("📝 Deployment JSON rateManager field synchronized.");
        }
        results.push({
          vaultKey,
          success: true,
          skipped: true,
          reason: "Rate manager already set",
        });
        continue;
      }

      // Per-vault preflight checks (mirrors EmberProtocolConfig.updateVaultRateManager)
      if (signer.address.toLowerCase() !== currentAdmin.toLowerCase()) {
        throw new Error(
          `Signer (${signer.address}) is not the vault admin (${currentAdmin}). Only the vault admin can change the rate manager.`
        );
      }
      if (newRateManager.toLowerCase() === currentAdmin.toLowerCase()) {
        throw new Error("New rate manager cannot be the current admin");
      }
      if (newRateManager.toLowerCase() === currentOperator.toLowerCase()) {
        throw new Error("New rate manager cannot be the current operator");
      }
      if (await vault.subAccounts(newRateManager)) {
        throw new Error("New rate manager is registered as a sub-account on this vault");
      }
      if (await protocolConfig.isAccountBlacklisted(newRateManager)) {
        throw new Error("New rate manager is blacklisted at the protocol level");
      }

      // Static-call simulation for a clearer revert reason on failure
      try {
        await protocolConfig.updateVaultRateManager.staticCall(
          vaultInfo.proxyAddress,
          newRateManager
        );
      } catch (staticCallError: any) {
        const detail = staticCallError.reason ?? staticCallError.message ?? "unknown";
        throw new Error(`Static-call simulation reverted: ${detail}`);
      }

      console.log("Updating rate manager on-chain...");
      const tx = await protocolConfig.updateVaultRateManager(
        vaultInfo.proxyAddress,
        newRateManager
      );
      console.log("Transaction hash:", tx.hash);

      const receipt = await tx.wait();
      console.log("Transaction confirmed in block:", receipt?.blockNumber);

      const updatedRoles = await vault.roles();
      if (updatedRoles.rateManager.toLowerCase() !== newRateManager.toLowerCase()) {
        throw new Error(
          `Rate manager verification failed. Expected ${newRateManager} but got ${updatedRoles.rateManager}`
        );
      }

      console.log("✅ Rate manager updated successfully.");

      vaultInfo.rateManager = newRateManager;
      vaultInfo.rateManagerUpdatedAt = new Date().toISOString();
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
  console.log("📊 RATE MANAGER UPDATE SUMMARY");
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
