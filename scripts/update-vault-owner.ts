import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Transfers ownership of a vault to a new owner.
 * Ownership controls every `onlyOwner` method, including `upgradeToAndCall`.
 * Typical use: hand a vault over to the owner timelock / Fordefi multisig.
 *
 * Required ENV variables:
 * - VAULT_KEY: Key of the vault in deployment file (e.g., "emberExusdcVault")
 * - NEW_OWNER: Address of the new owner
 *
 * Optional ENV variables:
 * - IS_ETH_VAULT: "true" to target contracts.ethVaults / EmberETHVault
 *
 * Note: Only the current vault OWNER can transfer ownership. After transferring
 * to a timelock, future ownership changes must go through that timelock.
 */
async function main() {
  console.log("\n🔑 Transferring Vault Ownership...\n");

  const isETHVault = process.env.IS_ETH_VAULT == "true";

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

  // ETH vaults live under contracts.ethVaults and use the EmberETHVault ABI;
  // regular vaults live under contracts.vaults and use EmberVault.
  const vaultGroup = isETHVault ? "ethVaults" : "vaults";
  const vaultContractName = isETHVault ? "EmberETHVault" : "EmberVault";
  const vaultsMap = deploymentInfo.contracts?.[vaultGroup] || {};

  // Get parameters from environment
  const vaultKey = process.env.VAULT_KEY;
  const newOwner = process.env.NEW_OWNER;

  if (!vaultKey || !newOwner) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  VAULT_KEY   - Key of the vault in deployment file");
    console.log("  NEW_OWNER   - Address of the new owner");

    console.log(`\nAvailable ${vaultGroup}:`);
    Object.keys(vaultsMap).forEach((key) => {
      const vault = vaultsMap[key];
      console.log(`  - ${key}: ${vault.name}`);
      console.log(`      Address: ${vault.proxyAddress}`);
      console.log(`      Current Owner: ${vault.ownerAddress}`);
    });

    process.exit(1);
  }

  // Validate new owner address
  if (!ethers.isAddress(newOwner)) {
    console.error(`❌ Error: Invalid NEW_OWNER address: ${newOwner}`);
    process.exit(1);
  }

  // Get vault info from deployment
  const vaultInfo = vaultsMap[vaultKey];
  if (!vaultInfo) {
    console.error(
      `❌ Error: Vault '${vaultKey}' not found under contracts.${vaultGroup} in deployment file!`
    );
    console.log(`\nAvailable ${vaultGroup}:`);
    Object.keys(vaultsMap).forEach((key) => {
      console.log(`  - ${key}`);
    });
    process.exit(1);
  }

  // Get vault contract to check current state
  const vault = await ethers.getContractAt(vaultContractName, vaultInfo.proxyAddress);
  const currentOwner = await vault.owner();

  console.log("Configuration:");
  console.log("  Vault Key:", vaultKey);
  console.log("  Vault Name:", vaultInfo.name);
  console.log("  Vault Type:", isETHVault ? "ETH (EmberETHVault)" : "ERC20 (EmberVault)");
  console.log("  Vault Address:", vaultInfo.proxyAddress);
  console.log("  Current Owner:", currentOwner);
  console.log("  New Owner:", newOwner);
  console.log(
    "  Signer matches Owner:",
    signer.address.toLowerCase() === currentOwner.toLowerCase()
  );
  console.log();

  // No-op if already owned by the new owner
  if (currentOwner.toLowerCase() === newOwner.toLowerCase()) {
    console.log("✅ New owner is already the current owner. No action needed.");
    process.exit(0);
  }

  // Check if signer is the current owner
  if (signer.address.toLowerCase() !== currentOwner.toLowerCase()) {
    console.error("❌ Error: Signer is not the vault owner!");
    console.log("  Signer:", signer.address);
    console.log("  Vault Owner:", currentOwner);
    console.log("\nOnly the vault owner can transfer ownership.");
    process.exit(1);
  }

  // Transfer ownership
  console.log("Transferring vault ownership...");

  // First, simulate the transaction to get a better error message if it fails
  try {
    await vault.transferOwnership.staticCall(newOwner);
    console.log("Static call succeeded, proceeding with transaction...");
  } catch (staticCallError: any) {
    console.error("\n❌ Error: Transaction simulation failed!");
    console.log("This usually means the transaction would revert on-chain.");
    console.log("\nPossible reasons:");
    console.log("  - Signer is not the vault owner");
    console.log("  - New owner is the zero address (OwnableInvalidOwner)");
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

  const tx = await vault.transferOwnership(newOwner);
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify the owner was updated correctly
  const updatedOwner = await vault.owner();
  if (updatedOwner.toLowerCase() === newOwner.toLowerCase()) {
    console.log("\n✅ Vault ownership transferred successfully!");
  } else {
    console.error("\n❌ Error: Ownership transfer verification failed!");
    console.log("Expected:", newOwner);
    console.log("Got:", updatedOwner);
    process.exit(1);
  }

  // Update vault info in deployment file
  vaultInfo.ownerAddress = newOwner;
  vaultInfo.ownerUpdatedAt = new Date().toISOString();

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("Deployment file updated:", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Vault Ownership Transfer Complete!");
  console.log("=".repeat(70));
  console.log("\nVault:", vaultInfo.name);
  console.log("Vault Address:", vaultInfo.proxyAddress);
  console.log("Previous Owner:", currentOwner);
  console.log("New Owner:", newOwner);
  console.log("\n💡 The new owner now controls all onlyOwner methods (incl. upgradeToAndCall).");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
