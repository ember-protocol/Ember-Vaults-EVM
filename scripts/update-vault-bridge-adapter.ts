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
  bridgeAdapter?: string;
  bridgeAdapterUpdatedAt?: string;
  [key: string]: unknown;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Sets the bridge adapter on one or more vaults. Calls
 * EmberProtocolConfig.setVaultBridgeAdapter(vault, newAdapter), which forwards
 * to the vault's setBridgeAdapter — onlyAdmin on the vault side.
 *
 * Pass NEW_ADAPTER=0x0 to disable bridging on a vault. This is the path used
 * to recover the bridgeAdapter slot polluted by the OFT-PR storage shift
 * (where the validator address ended up sitting in bridgeAdapter for vaults
 * upgraded across both PRs).
 *
 * Usage:
 *   NEW_ADAPTER=0x... yarn admin:update-bridge-adapter --network <NETWORK>
 *   NEW_ADAPTER=0x0 VAULT_KEYS=<KEY_1>,<KEY_2> yarn admin:update-bridge-adapter --network <NETWORK>
 *   NEW_ADAPTER=0x... IS_ETH_VAULT=true yarn admin:update-bridge-adapter --network <NETWORK>
 *
 * Required ENV variables:
 *   NEW_ADAPTER  - New bridge adapter address (use 0x0 to disable bridging)
 *
 * Optional ENV variables:
 *   VAULT_KEYS   - Comma-separated vault keys from deployment JSON
 *                  (omit to process all vaults in the selected collection)
 *   IS_ETH_VAULT - "true" to target ethVaults instead of vaults
 *
 * Notes:
 * - Only the vault ADMIN can change the bridge adapter. The signer must be
 *   admin on every targeted vault (admin is per-vault).
 * - Vault contract reverts SameValue if newAdapter == current. Already-set
 *   vaults are skipped before the on-chain call.
 * - The deployment JSON's `bridgeAdapter` field is updated for each vault
 *   that confirms successfully. Failures are reported but do not abort the
 *   loop.
 */
