import { ethers } from "hardhat";
import * as fs from "fs";
import { LZ_ENDPOINT_IDS, getLzEndpointAddress } from "../../config/layerzero.config";

/**
 * Pins LayerZero V2 send and receive message libraries for an OApp pathway.
 *
 * Without pinning, the OApp falls back to whatever the Endpoint owner sets as
 * the default. Defaults can change without notice and may not match the DVN /
 * Executor config you've wired up — leading to silent breakage.
 *
 * Run on EACH side of every pathway (bidirectionally).
 *
 * Required ENV variables:
 * - ADAPTER_KEY: Key of the OFT adapter in the deployment file
 * - DST_ENDPOINT_ID: LayerZero endpoint ID of the destination chain
 *
 * Optional ENV variables:
 * - DRY_RUN=true: Only check status, don't send transactions
 *
 * Examples:
 *   ADAPTER_KEY=emberExusdcVaultOFTAdapter DST_ENDPOINT_ID=30407 \
 *     yarn bridge:pin-libraries --network mainnet
 *
 *   ADAPTER_KEY=emberExusdcVaultOFTAdapter DST_ENDPOINT_ID=30101 \
 *     yarn bridge:pin-libraries --network pharos
 */

async function main() {
  console.log("\n📌 Pinning LayerZero Message Libraries\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const dryRun = process.env.DRY_RUN === "true";

  const adapterKey = process.env.ADAPTER_KEY;
  const dstEndpointId = process.env.DST_ENDPOINT_ID;

  if (!adapterKey || !dstEndpointId) {
    console.error("❌ Missing required env vars: ADAPTER_KEY, DST_ENDPOINT_ID");
    console.log("\nKnown LayerZero Endpoint IDs:");
    Object.entries(LZ_ENDPOINT_IDS).forEach(([name, id]) => {
      console.log(`  - ${name}: ${id}`);
    });
    process.exit(1);
  }

  const dstEid = parseInt(dstEndpointId);

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error(`❌ Deployment file not found: ${deploymentFileName}`);
    process.exit(1);
  }
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  const adapterInfo = deploymentInfo.contracts.oftAdapters?.[adapterKey];
  if (!adapterInfo) {
    console.error(`❌ OFT adapter '${adapterKey}' not found in deployment file`);
    console.log("\nAvailable adapters:");
    Object.keys(deploymentInfo.contracts.oftAdapters ?? {}).forEach((k) => {
      console.log(`  - ${k}`);
    });
    process.exit(1);
  }

  const oapp = ethers.getAddress(adapterInfo.address);
  const endpointAddress = getLzEndpointAddress(networkName);

  console.log("Network:         ", networkName);
  console.log("Chain ID:        ", network.chainId.toString());
  console.log("Signer:          ", signer.address);
  console.log("Endpoint:        ", endpointAddress);
  console.log("OApp (adapter):  ", oapp);
  console.log("Destination EID: ", dstEid);
  console.log("Dry run:         ", dryRun);
  console.log();

  const endpointAbi = [
    "function defaultSendLibrary(uint32 eid) external view returns (address)",
    "function defaultReceiveLibrary(uint32 eid) external view returns (address)",
    "function isDefaultSendLibrary(address oapp, uint32 eid) external view returns (bool)",
    "function getSendLibrary(address oapp, uint32 eid) external view returns (address)",
    "function getReceiveLibrary(address oapp, uint32 eid) external view returns (address lib, bool isDefault)",
    "function setSendLibrary(address oapp, uint32 eid, address lib) external",
    "function setReceiveLibrary(address oapp, uint32 eid, address lib, uint256 gracePeriod) external",
    "function delegates(address oapp) external view returns (address)",
  ];
  const endpoint = new ethers.Contract(endpointAddress, endpointAbi, signer);

  // setSendLibrary / setReceiveLibrary on the Endpoint can only be called by
  // the OApp itself or its registered delegate.
  if (!dryRun) {
    const delegate = await endpoint.delegates(oapp);
    console.log("Current delegate:", delegate === ethers.ZeroAddress ? "(none)" : delegate);

    if (delegate.toLowerCase() !== signer.address.toLowerCase()) {
      console.log("\n⚠️  Signer is not the delegate. Setting delegate via OApp...");
      const adapter = await ethers.getContractAt("EmberVaultMintBurnOFTAdapter", oapp);
      const owner = await adapter.owner();
      if (owner.toLowerCase() !== signer.address.toLowerCase()) {
        console.error(
          `❌ Signer (${signer.address}) is not the OApp owner (${owner}). Cannot setDelegate.`
        );
        process.exit(1);
      }
      const tx = await adapter.setDelegate(signer.address);
      console.log("   Tx:", tx.hash);
      await tx.wait();
      console.log("   ✅ Delegate set");
    } else {
      console.log("✅ Signer is already the delegate");
    }
  }

  // ============ SEND LIBRARY ============
  console.log("\n" + "=".repeat(70));
  console.log("1️⃣  SEND library");
  console.log("=".repeat(70));

  const isSendDefault = await endpoint.isDefaultSendLibrary(oapp, dstEid);
  const currentSendLib = await endpoint.getSendLibrary(oapp, dstEid);
  const defaultSendLib = await endpoint.defaultSendLibrary(dstEid);

  console.log("isDefaultSendLibrary:", isSendDefault);
  console.log("Current send lib:    ", currentSendLib);
  console.log("Default send lib:    ", defaultSendLib);

  if (isSendDefault) {
    if (dryRun) {
      console.log(
        "\n⚠️  Send library is using the DEFAULT (not pinned). [DRY RUN — would pin to default]"
      );
    } else {
      console.log("\n⚠️  Send library is using the DEFAULT (not pinned). Pinning now...");
      try {
        await endpoint.setSendLibrary.staticCall(oapp, dstEid, defaultSendLib);
      } catch (e: any) {
        console.error("setSendLibrary would revert:", e.message);
        throw e;
      }
      const tx = await endpoint.setSendLibrary(oapp, dstEid, defaultSendLib);
      console.log("   Tx:", tx.hash);
      await tx.wait();
      console.log("   ✅ Send library pinned to:", defaultSendLib);
    }
  } else {
    console.log("✅ Send library is already pinned");
  }

  // ============ RECEIVE LIBRARY ============
  console.log("\n" + "=".repeat(70));
  console.log("2️⃣  RECEIVE library");
  console.log("=".repeat(70));

  const [currentReceiveLib, isReceiveDefault] = await endpoint.getReceiveLibrary(oapp, dstEid);
  const defaultReceiveLib = await endpoint.defaultReceiveLibrary(dstEid);

  console.log("isDefault (receive): ", isReceiveDefault);
  console.log("Current receive lib: ", currentReceiveLib);
  console.log("Default receive lib: ", defaultReceiveLib);

  if (isReceiveDefault) {
    if (dryRun) {
      console.log(
        "\n⚠️  Receive library is using the DEFAULT (not pinned). [DRY RUN — would pin to default]"
      );
    } else {
      console.log("\n⚠️  Receive library is using the DEFAULT (not pinned). Pinning now...");
      // gracePeriod = 0 means no grace window for accepting messages from the previous library
      try {
        await endpoint.setReceiveLibrary.staticCall(oapp, dstEid, defaultReceiveLib, 0);
      } catch (e: any) {
        console.error("setReceiveLibrary would revert:", e.message);
        throw e;
      }
      const tx = await endpoint.setReceiveLibrary(oapp, dstEid, defaultReceiveLib, 0);
      console.log("   Tx:", tx.hash);
      await tx.wait();
      console.log("   ✅ Receive library pinned to:", defaultReceiveLib);
    }
  } else {
    console.log("✅ Receive library is already pinned");
  }

  console.log("\n" + "=".repeat(70));
  console.log("Done.");
  console.log("");
  console.log("⚠️  Remember: pathways are directional. To fully pin the");
  console.log("   pathway between this chain and EID " + dstEid + ", run this script");
  console.log("   on the OTHER side too with the source EID swapped.");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
