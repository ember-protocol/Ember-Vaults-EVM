import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Updates the admin of a vault
 * This changes who can manage vault configuration (operator, rate manager, fees, etc.)
 *
 * Required ENV variables:
 * - VAULT_KEY: Key of the vault in deployment file (e.g., "emberExusdcVault")
 * - NEW_ADMIN: Address of the new admin
 *
 * Note: Only the vault OWNER can change the admin
 */
async function main() {
  console.log("\n👤 Updating Vault Admin...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log();

  // Load deployment file
  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  // Get parameters from environment
  const vaultKey = process.env.VAULT_KEY;
  const newAdmin = process.env.NEW_ADMIN;

  if (!vaultKey || !newAdmin) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  VAULT_KEY   - Key of the vault in deployment file");
    console.log("  NEW_ADMIN   - Address of the new admin");

    console.log("\nAvailable vaults:");
    if (deploymentInfo.contracts.vaults) {
      Object.keys(deploymentInfo.contracts.vaults).forEach((key) => {
        const vault = deploymentInfo.contracts.vaults[key];
        console.log(`  - ${key}: ${vault.name}`);
        console.log(`      Address: ${vault.proxyAddress}`);
        console.log(`      Current Admin: ${vault.admin}`);
      });
    }

    process.exit(1);
  }

  // Validate new admin address
  if (!ethers.isAddress(newAdmin)) {
    console.error(`❌ Error: Invalid NEW_ADMIN address: ${newAdmin}`);
    process.exit(1);
  }

  // Get vault info from deployment
  const vaultInfo = deploymentInfo.contracts.vaults?.[vaultKey];
  if (!vaultInfo) {
    console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!`);
    console.log("\nAvailable vaults:");
    if (deploymentInfo.contracts.vaults) {
      Object.keys(deploymentInfo.contracts.vaults).forEach((key) => {
        console.log(`  - ${key}`);
      });
    }
    process.exit(1);
  }

  // Get protocol config address
  const protocolConfigAddress = deploymentInfo.contracts.protocolConfig?.proxyAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: Protocol config not found in deployment file!");
    process.exit(1);
  }

  // Get vault contract to check current state
  const vault = await ethers.getContractAt("EmberVault", vaultInfo.proxyAddress);
  const vaultRoles = await vault.roles();
  const currentAdmin = vaultRoles.admin;
  const vaultOwner = await vault.owner();

  // Verify the vault's protocol config matches what we're using
  const vaultProtocolConfig = await vault.protocolConfig();
  if (vaultProtocolConfig.toLowerCase() !== protocolConfigAddress.toLowerCase()) {
    console.error("❌ Error: Protocol config mismatch!");
    console.log("  Vault's protocolConfig:", vaultProtocolConfig);
    console.log("  Deployment file protocolConfig:", protocolConfigAddress);
    console.log(
      "\nThe vault is using a different protocol config than what's in the deployment file."
    );
    process.exit(1);
  }

  console.log("Configuration:");
  console.log("  Vault Key:", vaultKey);
  console.log("  Vault Name:", vaultInfo.name);
  console.log("  Vault Address:", vaultInfo.proxyAddress);
  console.log("  Protocol Config:", protocolConfigAddress);
  console.log("  Vault Owner:", vaultOwner);
  console.log("  Current Admin:", currentAdmin);
  console.log("  Current Operator:", vaultRoles.operator);
  console.log("  Current Rate Manager:", vaultRoles.rateManager);
  console.log("  New Admin:", newAdmin);
  console.log("  Signer matches Owner:", signer.address.toLowerCase() === vaultOwner.toLowerCase());
  console.log();

  // Check if new admin is the same as current
  if (currentAdmin.toLowerCase() === newAdmin.toLowerCase()) {
    console.log("✅ New admin is already the current admin. No action needed.");
    process.exit(0);
  }

  // Check if signer is the vault owner
  if (signer.address.toLowerCase() !== vaultOwner.toLowerCase()) {
    console.error("❌ Error: Signer is not the vault owner!");
    console.log("  Signer:", signer.address);
    console.log("  Vault Owner:", vaultOwner);
    console.log("\nOnly the vault owner can change the admin.");
    process.exit(1);
  }

  // Validate new admin is not already a role holder or sub-account
  if (newAdmin.toLowerCase() === vaultRoles.operator.toLowerCase()) {
    console.error("❌ Error: New admin cannot be the current operator!");
    process.exit(1);
  }
  if (newAdmin.toLowerCase() === vaultRoles.rateManager.toLowerCase()) {
    console.error("❌ Error: New admin cannot be the current rate manager!");
    process.exit(1);
  }

  const isSubAccount = await vault.subAccounts(newAdmin);
  if (isSubAccount) {
    console.error("❌ Error: New admin cannot be a sub-account!");
    process.exit(1);
  }

  // Check if new admin is blacklisted
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);
  const isBlacklisted = await protocolConfig.isAccountBlacklisted(newAdmin);
  if (isBlacklisted) {
    console.error("❌ Error: New admin is blacklisted!");
    process.exit(1);
  }

  // Update the admin
  console.log("Updating vault admin...");

  // First, simulate the transaction to get a better error message if it fails
  try {
    await protocolConfig.updateVaultAdmin.staticCall(vaultInfo.proxyAddress, newAdmin);
    console.log("Static call succeeded, proceeding with transaction...");
  } catch (staticCallError: any) {
    console.error("\n❌ Error: Transaction simulation failed!");
    console.log("This usually means the transaction would revert on-chain.");
    console.log("\nPossible reasons:");
    console.log("  - Signer is not the vault owner");
    console.log("  - New admin is already a role holder (operator/rateManager)");
    console.log("  - New admin is a sub-account");
    console.log("  - New admin is blacklisted");
    console.log("  - New admin is the same as current admin");
    if (staticCallError.reason) {
      console.log("\nRevert reason:", staticCallError.reason);
    }
    if (staticCallError.data) {
      console.log("Revert data:", staticCallError.data);
    }
    if (staticCallError.message) {
      console.log("Error message:", staticCallError.message);
    }
    process.exit(1);
  }

  const tx = await protocolConfig.updateVaultAdmin(vaultInfo.proxyAddress, newAdmin);
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify the admin was updated correctly
  const updatedRoles = await vault.roles();
  if (updatedRoles.admin.toLowerCase() === newAdmin.toLowerCase()) {
    console.log("\n✅ Vault admin updated successfully!");
  } else {
    console.error("\n❌ Error: Admin update verification failed!");
    console.log("Expected:", newAdmin);
    console.log("Got:", updatedRoles.admin);
    process.exit(1);
  }

  // Update vault info in deployment file
  vaultInfo.admin = newAdmin;
  vaultInfo.adminUpdatedAt = new Date().toISOString();

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("Deployment file updated:", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Vault Admin Update Complete!");
  console.log("=".repeat(70));
  console.log("\nVault:", vaultInfo.name);
  console.log("Vault Address:", vaultInfo.proxyAddress);
  console.log("Previous Admin:", currentAdmin);
  console.log("New Admin:", newAdmin);
  console.log("\n💡 The new admin can now:");
  console.log("   - Update vault operator and rate manager");
  console.log("   - Change fee percentage and rate update interval");
  console.log("   - Manage sub-accounts");
  console.log("   - Set bridge adapter");
  console.log("   - Pause/unpause vault operations");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