async function main() {
  console.log("\n🌉 Updating Vault Bridge Adapter...\n");

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

  const newAdapterRaw = process.env.NEW_ADAPTER;
  if (!newAdapterRaw) {
    console.error("❌ Error: Missing required environment variable NEW_ADAPTER!");
    console.log("\nRequired variables:");
    console.log("  NEW_ADAPTER  - New bridge adapter address (use 0x0 to disable bridging)");
    console.log("\nOptional variables:");
    console.log("  VAULT_KEYS   - Comma-separated vault keys (omit to update all)");
    console.log("  IS_ETH_VAULT - 'true' to target ethVaults");

    console.log("\nAvailable vaults:");
    Object.keys(vaults).forEach((key) => {
      const vault = vaults[key];
      console.log(`  - ${key}: ${vault.name ?? "Unknown"}`);
      console.log(`      Address: ${vault.proxyAddress ?? "Missing"}`);
      console.log(`      Current Adapter: ${vault.bridgeAdapter ?? "Unknown"}`);
    });
    process.exit(1);
  }

  const newAdapter =
    newAdapterRaw === "0" || newAdapterRaw.toLowerCase() === "0x0" ? ZERO_ADDRESS : newAdapterRaw;
  if (!ethers.isAddress(newAdapter)) {
    console.error(`❌ Error: Invalid NEW_ADAPTER address: ${newAdapterRaw}`);
    process.exit(1);
  }

  const contractName = isEthVault ? "EmberETHVault" : "EmberVault";

  const vaultKeysEnv = process.env.VAULT_KEYS;
  let vaultKeysToProcess: string[];
  if (vaultKeysEnv) {
    vaultKeysToProcess = vaultKeysEnv.split(",").map((k) => k.trim());
    console.log("🎯 Processing specific vaults:", vaultKeysToProcess.join(", "));
  } else {
    vaultKeysToProcess = Object.keys(vaults);
    console.log("🎯 Processing ALL vaults:", vaultKeysToProcess.join(", "));
  }

  for (const vaultKey of vaultKeysToProcess) {
    if (!vaults[vaultKey]) {
      console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!`);
      console.log("Available vaults:");
      Object.keys(vaults).forEach((key) => console.log(`  - ${key}`));
      process.exit(1);
    }
  }

  console.log("Protocol Config:", protocolConfigAddress);
  console.log("Target Adapter:", newAdapter, newAdapter === ZERO_ADDRESS ? "(disable)" : "");
  console.log("Vault Type:", isEthVault ? "ethVaults" : "vaults");

  console.log("\n" + "=".repeat(70));
  console.log("📋 Vaults to Process:");
  console.log("=".repeat(70));
  for (const vaultKey of vaultKeysToProcess) {
    const vaultInfo = vaults[vaultKey];
    console.log(`\n${vaultKey}:`);
    console.log(`  Name: ${vaultInfo.name ?? "Unknown"}`);
    console.log(`  Address: ${vaultInfo.proxyAddress ?? "Missing"}`);
    console.log(`  Stored Adapter: ${String(vaultInfo.bridgeAdapter ?? "Not set")}`);
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
      const currentAdapter: string = await vault.bridgeAdapter();

      console.log("Vault Address:", vaultInfo.proxyAddress);
      console.log("Current Admin:", currentAdmin);
      console.log("Current Adapter:", currentAdapter);

      // Already at the target — skip on-chain call (vault.setBridgeAdapter
      // reverts with SameValue). Still sync deployment JSON if it's stale.
      if (currentAdapter.toLowerCase() === newAdapter.toLowerCase()) {
        console.log("✅ Adapter already set on-chain. Skipping contract update.");
        if (vaultInfo.bridgeAdapter !== newAdapter) {
          vaultInfo.bridgeAdapter = newAdapter;
          deploymentJsonChanged = true;
          console.log("📝 Deployment JSON bridgeAdapter field synchronized.");
        }
        results.push({
          vaultKey,
          success: true,
          skipped: true,
          reason: "Adapter already set",
        });
        continue;
      }

      // Pre-flight: only the vault admin can change the adapter.
      if (signer.address.toLowerCase() !== currentAdmin.toLowerCase()) {
        throw new Error(
          `Signer (${signer.address}) is not the vault admin (${currentAdmin}). Only the admin can change the bridge adapter.`
        );
      }

      // Static-call simulation for a clearer revert reason on failure.
      try {
        await protocolConfig.setVaultBridgeAdapter.staticCall(vaultInfo.proxyAddress, newAdapter);
      } catch (staticCallError: any) {
        const detail = staticCallError.reason ?? staticCallError.message ?? "unknown";
        throw new Error(`Static-call simulation reverted: ${detail}`);
      }

      console.log("Updating bridge adapter on-chain...");
      const tx = await protocolConfig.setVaultBridgeAdapter(vaultInfo.proxyAddress, newAdapter);
      console.log("Transaction hash:", tx.hash);

      const receipt = await tx.wait();
      console.log("Transaction confirmed in block:", receipt?.blockNumber);

      const updatedAdapter: string = await vault.bridgeAdapter();
      if (updatedAdapter.toLowerCase() !== newAdapter.toLowerCase()) {
        throw new Error(
          `Adapter verification failed. Expected ${newAdapter} but got ${updatedAdapter}`
        );
      }

      console.log("✅ Bridge adapter updated successfully.");

      vaultInfo.bridgeAdapter = newAdapter;
      vaultInfo.bridgeAdapterUpdatedAt = new Date().toISOString();
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

  const successful = results.filter((r) => r.success && !r.skipped);
  const skipped = results.filter((r) => r.success && r.skipped);
  const failed = results.filter((r) => !r.success);

  console.log("\n" + "=".repeat(70));
  console.log("📊 BRIDGE ADAPTER UPDATE SUMMARY");
  console.log("=".repeat(70));
  console.log(`\n✅ Updated: ${successful.length}`);
  console.log(`⏭️ Skipped: ${skipped.length}`);
  console.log(`❌ Failed:  ${failed.length}`);

  for (const r of successful) {
    console.log(`  - ${r.vaultKey} -> block ${String(r.blockNumber ?? "n/a")}`);
  }
  for (const r of skipped) {
    console.log(`  - ${r.vaultKey} -> ${r.reason}`);
  }
  for (const r of failed) {
    console.log(`  - ${r.vaultKey} -> ${r.error}`);
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
