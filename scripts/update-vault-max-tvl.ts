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
  console.log("\n👤 Updating Vault Max TVL...\n");

  const isEthVault = process.env.IS_ETH_VAULT === "true";

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
  const newMaxTVL = process.env.NEW_MAX_TVL;

  if (!vaultKey || !newMaxTVL) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  VAULT_KEY   - Key of the vault in deployment file");
    console.log("  NEW_MAX_TVL - New maximum TVL for the vault");

    console.log("\nAvailable vaults:");

    const vaults = isEthVault
      ? deploymentInfo.contracts.ethVaults
      : deploymentInfo.contracts.vaults;
    if (vaults) {
      Object.keys(vaults).forEach((key) => {
        const vault = vaults[key];
        console.log(`  - ${key}: ${vault.name}`);
        console.log(`      Address: ${vault.proxyAddress}`);
        console.log(`      Current Admin: ${vault.admin}`);
      });
    }

    process.exit(1);
  }

  // Validate new max TVL
  if (isNaN(Number(newMaxTVL))) {
    console.error(`❌ Error: Invalid NEW_MAX_TVL value: ${newMaxTVL}`);
    process.exit(1);
  }

  const vaults = isEthVault ? deploymentInfo.contracts.ethVaults : deploymentInfo.contracts.vaults;
  const vaultInfo = vaults?.[vaultKey];
  if (!vaultInfo) {
    console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!`);
    console.log("\nAvailable vaults:");
    if (vaults) {
      Object.keys(vaults).forEach((key) => {
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

  console.log("Configuration:");
  console.log("  Vault Key:", vaultKey);
  console.log("  Vault Name:", vaultInfo.name);
  console.log("  Vault Address:", vaultInfo.proxyAddress);
  console.log("  Protocol Config:", protocolConfigAddress);
  console.log("  Vault Owner:", vaultOwner);
  console.log("  Current Admin:", currentAdmin);
  console.log("  Current Operator:", vaultRoles.operator);
  console.log("  Current Rate Manager:", vaultRoles.rateManager);
  console.log("  New Max TVL:", newMaxTVL);
  console.log("  Signer matches Owner:", signer.address.toLowerCase() === vaultOwner.toLowerCase());
  console.log();

  // Check if new max TVL is the same as current
  const currentMaxTVL = await vault.maxTVL();
  if (currentMaxTVL.toString() === newMaxTVL) {
    console.log("✅ New max TVL is already the current max TVL. No action needed.");
    process.exit(0);
  }

  // Update the max TVL
  console.log("Updating vault max TVL...");
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);
  const tx = await protocolConfig.updateVaultMaxTVL(vaultInfo.proxyAddress, newMaxTVL);
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify the max TVL was updated correctly
  const updatedMaxTVL = await vault.maxTVL();
  if (updatedMaxTVL.toString() === newMaxTVL) {
    console.log("\n✅ Vault max TVL updated successfully!");
  } else {
    console.error("\n❌ Error: Max TVL update verification failed!");
    console.log("Expected:", newMaxTVL);
    console.log("Got:", updatedMaxTVL.toString());
    process.exit(1);
  }
  console.log("Updated Max TVL:", updatedMaxTVL.toString());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
