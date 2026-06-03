import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Sets the bridge adapter for a vault's cross-chain operations
 * This authorizes the OFT adapter to mint/burn receipt tokens for bridging
 *
 * Required ENV variables:
 * - VAULT_KEY: Key of the vault in deployment file (e.g., "emberExusdcVault")
 *
 * Optional ENV variables (one of these should be provided):
 * - ADAPTER_KEY: Key of the OFT adapter in deployment file (e.g., "emberExusdcVaultOFTAdapter")
 * - ADAPTER_ADDRESS: Direct address of the adapter (use this or ADAPTER_KEY)
 *
 * To disable bridging, set neither ADAPTER_KEY nor ADAPTER_ADDRESS (will set to zero address)
 */
async function main() {
  const isEthVault = process.env.IS_ETH_VAULT === "true";
  console.log("\n🔗 Setting Vault Bridge Adapter...\n");

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
  const adapterKey = process.env.ADAPTER_KEY;
  const adapterAddress = process.env.ADAPTER_ADDRESS;

  const vaults = isEthVault ? deploymentInfo.contracts.ethVaults : deploymentInfo.contracts.vaults;

  if (!vaultKey) {
    console.error("❌ Error: VAULT_KEY environment variable is required!");
    console.log("\nRequired variables:");
    console.log("  VAULT_KEY         - Key of the vault in deployment file");
    console.log("\nOptional variables (provide one to set adapter, or neither to disable):");
    console.log("  ADAPTER_KEY       - Key of the OFT adapter in deployment file");
    console.log("  ADAPTER_ADDRESS   - Direct address of the adapter");

    console.log("\nAvailable vaults:");
    if (vaults) {
      Object.keys(vaults).forEach((key) => {
        const vault = vaults[key];
        console.log(`  - ${key}: ${vault.name} (${vault.proxyAddress})`);
      });
    }

    console.log("\nAvailable OFT adapters:");
    if (deploymentInfo.contracts.oftAdapters) {
      Object.keys(deploymentInfo.contracts.oftAdapters).forEach((key) => {
        const adapter = deploymentInfo.contracts.oftAdapters[key];
        console.log(`  - ${key}: ${adapter.address}`);
      });
    }

    process.exit(1);
  }

  // Get vault info from deployment
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

  // Determine the adapter address to set
  let newAdapterAddress: string;
  let adapterSource: string;

  if (adapterKey) {
    // Get adapter address from deployment file
    const adapterInfo = deploymentInfo.contracts.oftAdapters?.[adapterKey];
    if (!adapterInfo) {
      console.error(`❌ Error: OFT adapter '${adapterKey}' not found in deployment file!`);
      console.log("\nAvailable OFT adapters:");
      if (deploymentInfo.contracts.oftAdapters) {
        Object.keys(deploymentInfo.contracts.oftAdapters).forEach((key) => {
          console.log(`  - ${key}`);
        });
      }
      process.exit(1);
    }
    newAdapterAddress = adapterInfo.address;
    adapterSource = `from deployment (${adapterKey})`;
  } else if (adapterAddress) {
    // Use provided address directly
    if (!ethers.isAddress(adapterAddress)) {
      console.error(`❌ Error: Invalid ADAPTER_ADDRESS: ${adapterAddress}`);
      process.exit(1);
    }
    newAdapterAddress = adapterAddress;
    adapterSource = "from ADAPTER_ADDRESS env var";
  } else {
    // No adapter specified - disable bridging
    newAdapterAddress = ethers.ZeroAddress;
    adapterSource = "zero address (disabling bridging)";
  }

  // Get protocol config address
  const protocolConfigAddress = deploymentInfo.contracts.protocolConfig?.proxyAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: Protocol config not found in deployment file!");
    process.exit(1);
  }

  console.log("Configuration:");
  console.log("  Vault Key:", vaultKey);
  console.log("  Vault Name:", vaultInfo.name);
  console.log("  Vault Address:", vaultInfo.proxyAddress);
  console.log("  Protocol Config:", protocolConfigAddress);
  console.log("  New Adapter Address:", newAdapterAddress);
  console.log("  Adapter Source:", adapterSource);
  console.log();

  // Get current bridge adapter from vault
  const vault = await ethers.getContractAt("EmberVault", vaultInfo.proxyAddress);

  // Check vault version to ensure it supports setBridgeAdapter
  let vaultVersion: string;
  try {
    vaultVersion = await vault.version();
    console.log("Vault Version:", vaultVersion);
  } catch (e) {
    console.error("❌ Error: Could not get vault version. The vault may need to be upgraded.");
    process.exit(1);
  }

  // Check if bridgeAdapter function exists
  let currentAdapter: string;
  try {
    currentAdapter = await vault.bridgeAdapter();
  } catch (e: any) {
    console.error("❌ Error: Could not read bridgeAdapter from vault.");
    console.log("This vault version may not support bridge functionality.");
    console.log("Please upgrade the vault to a version that supports bridging (v1.2.0+).");
    if (e.message) {
      console.log("Error:", e.message);
    }
    process.exit(1);
  }

  const vaultRoles = await vault.roles();
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

  console.log("Current Bridge Adapter:", currentAdapter);
  console.log("Vault Owner:", vaultOwner);
  console.log("Vault Admin:", vaultRoles.admin);
  console.log(
    "Signer matches Admin:",
    signer.address.toLowerCase() === vaultRoles.admin.toLowerCase()
  );

  if (currentAdapter.toLowerCase() === newAdapterAddress.toLowerCase()) {
    console.log("\n✅ Bridge adapter is already set to this address. No action needed.");
    process.exit(0);
  }

  // Get protocol config contract
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);

  // Check if signer is the vault admin
  if (signer.address.toLowerCase() !== vaultRoles.admin.toLowerCase()) {
    console.error("\n❌ Error: Signer is not the vault admin!");
    console.log("  Signer:", signer.address);
    console.log("  Vault Admin:", vaultRoles.admin);
    console.log("\nOnly the vault admin can set the bridge adapter.");
    process.exit(1);
  }

  // Set the bridge adapter
  console.log("\nSetting bridge adapter...");

  // Now simulate the transaction through protocolConfig
  console.log("Simulating transaction through protocolConfig...");
  try {
    await protocolConfig.setVaultBridgeAdapter.staticCall(
      vaultInfo.proxyAddress,
      newAdapterAddress
    );
    console.log("Static call succeeded, proceeding with transaction...");
  } catch (staticCallError: any) {
    console.error("\n❌ Error: Transaction simulation failed!");
    console.log("This usually means the transaction would revert on-chain.");
    console.log("\nPossible reasons:");
    console.log("  - Signer is not the vault admin");
    console.log("  - New adapter is the same as current adapter (SameValue)");
    console.log("  - Protocol config mismatch");
    console.log("  - Vault version doesn't support setBridgeAdapter (needs upgrade to v1.2.0+)");
    if (staticCallError.reason) {
      console.log("\nRevert reason:", staticCallError.reason);
    }
    if (staticCallError.data) {
      console.log("Revert data:", staticCallError.data);
    }
    if (staticCallError.message) {
      console.log("Error message:", staticCallError.message);
    }

    // Additional hint based on vault version
    if (vaultVersion && vaultVersion < "v1.2.0") {
      console.log(
        "\n⚠️  Your vault version is",
        vaultVersion,
        "- this may not support bridge functionality."
      );
      console.log("Please upgrade the vault to v1.2.0+ to support bridge functionality.");
      console.log("\nRun: VAULT_KEY=" + vaultKey + " yarn upgrade:vaults --network " + networkName);
    }
    process.exit(1);
  }

  const tx = await protocolConfig.setVaultBridgeAdapter(vaultInfo.proxyAddress, newAdapterAddress);
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify the adapter was set correctly
  const updatedAdapter = await vault.bridgeAdapter();
  if (updatedAdapter.toLowerCase() === newAdapterAddress.toLowerCase()) {
    console.log("\n✅ Bridge adapter configured successfully!");
  } else {
    console.error("\n❌ Error: Bridge adapter verification failed!");
    console.log("Expected:", newAdapterAddress);
    console.log("Got:", updatedAdapter);
    process.exit(1);
  }

  // Update vault info in deployment file
  vaultInfo.bridgeAdapter = newAdapterAddress;
  vaultInfo.bridgeAdapterUpdatedAt = new Date().toISOString();

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("Deployment file updated:", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  if (newAdapterAddress === ethers.ZeroAddress) {
    console.log("🎉 Bridge Adapter Disabled!");
    console.log("=".repeat(70));
    console.log("\nVault:", vaultInfo.name);
    console.log("Vault Address:", vaultInfo.proxyAddress);
    console.log("Bridge Adapter: DISABLED (zero address)");
    console.log("\nThe vault can no longer mint/burn tokens for cross-chain transfers.");
  } else {
    console.log("🎉 Bridge Adapter Configuration Complete!");
    console.log("=".repeat(70));
    console.log("\nVault:", vaultInfo.name);
    console.log("Vault Address:", vaultInfo.proxyAddress);
    console.log("Bridge Adapter:", newAdapterAddress);
    console.log("\n💡 The adapter is now authorized to:");
    console.log("   - Burn receipt tokens when sending cross-chain");
    console.log("   - Mint receipt tokens when receiving cross-chain");
    console.log("\n💡 Next Steps:");
    console.log("1. Configure peer connections on the adapter:");
    console.log(
      `   ADAPTER_KEY=${adapterKey || "<your-adapter-key>"} DST_ENDPOINT_ID=<EID> PEER_ADDRESS=<PEER> yarn bridge:set-peer`
    );
    console.log("2. Bridge tokens:");
    console.log(
      `   ADAPTER_KEY=${adapterKey || "<your-adapter-key>"} DST_ENDPOINT_ID=<EID> AMOUNT=<AMOUNT> yarn bridge:send`
    );
  }
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
