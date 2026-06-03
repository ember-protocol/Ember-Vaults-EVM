import { ethers } from "hardhat";
import * as fs from "fs";
import { LZ_ENDPOINT_IDS, addressToBytes32 } from "../../config/layerzero.config";

/**
 * Verifies peer configuration between EVM and Sui OFT adapters
 * Checks that both sides are correctly configured to trust each other
 *
 * Required ENV variables:
 * - VAULT_KEY: Key of the vault in deployment file (e.g., "emberExusdcVault")
 * - PEER_ADDRESS: The Sui OFT adapter object ID (bytes32 format)
 *
 * Optional ENV variables:
 * - SUI_DEPLOYMENT_FILE: Path to Sui deployment JSON file for automatic lookup
 */
async function main() {
  console.log("\n🔍 Verifying Peer Configuration...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log();

  // Load EVM deployment file
  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  const vaultKey = process.env.VAULT_KEY;
  let suiAdapterAddress = process.env.PEER_ADDRESS;
  const suiDeploymentFile = process.env.SUI_DEPLOYMENT_FILE;

  if (!vaultKey) {
    console.error("❌ Error: VAULT_KEY environment variable is required!");
    console.log("\nRequired variables:");
    console.log("  VAULT_KEY           - Key of the vault in deployment file");
    console.log("  PEER_ADDRESS        - Sui OFT adapter object ID (bytes32)");
    console.log("\nOptional variables:");
    console.log("  SUI_DEPLOYMENT_FILE - Path to Sui deployment JSON for auto-lookup");

    console.log("\nAvailable vaults:");
    if (deploymentInfo.contracts.vaults) {
      Object.keys(deploymentInfo.contracts.vaults).forEach((key) => {
        const vault = deploymentInfo.contracts.vaults[key];
        console.log(`  - ${key}: ${vault.name}`);
      });
    }
    process.exit(1);
  }

  // Get vault and adapter info
  const vaultInfo = deploymentInfo.contracts.vaults?.[vaultKey];
  if (!vaultInfo) {
    console.error(`❌ Error: Vault '${vaultKey}' not found!`);
    process.exit(1);
  }

  const adapterKey = `${vaultKey}OFTAdapter`;
  const adapterInfo = deploymentInfo.contracts.oftAdapters?.[adapterKey];
  if (!adapterInfo) {
    console.error(`❌ Error: OFT adapter '${adapterKey}' not found!`);
    process.exit(1);
  }

  // Try to load Sui adapter address from Sui deployment file if provided
  if (!suiAdapterAddress && suiDeploymentFile) {
    try {
      if (fs.existsSync(suiDeploymentFile)) {
        const suiDeployment = JSON.parse(fs.readFileSync(suiDeploymentFile, "utf8"));

        // Try testnet first, then mainnet
        const suiNetwork = networkName === "sepolia" ? "testnet" : "mainnet";
        const suiAdapters = suiDeployment[suiNetwork]?.OFTAdapters;

        if (suiAdapters) {
          // Find adapter matching this vault
          for (const [name, adapter] of Object.entries(suiAdapters)) {
            const adapterData = adapter as any;
            if (
              adapterData.EVMVaultKey === vaultKey ||
              adapterData.VaultName === vaultInfo.name ||
              name === vaultInfo.name
            ) {
              suiAdapterAddress = adapterData.AdapterId;
              console.log(`Found Sui adapter in deployment file: ${name}`);
              break;
            }
          }
        }
      }
    } catch (e) {
      console.log("Could not load Sui deployment file, continuing with manual input...");
    }
  }

  if (!suiAdapterAddress) {
    console.error("❌ Error: PEER_ADDRESS is required!");
    console.log("\nProvide the Sui OFT adapter object ID via:");
    console.log("  PEER_ADDRESS=0x... (bytes32 format)");
    console.log("  or");
    console.log("  SUI_DEPLOYMENT_FILE=/path/to/sui-deployment.json");
    process.exit(1);
  }

  // Ensure Sui address is in bytes32 format
  if (!suiAdapterAddress.startsWith("0x") || suiAdapterAddress.length !== 66) {
    console.error("❌ Error: PEER_ADDRESS must be in bytes32 format (0x + 64 hex chars)");
    console.log("Received:", suiAdapterAddress);
    process.exit(1);
  }

  // Determine endpoint IDs based on network
  const isTestnet = networkName === "sepolia" || networkName.includes("testnet");
  const evmEndpointId = isTestnet ? LZ_ENDPOINT_IDS.SEPOLIA : LZ_ENDPOINT_IDS.ETHEREUM;
  const suiEndpointId = isTestnet ? LZ_ENDPOINT_IDS.SUI_TESTNET : LZ_ENDPOINT_IDS.SUI_MAINNET;

  // Convert EVM adapter address to bytes32 for Sui peer config
  const evmAdapterBytes32 = addressToBytes32(adapterInfo.address);

  console.log("=".repeat(70));
  console.log("📋 PEER VERIFICATION REPORT");
  console.log("=".repeat(70));

  console.log("\n📍 Configuration:");
  console.log("-".repeat(40));
  console.log("  Vault:", vaultInfo.name);
  console.log("  EVM Network:", networkName, `(EID: ${evmEndpointId})`);
  console.log("  Sui Network:", isTestnet ? "Testnet" : "Mainnet", `(EID: ${suiEndpointId})`);
  console.log();
  console.log("  EVM Adapter:", adapterInfo.address);
  console.log("  EVM Adapter (bytes32):", evmAdapterBytes32);
  console.log();
  console.log("  Sui Adapter:", suiAdapterAddress);

  // Get EVM adapter contract
  const adapter = await ethers.getContractAt("EmberVaultMintBurnOFTAdapter", adapterInfo.address);

  // Check peer configuration on EVM side
  console.log("\n" + "=".repeat(70));
  console.log("1️⃣  EVM SIDE: Checking if Sui adapter is set as peer");
  console.log("-".repeat(40));

  const peerOnEvm = await adapter.peers(suiEndpointId);
  const isPeerSetOnEvm =
    peerOnEvm !== "0x0000000000000000000000000000000000000000000000000000000000000000";
  const isPeerCorrectOnEvm = peerOnEvm.toLowerCase() === suiAdapterAddress.toLowerCase();

  console.log("  Expected Peer (Sui Adapter):", suiAdapterAddress);
  console.log("  Actual Peer on EVM:", peerOnEvm);
  console.log();

  if (!isPeerSetOnEvm) {
    console.log("  ❌ STATUS: No peer set for Sui endpoint!");
    console.log("     The EVM adapter won't accept messages from Sui.");
  } else if (!isPeerCorrectOnEvm) {
    console.log("  ❌ STATUS: PEER MISMATCH!");
    console.log("     The EVM adapter has a different peer configured.");
    console.log("     Messages from your Sui adapter will be rejected.");
  } else {
    console.log("  ✅ STATUS: Peer is correctly configured!");
  }

  // Show what Sui side should have
  console.log("\n" + "=".repeat(70));
  console.log("2️⃣  SUI SIDE: Expected configuration");
  console.log("-".repeat(40));
  console.log("  The Sui OFT adapter should have:");
  console.log("  - Destination EID:", evmEndpointId, `(${networkName})`);
  console.log("  - Peer Address:", evmAdapterBytes32);
  console.log();
  console.log("  ⚠️  Note: Cannot verify Sui side from this script.");
  console.log("     Please verify manually that the Sui adapter has the");
  console.log("     correct EVM adapter set as its peer.");

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("📝 SUMMARY");
  console.log("=".repeat(70));

  if (isPeerCorrectOnEvm) {
    console.log("\n✅ EVM side is correctly configured!");
    console.log("\nFor bidirectional bridging, ensure the Sui side has:");
    console.log(`   Peer for EID ${evmEndpointId}: ${evmAdapterBytes32}`);
  } else {
    console.log("\n❌ EVM side needs to be fixed!");
    console.log("\nRun the following command to set the correct peer:");
    console.log(
      `\nADAPTER_KEY=${adapterKey} DST_ENDPOINT_ID=${suiEndpointId} PEER_ADDRESS=${suiAdapterAddress} yarn bridge:set-peer --network ${networkName}`
    );
  }

  // Show commands for both directions
  console.log("\n" + "-".repeat(40));
  console.log("📋 Quick Reference - Peer Configuration Commands:");
  console.log("-".repeat(40));
  console.log("\nEVM → Sui (set on EVM):");
  console.log(`  ADAPTER_KEY=${adapterKey} \\`);
  console.log(`  DST_ENDPOINT_ID=${suiEndpointId} \\`);
  console.log(`  PEER_ADDRESS=${suiAdapterAddress} \\`);
  console.log(`  yarn bridge:set-peer --network ${networkName}`);

  console.log("\nSui → EVM (set on Sui):");
  console.log(`  Destination EID: ${evmEndpointId}`);
  console.log(`  Peer Address: ${evmAdapterBytes32}`);

  console.log("\n" + "=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
