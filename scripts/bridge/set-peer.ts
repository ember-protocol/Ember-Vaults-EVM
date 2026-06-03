import { ethers } from "hardhat";
import * as fs from "fs";
import {
  getLzEndpoint,
  addressToBytes32,
  bytes32ToAddress,
  LZ_ENDPOINT_IDS,
} from "../../config/layerzero.config";

/**
 * Configures peer connections for the OFT Adapter
 * This sets up the trusted remote endpoint for cross-chain messaging
 *
 * Required ENV variables:
 * - ADAPTER_KEY: Key of the OFT adapter in deployment file (e.g., "emberExusdcVaultOFTAdapter")
 * - DST_ENDPOINT_ID: LayerZero endpoint ID of the destination chain
 * - PEER_ADDRESS: Address of the peer OFT contract on the destination chain
 *
 * Optional ENV variables:
 * - PEER_FORMAT: "bytes32" or "address" (defaults to "bytes32")
 */
async function main() {
  console.log("\n🔗 Configuring OFT Adapter Peer Connection...\n");

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
  const adapterKey = process.env.ADAPTER_KEY;
  const dstEndpointId = process.env.DST_ENDPOINT_ID;
  const peerAddress = process.env.PEER_ADDRESS;
  const peerFormat = process.env.PEER_FORMAT || "bytes32";

  if (!adapterKey || !dstEndpointId || !peerAddress) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  ADAPTER_KEY       - Key of the OFT adapter in deployment file");
    console.log("  DST_ENDPOINT_ID   - LayerZero endpoint ID of destination chain");
    console.log("  PEER_ADDRESS      - Address of peer OFT on destination chain");
    console.log("\nOptional variables:");
    console.log("  PEER_FORMAT       - 'bytes32' or 'address' (default: 'bytes32')");

    console.log("\nAvailable OFT adapters:");
    if (deploymentInfo.contracts.oftAdapters) {
      Object.keys(deploymentInfo.contracts.oftAdapters).forEach((key) => {
        const adapter = deploymentInfo.contracts.oftAdapters[key];
        console.log(`  - ${key}: ${adapter.address}`);
      });
    } else {
      console.log("  No OFT adapters found. Deploy one first with: yarn deploy:oft-adapter");
    }

    console.log("\nKnown LayerZero Endpoint IDs:");
    Object.entries(LZ_ENDPOINT_IDS).forEach(([name, id]) => {
      console.log(`  - ${name}: ${id}`);
    });

    process.exit(1);
  }

  // Get adapter info from deployment
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

  // Convert peer address to bytes32 if needed
  let peerBytes32: string;
  if (peerFormat === "address") {
    peerBytes32 = addressToBytes32(peerAddress);
    console.log("Converting address to bytes32:", peerAddress, "->", peerBytes32);
  } else {
    peerBytes32 = peerAddress;
    // Validate bytes32 format
    if (!peerBytes32.startsWith("0x") || peerBytes32.length !== 66) {
      console.error("❌ Error: PEER_ADDRESS must be a valid bytes32 value (0x + 64 hex chars)");
      console.log("Received:", peerBytes32);
      console.log("\nIf providing an address, set PEER_FORMAT=address");
      process.exit(1);
    }
  }

  const dstEid = parseInt(dstEndpointId);

  console.log("Configuration:");
  console.log("  Adapter Key:", adapterKey);
  console.log("  Adapter Address:", adapterInfo.address);
  console.log("  Destination Endpoint ID:", dstEid);
  console.log("  Peer Address (bytes32):", peerBytes32);
  console.log("  Peer Address (decoded):", bytes32ToAddress(peerBytes32));
  console.log();

  // Get adapter contract
  const adapter = await ethers.getContractAt("EmberVaultMintBurnOFTAdapter", adapterInfo.address);

  // Check if peer is already set
  const existingPeer = await adapter.peers(dstEid);
  if (existingPeer !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    console.log("⚠️  Warning: Peer already set for endpoint", dstEid);
    console.log("   Existing peer:", existingPeer);
    console.log("   New peer:", peerBytes32);

    if (existingPeer.toLowerCase() === peerBytes32.toLowerCase()) {
      console.log("\n✅ Peer is already correctly configured. No action needed.");
      process.exit(0);
    }

    console.log("\nUpdating peer configuration...");
  }

  // Set the peer
  console.log("Setting peer...");
  const tx = await adapter.setPeer(dstEid, peerBytes32);
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify the peer was set correctly
  const newPeer = await adapter.peers(dstEid);
  if (newPeer.toLowerCase() === peerBytes32.toLowerCase()) {
    console.log("\n✅ Peer configured successfully!");
  } else {
    console.error("\n❌ Error: Peer verification failed!");
    console.log("Expected:", peerBytes32);
    console.log("Got:", newPeer);
    process.exit(1);
  }

  // Update deployment file with peer info
  if (!adapterInfo.peers) {
    adapterInfo.peers = {};
  }
  adapterInfo.peers[dstEid.toString()] = {
    peerAddress: peerBytes32,
    decodedAddress: bytes32ToAddress(peerBytes32),
    configuredAt: new Date().toISOString(),
    txHash: tx.hash,
    blockNumber: receipt?.blockNumber,
  };

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("Deployment file updated:", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Peer Configuration Complete!");
  console.log("=".repeat(70));
  console.log("\nAdapter:", adapterInfo.address);
  console.log("Destination Endpoint ID:", dstEid);
  console.log("Peer Address:", peerBytes32);
  console.log("\n💡 Next Steps:");
  console.log("1. Configure the peer on the destination chain to point back to this adapter");
  console.log("2. Set enforced options if needed (gas limits for destination execution)");
  console.log("3. Users can now bridge tokens using: yarn bridge:send");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
