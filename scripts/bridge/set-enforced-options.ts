import { ethers } from "hardhat";
import * as fs from "fs";
import { LZ_ENDPOINT_IDS, DEFAULT_GAS_LIMITS } from "../../config/layerzero.config";

/**
 * Sets enforced options on an OFT adapter for a destination chain
 *
 * Enforced options specify the minimum gas limits that must be provided
 * when sending messages to a destination chain. This is required by LayerZero
 * for proper message execution on the destination.
 *
 * Required ENV variables:
 * - ADAPTER_KEY: Key of the OFT adapter in deployment file
 * - DST_ENDPOINT_ID: LayerZero endpoint ID of the destination chain
 *
 * Optional ENV variables:
 * - GAS_LIMIT: Gas limit for lzReceive on destination (default: 200000)
 * - MSG_TYPE: Message type (1 = SEND, 2 = SEND_AND_CALL, default: both)
 */
async function main() {
  console.log("\n⚙️  Setting Enforced Options on OFT Adapter...\n");

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
  const gasLimit = process.env.GAS_LIMIT || "200000";
  const msgType = process.env.MSG_TYPE; // 1 = SEND, 2 = SEND_AND_CALL

  if (!adapterKey || !dstEndpointId) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  ADAPTER_KEY       - Key of the OFT adapter in deployment file");
    console.log("  DST_ENDPOINT_ID   - LayerZero endpoint ID of destination chain");
    console.log("\nOptional variables:");
    console.log("  GAS_LIMIT         - Gas limit for lzReceive (default: 200000)");
    console.log("  MSG_TYPE          - Message type: 1=SEND, 2=SEND_AND_CALL (default: both)");

    console.log("\nAvailable OFT adapters:");
    if (deploymentInfo.contracts.oftAdapters) {
      Object.keys(deploymentInfo.contracts.oftAdapters).forEach((key) => {
        const adapter = deploymentInfo.contracts.oftAdapters[key];
        console.log(`  - ${key}: ${adapter.address}`);
      });
    }

    console.log("\nKnown LayerZero Endpoint IDs:");
    Object.entries(LZ_ENDPOINT_IDS).forEach(([name, id]) => {
      console.log(`  - ${name}: ${id}`);
    });

    console.log("\nExample:");
    console.log(
      "  ADAPTER_KEY=emberExusdcVaultOFTAdapter DST_ENDPOINT_ID=40378 yarn bridge:set-enforced-options"
    );
    process.exit(1);
  }

  // Get adapter info from deployment
  const adapterInfo = deploymentInfo.contracts.oftAdapters?.[adapterKey];
  if (!adapterInfo) {
    console.error(`❌ Error: OFT adapter '${adapterKey}' not found in deployment file!`);
    process.exit(1);
  }

  const dstEid = parseInt(dstEndpointId);
  const gas = BigInt(gasLimit);

  console.log("Configuration:");
  console.log("  Adapter Key:", adapterKey);
  console.log("  Adapter Address:", adapterInfo.address);
  console.log("  Destination EID:", dstEid);
  console.log("  Gas Limit:", gas.toString());
  console.log();

  // Get adapter contract
  const adapter = await ethers.getContractAt("EmberVaultMintBurnOFTAdapter", adapterInfo.address);

  // Check ownership
  const owner = await adapter.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("❌ Error: Signer is not the adapter owner!");
    console.log("  Owner:", owner);
    console.log("  Signer:", signer.address);
    process.exit(1);
  }

  // Build enforced options
  // LayerZero V2 options encoding:
  // - Type 3 options format: 0x0003 + optionType(01) + optionLength(2 bytes) + option
  // - For ExecutorLzReceiveOption (type 01): gas(uint128) + value(uint128, optional)

  // Simple format: 0x00030100110100000000000000000000000000030d40
  // Breakdown:
  // - 0x0003: Options type 3
  // - 01: Worker type (executor = 1)
  // - 0011: Option length (17 bytes)
  // - 01: Option type (lzReceive = 1)
  // - 00000000000000000000000000030d40: gas limit as uint128 (200000 = 0x30d40)

  function buildOptions(gasLimit: bigint): string {
    // Convert gas limit to hex string (uint128 = 16 bytes)
    const gasHex = gasLimit.toString(16).padStart(32, "0");

    // Build the option: type(1) + gas(16 bytes) = 17 bytes
    const option = "01" + gasHex;

    // Option length in bytes (17 = 0x11)
    const optionLength = (option.length / 2).toString(16).padStart(4, "0");

    // Worker type (executor = 1)
    const workerType = "01";

    // Options type 3
    const optionsType = "0003";

    return "0x" + optionsType + workerType + optionLength + option;
  }

  const options = buildOptions(gas);
  console.log("Encoded options:", options);
  console.log();

  // Define message types
  const SEND = 1;
  const SEND_AND_CALL = 2;

  const msgTypes = msgType ? [parseInt(msgType)] : [SEND, SEND_AND_CALL];

  // Check current enforced options
  console.log("Current enforced options:");
  for (const mt of msgTypes) {
    try {
      const current = await adapter.enforcedOptions(dstEid, mt);
      const typeLabel = mt === 1 ? "SEND" : "SEND_AND_CALL";
      console.log(`  ${typeLabel} (${mt}):`, current === "0x" ? "(none)" : current);
    } catch (e: any) {
      console.log(`  Type ${mt}: (error reading)`);
    }
  }
  console.log();

  // Build EnforcedOptionParam array
  interface EnforcedOptionParam {
    eid: number;
    msgType: number;
    options: string;
  }

  const enforcedOptionsParams: EnforcedOptionParam[] = msgTypes.map((mt) => ({
    eid: dstEid,
    msgType: mt,
    options: options,
  }));

  console.log("Setting enforced options...");
  for (const param of enforcedOptionsParams) {
    const typeLabel = param.msgType === 1 ? "SEND" : "SEND_AND_CALL";
    console.log(`  ${typeLabel} (${param.msgType}):`, param.options);
  }
  console.log();

  // Set enforced options
  const tx = await adapter.setEnforcedOptions(enforcedOptionsParams);
  console.log("Transaction hash:", tx.hash);
  console.log("Waiting for confirmation...");

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify
  console.log("\nVerifying enforced options:");
  for (const mt of msgTypes) {
    const newOptions = await adapter.enforcedOptions(dstEid, mt);
    const typeLabel = mt === 1 ? "SEND" : "SEND_AND_CALL";
    console.log(`  ${typeLabel} (${mt}):`, newOptions);
  }

  console.log("\n" + "=".repeat(70));
  console.log("✅ Enforced Options Set Successfully!");
  console.log("=".repeat(70));
  console.log("\nAdapter:", adapterInfo.address);
  console.log("Destination EID:", dstEid);
  console.log("Gas Limit:", gas.toString());
  console.log("\nYou can now send tokens to this destination:");
  console.log(
    `  ADAPTER_KEY=${adapterKey} DST_ENDPOINT_ID=${dstEid} AMOUNT=1 RECIPIENT=<address> yarn bridge:send`
  );
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
