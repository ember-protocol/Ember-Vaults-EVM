import { ethers } from "hardhat";
import * as fs from "fs";
import { LZ_ENDPOINT_IDS } from "../../config/layerzero.config";

/**
 * Diagnoses bridge configuration issues
 * Checks peer configuration, bridge adapter authorization, and adapter state
 *
 * Required ENV variables:
 * - VAULT_KEY: Key of the vault in deployment file (e.g., "emberExusdcVault")
 */
async function main() {
  console.log("\n🔍 Diagnosing Bridge Configuration...\n");

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

  const vaultKey = process.env.VAULT_KEY;
  if (!vaultKey) {
    console.error("❌ Error: VAULT_KEY environment variable is required!");
    console.log("\nAvailable vaults:");
    if (deploymentInfo.contracts.vaults) {
      Object.keys(deploymentInfo.contracts.vaults).forEach((key) => {
        const vault = deploymentInfo.contracts.vaults[key];
        console.log(`  - ${key}: ${vault.name}`);
      });
    }
    process.exit(1);
  }

  const vaultInfo = deploymentInfo.contracts.vaults?.[vaultKey];
  if (!vaultInfo) {
    console.error(`❌ Error: Vault '${vaultKey}' not found!`);
    process.exit(1);
  }

  // Find the OFT adapter for this vault
  const adapterKey = `${vaultKey}OFTAdapter`;
  const adapterInfo = deploymentInfo.contracts.oftAdapters?.[adapterKey];

  console.log("=".repeat(70));
  console.log("📋 BRIDGE DIAGNOSTIC REPORT");
  console.log("=".repeat(70));

  // 1. Check Vault Info
  console.log("\n1️⃣  VAULT INFO");
  console.log("-".repeat(40));
  console.log("  Vault Key:", vaultKey);
  console.log("  Vault Name:", vaultInfo.name);
  console.log("  Vault Address:", vaultInfo.proxyAddress);
  console.log("  Version:", vaultInfo.version);

  const vault = await ethers.getContractAt("EmberVault", vaultInfo.proxyAddress);

  // Check if vault has bridgeAdapter function
  let bridgeAdapterOnVault: string | null = null;
  try {
    bridgeAdapterOnVault = await vault.bridgeAdapter();
    console.log("  Bridge Adapter on Vault:", bridgeAdapterOnVault);

    if (bridgeAdapterOnVault === ethers.ZeroAddress) {
      console.log("  ❌ STATUS: Bridge adapter NOT SET on vault!");
      console.log("     The OFT adapter cannot mint tokens without authorization.");
      console.log("     Fix: Run bridge:set-adapter script");
    } else {
      console.log("  ✓ Bridge adapter is configured");
    }
  } catch (e) {
    console.log("  ❌ Bridge adapter function not found - vault may need upgrade to v1.2.0+");
  }

  // 2. Check OFT Adapter Info
  console.log("\n2️⃣  OFT ADAPTER INFO");
  console.log("-".repeat(40));

  if (!adapterInfo) {
    console.log("  ❌ No OFT adapter found for this vault in deployment file!");
    console.log("     Deploy one with: yarn deploy:oft-adapter");
  } else {
    console.log("  Adapter Key:", adapterKey);
    console.log("  Adapter Address:", adapterInfo.address);
    console.log("  Contract:", adapterInfo.contractName);

    const adapter = await ethers.getContractAt("EmberVaultMintBurnOFTAdapter", adapterInfo.address);

    // Check adapter owner
    const adapterOwner = await adapter.owner();
    console.log("  Adapter Owner:", adapterOwner);

    // Check token
    const adapterToken = await adapter.token();
    console.log("  Token (should match vault):", adapterToken);

    if (adapterToken.toLowerCase() !== vaultInfo.proxyAddress.toLowerCase()) {
      console.log("  ❌ Token mismatch! Adapter token doesn't match vault address.");
    } else {
      console.log("  ✓ Token matches vault");
    }

    // Check if adapter matches what's set on vault
    if (bridgeAdapterOnVault) {
      if (bridgeAdapterOnVault.toLowerCase() === adapterInfo.address.toLowerCase()) {
        console.log("  ✓ Adapter is authorized on vault");
      } else if (bridgeAdapterOnVault !== ethers.ZeroAddress) {
        console.log("  ⚠️  Different adapter is set on vault:", bridgeAdapterOnVault);
      }
    }

    // 3. Check Peer Configuration
    console.log("\n3️⃣  PEER CONFIGURATION");
    console.log("-".repeat(40));

    const peerEndpoints = [
      { name: "Sui Testnet", eid: LZ_ENDPOINT_IDS.SUI_TESTNET },
      { name: "Sui Mainnet", eid: LZ_ENDPOINT_IDS.SUI_MAINNET },
      { name: "Ethereum", eid: LZ_ENDPOINT_IDS.ETHEREUM },
      { name: "Sepolia", eid: LZ_ENDPOINT_IDS.SEPOLIA },
    ];

    let hasPeers = false;
    for (const { name, eid } of peerEndpoints) {
      try {
        const peer = await adapter.peers(eid);
        if (peer !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
          console.log(`  ${name} (EID ${eid}):`);
          console.log(`    Peer: ${peer}`);
          hasPeers = true;
        }
      } catch (e) {
        // Skip
      }
    }

    if (!hasPeers) {
      console.log("  ❌ No peers configured!");
      console.log("     The adapter won't accept messages from any chain.");
      console.log("     Fix: Run bridge:set-peer script");
    }

    // Check peers from deployment file
    if (adapterInfo.peers && Object.keys(adapterInfo.peers).length > 0) {
      console.log("\n  Peers from deployment file:");
      for (const [eid, peerInfo] of Object.entries(adapterInfo.peers)) {
        console.log(`    EID ${eid}: ${(peerInfo as any).peerAddress}`);
      }
    }
  }

  // 4. Summary and Recommendations
  console.log("\n" + "=".repeat(70));
  console.log("📝 SUMMARY & RECOMMENDATIONS");
  console.log("=".repeat(70));

  const issues: string[] = [];

  if (!bridgeAdapterOnVault || bridgeAdapterOnVault === ethers.ZeroAddress) {
    issues.push("Bridge adapter not set on vault - adapter cannot mint tokens");
  }

  if (!adapterInfo) {
    issues.push("No OFT adapter deployed");
  }

  if (issues.length === 0) {
    console.log("\n✅ Configuration looks correct!");
    console.log("\nIf messages are not arriving, check:");
    console.log("  1. LayerZero Scan for message status: https://testnet.layerzeroscan.com/");
    console.log("  2. DVN/Executor configuration");
    console.log("  3. Gas limits in enforced options");
  } else {
    console.log("\n❌ Issues found:\n");
    issues.forEach((issue, i) => {
      console.log(`  ${i + 1}. ${issue}`);
    });

    console.log("\n💡 Fixes:");
    if (!bridgeAdapterOnVault || bridgeAdapterOnVault === ethers.ZeroAddress) {
      console.log(`\n  Set bridge adapter on vault:`);
      console.log(
        `  VAULT_KEY=${vaultKey} ADAPTER_KEY=${adapterKey} yarn bridge:set-adapter --network ${networkName}`
      );
    }
  }

  console.log("\n" + "=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
