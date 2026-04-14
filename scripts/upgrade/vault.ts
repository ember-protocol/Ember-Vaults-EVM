import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import { EmberETHVault__factory, EmberVault__factory } from "../../typechain-types";

/**
 * Upgrades EmberVault contracts
 *
 * This script:
 * 1. Deploys the new EmberVault implementation
 * 2. Upgrades specified vault proxies to the new implementation
 * 3. Updates the deployment JSON file
 *
 * Usage:
 * - Set VAULT_KEYS environment variable with comma-separated vault keys to upgrade
 *   Example: VAULT_KEYS=emberErcusdcVault,emberErcethVault yarn upgrade:vaults
 * - Or omit VAULT_KEYS to upgrade ALL vaults in the deployment file
 *
 * The script will:
 * - Read existing vaults from the deployment file
 * - Deploy new implementation
 * - Upgrade each vault proxy
 * - Update deployment records
 */
async function main() {
  console.log("\n🔄 Upgrading EmberVault...\n");

  const isEthVault = process.env.IS_ETH_VAULT === "true";
  const vaultType = isEthVault ? "EmberETHVault" : "EmberVault";

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Upgrading with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  // Load deployment file
  const deploymentFileName = `./deployments/${network.name}-deployment.json`;

  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found!");
    console.log("File:", deploymentFileName);
    process.exit(1);
  }

  console.log("📂 Loading deployment file:", deploymentFileName);
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  const vaults = isEthVault ? deploymentInfo.contracts.ethVaults : deploymentInfo.contracts.vaults;

  // Check if there are any vaults
  if (!vaults || Object.keys(vaults).length === 0) {
    console.error("❌ Error: No vaults found in deployment file!");
    process.exit(1);
  }

  // Determine which vaults to upgrade
  const vaultKeysEnv = process.env.VAULT_KEYS;
  let vaultKeysToUpgrade: string[];

  if (vaultKeysEnv) {
    vaultKeysToUpgrade = vaultKeysEnv.split(",").map((key) => key.trim());
    console.log("🎯 Upgrading specific vaults:", vaultKeysToUpgrade.join(", "));
  } else {
    vaultKeysToUpgrade = Object.keys(vaults);
    console.log("🎯 Upgrading ALL vaults:", vaultKeysToUpgrade.join(", "));
  }

  // Validate vault keys exist
  for (const vaultKey of vaultKeysToUpgrade) {
    if (!vaults[vaultKey]) {
      console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!`);
      console.log("Available vaults:", Object.keys(vaults).join(", "));
      process.exit(1);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("📋 Vaults to Upgrade:");
  console.log("=".repeat(70));

  for (const vaultKey of vaultKeysToUpgrade) {
    const vault = vaults[vaultKey];
    console.log(`\n${vaultKey}:`);
    console.log(`  Proxy: ${vault.proxyAddress}`);
    console.log(`  Current Implementation: ${vault.implementationAddress}`);
    console.log(`  Name: ${vault.name}`);
    console.log(`  Version: ${vault.version}`);
  }

  console.log("\n" + "=".repeat(70));

  // Confirm upgrade (safety check)
  console.log("\n⚠️  WARNING: This will upgrade", vaultKeysToUpgrade.length, "vault(s)!");
  console.log("⚠️  Make sure you have tested this on a testnet first!");
  console.log("\nContinuing in 5 seconds... (Press Ctrl+C to cancel)");

  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("\n🚀 Starting upgrade process...\n");

  // Deploy new implementation (manually, not via upgrades plugin)
  console.log("📦 Deploying new EmberVault implementation...");
  const EmberVaultFactory = (await ethers.getContractFactory(vaultType)) as
    | EmberETHVault__factory
    | EmberVault__factory;

  console.log("   Deploying new implementation contract...");
  const newImplementation = await EmberVaultFactory.deploy();
  await newImplementation.waitForDeployment();
  const newImplementationAddress = await newImplementation.getAddress();

  // const newImplementationAddress = "0xDb60e16BaEe20fc5464F4F8D8688Ab9Ba2793Ca7";
  // const newImplementation = await ethers.getContractAt(vaultType, newImplementationAddress);

  console.log("   ✅ New Implementation deployed at:", newImplementationAddress);

  // Verify the new implementation
  const newImplVersion = await newImplementation.version();
  console.log("   New Implementation Version:", newImplVersion);

  const results = [];

  for (const vaultKey of vaultKeysToUpgrade) {
    const vaultInfo = vaults[vaultKey];
    const proxyAddress = vaultInfo.proxyAddress;

    console.log("\n" + "-".repeat(70));
    console.log(`🔄 Upgrading vault: ${vaultKey}`);
    console.log(`   Proxy Address: ${proxyAddress}`);
    console.log("-".repeat(70));

    try {
      // Get current implementation to verify it exists
      const currentImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      console.log("   Current Implementation:", currentImpl);

      // Get vault contract instance
      const vaultContract = await ethers.getContractAt(vaultType, proxyAddress);

      // Get current version before upgrade
      const currentVersion = await vaultContract.version();
      console.log("   Current Version:", currentVersion);

      // Check if already upgraded
      if (currentImpl.toLowerCase() === newImplementationAddress.toLowerCase()) {
        console.log("\n   ⚠️  WARNING: Vault is already using the new implementation!");
        console.log("   Skipping upgrade for", vaultKey);

        results.push({
          vaultKey,
          success: true,
          proxyAddress,
          newImplementationAddress,
          skipped: true,
          reason: "Already upgraded",
        });

        continue;
      }

      // Upgrade the proxy to the new implementation manually
      console.log("\n   📝 Upgrading proxy to new implementation...");
      console.log("      From:", currentImpl);
      console.log("      To:  ", newImplementationAddress);

      const upgradeTx = await vaultContract.upgradeToAndCall(newImplementationAddress, "0x");
      console.log("   Transaction hash:", upgradeTx.hash);
      console.log("   Waiting for confirmation...");

      const upgradeReceipt = await upgradeTx.wait();
      console.log("   ✅ Upgrade confirmed in block:", upgradeReceipt?.blockNumber);
      console.log("   Gas used:", upgradeReceipt?.gasUsed.toString());

      // Verify the upgrade
      const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      const newVersion = await vaultContract.version();
      const vaultName = await vaultContract.name();

      console.log("\n   📊 Post-Upgrade Verification:");
      console.log("      Implementation:", implAfter);
      console.log("      Version:", newVersion);
      console.log("      Name:", vaultName);

      // Verify it actually changed
      if (implAfter.toLowerCase() !== newImplementationAddress.toLowerCase()) {
        throw new Error(
          `Upgrade verification failed! Expected ${newImplementationAddress} but got ${implAfter}`
        );
      }

      // Update deployment info
      vaultInfo.implementationAddress = newImplementationAddress;
      vaultInfo.version = newVersion;
      vaultInfo.upgradedAt = new Date().toISOString();
      vaultInfo.upgradedInBlock = upgradeReceipt?.blockNumber || 0;

      results.push({
        vaultKey,
        success: true,
        proxyAddress,
        newImplementationAddress,
        txHash: upgradeReceipt?.hash,
        blockNumber: upgradeReceipt?.blockNumber,
      });

      console.log(`   ✅ Successfully upgraded ${vaultKey}!`);
    } catch (error: any) {
      console.error(`   ❌ Failed to upgrade ${vaultKey}:`, error.message);
      results.push({
        vaultKey,
        success: false,
        proxyAddress,
        error: error.message,
      });
    }
  }

  // Save updated deployment info
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment file updated:", deploymentFileName);

  // Print summary
  console.log("\n" + "=".repeat(70));
  console.log("📊 UPGRADE SUMMARY");
  console.log("=".repeat(70));

  const successful = results.filter((r) => r.success && !(r as any).skipped);
  const skipped = results.filter((r) => r.success && (r as any).skipped);
  const failed = results.filter((r) => !r.success);

  console.log(`\n✅ Successfully upgraded: ${successful.length}/${results.length} vaults`);
  if (skipped.length > 0) {
    console.log(`⏭️  Skipped: ${skipped.length} vault(s) (already upgraded)`);
  }

  if (successful.length > 0) {
    console.log("\nSuccessful Upgrades:");
    for (const result of successful) {
      console.log(`  ✓ ${result.vaultKey}`);
      console.log(`    Proxy: ${result.proxyAddress}`);
      console.log(`    New Implementation: ${result.newImplementationAddress}`);
      console.log(`    Tx Hash: ${result.txHash}`);
      console.log(`    Block: ${result.blockNumber}`);
    }
  }

  if (skipped.length > 0) {
    console.log("\nSkipped Vaults:");
    for (const result of skipped) {
      console.log(`  ⏭️  ${result.vaultKey}`);
      console.log(`    Proxy: ${result.proxyAddress}`);
      console.log(`    Implementation: ${result.newImplementationAddress}`);
      console.log(`    Reason: ${(result as any).reason}`);
    }
  }

  if (failed.length > 0) {
    console.log("\n❌ Failed Upgrades:");
    for (const result of failed) {
      console.log(`  ✗ ${result.vaultKey}`);
      console.log(`    Proxy: ${result.proxyAddress}`);
      console.log(`    Error: ${result.error}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Upgrade Process Complete!");
  console.log("=".repeat(70));

  console.log("\n" + "=".repeat(70) + "\n");

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
