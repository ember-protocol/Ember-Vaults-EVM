import { ethers } from "hardhat";
import * as fs from "fs";
import { LZ_ENDPOINT_IDS, getLzEndpointAddress } from "../../config/layerzero.config";

/**
 * Sets DVN (Decentralized Verifier Network) and Executor configuration
 * on the LayerZero endpoint for an OFT adapter.
 *
 * This is required for LayerZero V2 messaging to work. Without this config,
 * messages will be BLOCKED with "Config Error".
 *
 * Required ENV variables:
 * - ADAPTER_KEY: Key of the OFT adapter in deployment file
 * - DST_ENDPOINT_ID: LayerZero endpoint ID of the destination chain
 *
 * Optional ENV variables:
 * - DVN_ADDRESS: Custom DVN address (defaults to LayerZero DVN)
 * - EXECUTOR_ADDRESS: Custom executor address (defaults to LayerZero Executor)
 */

// LayerZero V2 Testnet Infrastructure Addresses (DVN + Executor only)
// Send/Receive libraries are queried dynamically from the endpoint
// Source: https://docs.layerzero.network/v2/developers/evm/technical-reference/deployed-contracts
const LZ_ADDRESSES = {
  mainnet: {
    dvns: [
      "0xa4fe5a5b9a846458a70cd0748228aed3bf65c2cd",
      "0xa59ba433ac34d2927232918ef5b2eaafcf130ba5",
      "0x3a4636e9ab975d28d3af808b4e1c9fd936374e30",
      "0x373a6e5c0c4e89e24819f00aa37ea370917aaff4",
    ],
    executor: "0x173272739Bd7Aa6e4e214714048a9fE699453059",
    sendConfirmations: 15n,
    receiveConfirmations: 2n,
  },
  pharos: {
    dvns: [
      "0xa83c79e69117eefb888592a23bc02cb6029ada3a",
      "0xdd7b5e1db4aafd5c8ec3b764efb8ed265aa5445b",
      "0x3e249f6892acfef1922fc3bce38fefeec3896817",
      "0xfe5aa76e3ad55bc9cf1fb08324e0d221be4fb932",
    ],
    executor: "0x4208D6E27538189bB48E603D6123A94b8Abe0A0b",
    sendConfirmations: 2n,
    receiveConfirmations: 15n,
  },
  sepolia: {
    dvns: ["0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193"],
    executor: "0x718B92b5CB0a5552039B593faF724D182A881eDA",
    sendConfirmations: 2n,
    receiveConfirmations: 2n,
  },
  atlantic: {
    dvns: ["0xa78a78a13074ed93ad447a26ec57121f29e8fec2"],
    executor: "0x701f3927871EfcEa1235dB722f9E608aE120d243",
    sendConfirmations: 2n,
    receiveConfirmations: 2n,
  },
  // Add more networks as needed
};

// Config type constants for LayerZero V2
const CONFIG_TYPE_ULN = 2; // ULN config for send/receive libraries
const CONFIG_TYPE_EXECUTOR = 1; // Executor config for send library

// Message library types
const SEND_LIB_TYPE = 1;
const RECEIVE_LIB_TYPE = 2;

/**
 * LayerZero ULN requires `requiredDVNs` with no duplicates, strictly ascending (uint160) order.
 * @see UlnBase._assertNoDuplicates in @layerzerolabs/lz-evm-messagelib-v2
 */
function normalizeDvnsAscending(addresses: string[]): string[] {
  const checksummed = addresses.map((a) => ethers.getAddress(a.trim()));
  const seen = new Set<string>();
  const unique = checksummed.filter((addr) => {
    const key = addr.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => {
    if (BigInt(a) < BigInt(b)) return -1;
    if (BigInt(a) > BigInt(b)) return 1;
    return 0;
  });
  return unique;
}

async function main() {
  console.log("\n⚙️  Setting DVN & Executor Configuration...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log();

  // Check if we have addresses for this network
  const lzAddresses = LZ_ADDRESSES[networkName as keyof typeof LZ_ADDRESSES];
  if (!lzAddresses) {
    console.error(`❌ Error: No LayerZero addresses configured for network '${networkName}'`);
    console.log("Available networks:", Object.keys(LZ_ADDRESSES).join(", "));
    process.exit(1);
  }

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

  if (!adapterKey || !dstEndpointId) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  ADAPTER_KEY       - Key of the OFT adapter in deployment file");
    console.log("  DST_ENDPOINT_ID   - LayerZero endpoint ID of destination chain");
    console.log("\nOptional variables:");
    console.log("  DVN_ADDRESS       - Custom DVN address (default: LayerZero DVN)");
    console.log("  EXECUTOR_ADDRESS  - Custom executor address (default: LayerZero Executor)");

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
      "  ADAPTER_KEY=emberExusdcVaultOFTAdapter DST_ENDPOINT_ID=40378 yarn bridge:set-dvn-config --network sepolia"
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

  const rawDvns = process.env.DVN_ADDRESS ? [process.env.DVN_ADDRESS] : lzAddresses.dvns;
  const dvnAddresses = normalizeDvnsAscending(rawDvns);
  const executorAddress = ethers.getAddress(process.env.EXECUTOR_ADDRESS || lzAddresses.executor);

  // Query the actual registered send/receive libraries from the endpoint
  const endpointAddress = getLzEndpointAddress(networkName);
  const endpointForLibQuery = new ethers.Contract(
    endpointAddress,
    [
      "function defaultSendLibrary(uint32 eid) external view returns (address)",
      "function defaultReceiveLibrary(uint32 eid) external view returns (address)",
    ],
    signer
  );

  let sendLibAddress: string;
  let receiveLibAddress: string;
  try {
    sendLibAddress = await endpointForLibQuery.defaultSendLibrary(dstEid);
    receiveLibAddress = await endpointForLibQuery.defaultReceiveLibrary(dstEid);
    console.log("  (queried from endpoint)");
  } catch (e: any) {
    console.error(`\n❌ Error: Could not query default libraries for EID ${dstEid} from endpoint.`);
    console.log("  The pathway may not be supported. Error:", e.message);
    process.exit(1);
  }

  console.log("Configuration:");
  console.log("  Adapter Key:", adapterKey);
  console.log("  Adapter (OApp):", adapterInfo.address);
  console.log("  Destination EID:", dstEid);
  console.log("  DVN:", dvnAddresses);
  console.log("  Executor:", executorAddress);
  console.log("  Send Library:", sendLibAddress);
  console.log("  Receive Library:", receiveLibAddress);
  console.log();

  // Get the adapter contract
  const adapter = await ethers.getContractAt("EmberVaultMintBurnOFTAdapter", adapterInfo.address);

  // Check ownership/delegate
  const owner = await adapter.owner();
  console.log("Adapter owner:", owner);
  console.log("Signer:", signer.address);

  const isOwner = owner.toLowerCase() === signer.address.toLowerCase();
  if (!isOwner) {
    console.error("\n❌ Error: Signer is not the adapter owner!");
    console.log("Only the owner can set endpoint config via the OApp.");
    process.exit(1);
  }

  // EndpointV2 full ABI (reuse endpointAddress from library query above)
  console.log("\nEndpoint address:", endpointAddress);

  const endpointAbi = [
    "function setConfig(address oapp, address lib, tuple(uint32 eid, uint32 configType, bytes config)[] params) external",
    "function getConfig(address oapp, address lib, uint32 eid, uint32 configType) external view returns (bytes memory)",
    "function delegates(address oapp) external view returns (address)",
  ];

  const endpoint = new ethers.Contract(endpointAddress, endpointAbi, signer);

  // Check if adapter has delegated to the signer
  const delegate = await endpoint.delegates(adapterInfo.address);
  console.log("Current delegate:", delegate === ethers.ZeroAddress ? "(none)" : delegate);

  const isDelegate = delegate.toLowerCase() === signer.address.toLowerCase();

  // In LayerZero V2, only the OApp contract itself or its delegate can call setConfig
  // The owner must first set themselves as delegate via OApp.setDelegate()
  if (!isDelegate) {
    console.log("\n⚠️  Signer is not set as delegate. Setting delegate first...");
    console.log("   The OApp owner must call setDelegate() to authorize endpoint config changes.");

    // Call setDelegate on the OApp to register the signer as delegate
    try {
      const setDelegateTx = await adapter.setDelegate(signer.address);
      console.log("   Setting delegate tx:", setDelegateTx.hash);
      await setDelegateTx.wait();
      console.log("   ✅ Delegate set successfully!");

      // Verify delegate was set
      const newDelegate = await endpoint.delegates(adapterInfo.address);
      console.log("   New delegate:", newDelegate);
    } catch (delegateError: any) {
      console.error("\n❌ Error setting delegate:", delegateError.message);
      console.log("\nThe OApp.setDelegate() function may not be available or failed.");
      console.log("You may need to call setDelegate manually on the adapter contract.");
      process.exit(1);
    }
  } else {
    console.log("✅ Signer is already the delegate");
  }

  // Build ULN config for DVN
  // UlnConfig struct: (uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)
  const ulnConfigType =
    "tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)";

  const ulnSendConfig = {
    confirmations: lzAddresses.sendConfirmations, // Must be >= receiver-side inbound confirmations (Sui testnet requires 2)
    requiredDVNCount: dvnAddresses.length,
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    requiredDVNs: dvnAddresses,
    optionalDVNs: [],
  };

  const ulnReceiveConfig = {
    confirmations: lzAddresses.receiveConfirmations, // Must be >= receiver-side inbound confirmations (Sui testnet requires 2)
    requiredDVNCount: dvnAddresses.length,
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    requiredDVNs: dvnAddresses,
    optionalDVNs: [],
  };

  const ulnSendConfigEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [ulnConfigType],
    [ulnSendConfig]
  );
  const ulnReceiveConfigEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [ulnConfigType],
    [ulnReceiveConfig]
  );

  // Build Executor config
  // ExecutorConfig struct: (uint32 maxMessageSize, address executorAddress)
  const executorConfigType = "tuple(uint32 maxMessageSize, address executorAddress)";

  const executorConfig = {
    maxMessageSize: 10000, // Max message size in bytes
    executorAddress: executorAddress,
  };

  const executorConfigEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [executorConfigType],
    [executorConfig]
  );

  console.log("\n📋 Configuration Details:");
  console.log("-".repeat(40));
  console.log("ULN Config (DVN):");
  console.log("  Confirmations:", ulnSendConfig.confirmations.toString());
  console.log("  Required DVNs:", ulnSendConfig.requiredDVNs);
  console.log("  Optional DVNs:", ulnSendConfig.optionalDVNs.length);
  console.log("\nExecutor Config:");
  console.log("  Max Message Size:", executorConfig.maxMessageSize);
  console.log("  Executor:", executorConfig.executorAddress);

  // Try to get the default config to see if pathway is supported
  console.log("\n📋 Checking existing/default configuration...");
  try {
    const existingSendUln = await endpoint.getConfig(
      adapterInfo.address,
      sendLibAddress,
      dstEid,
      CONFIG_TYPE_ULN
    );
    console.log("  Existing Send ULN config:", existingSendUln);

    // Decode it
    const decodedUln = ethers.AbiCoder.defaultAbiCoder().decode([ulnConfigType], existingSendUln);
    console.log("  Decoded:", {
      confirmations: decodedUln[0].confirmations.toString(),
      requiredDVNCount: decodedUln[0].requiredDVNCount,
      requiredDVNs: decodedUln[0].requiredDVNs,
    });
  } catch (e: any) {
    console.log("  Could not get existing config:", e.message);
  }

  // Set config for SEND library (ULN + Executor)
  console.log("\n" + "=".repeat(70));
  console.log("1️⃣  Setting SEND library config...");
  console.log("-".repeat(40));

  // Try ULN config first, then executor
  // Sometimes setting them together fails
  const ulnOnly = process.env.ULN_ONLY === "true";

  const sendConfigParams = ulnOnly
    ? [{ eid: dstEid, configType: CONFIG_TYPE_ULN, config: ulnSendConfigEncoded }]
    : [
        { eid: dstEid, configType: CONFIG_TYPE_ULN, config: ulnSendConfigEncoded },
        { eid: dstEid, configType: CONFIG_TYPE_EXECUTOR, config: executorConfigEncoded },
      ];

  console.log(
    "Config params:",
    JSON.stringify(
      sendConfigParams.map((p) => ({
        eid: p.eid,
        configType: p.configType,
        configLength: p.config.length,
      })),
      null,
      2
    )
  );

  console.log("Setting ULN config for send library...");

  // First try a staticCall to get specific error if it fails
  try {
    await endpoint.setConfig.staticCall(adapterInfo.address, sendLibAddress, sendConfigParams);
  } catch (staticError: any) {
    console.error("\n❌ setConfig would revert!");
    console.log("Error:", staticError.message);
    if (staticError.data) {
      console.log("Revert data:", staticError.data);
    }
    console.log("\nThis could be due to:");
    console.log("  1. Invalid DVN address for this pathway");
    console.log("  2. Invalid Executor address");
    console.log("  3. Library not registered for this OApp");
    console.log("  4. Destination EID not supported");
    console.log("  5. DVN not registered/active for this pathway on the endpoint");
    console.log("\nTry:");
    console.log("  - ULN_ONLY=true to skip executor config");
    console.log("  - Contact LayerZero support to verify pathway support");
    console.log("  - Use the LayerZero CLI: npx @layerzerolabs/toolbox-hardhat oapp:wire");
    throw staticError;
  }

  const sendTx = await endpoint.setConfig(adapterInfo.address, sendLibAddress, sendConfigParams);
  console.log("Transaction hash:", sendTx.hash);
  await sendTx.wait();
  console.log("✅ Send library config set!");

  // Set config for RECEIVE library (ULN only, no executor)
  console.log("\n" + "=".repeat(70));
  console.log("2️⃣  Setting RECEIVE library config...");
  console.log("-".repeat(40));

  const receiveConfigParams = [
    { eid: dstEid, configType: CONFIG_TYPE_ULN, config: ulnReceiveConfigEncoded },
  ];

  console.log("Setting ULN config for receive library...");
  const receiveTx = await endpoint.setConfig(
    adapterInfo.address,
    receiveLibAddress,
    receiveConfigParams
  );
  console.log("Transaction hash:", receiveTx.hash);
  await receiveTx.wait();
  console.log("✅ Receive library config set!");

  // Verify the config
  console.log("\n" + "=".repeat(70));
  console.log("📋 Verifying configuration...");
  console.log("-".repeat(40));

  try {
    const sendUlnConfig = await endpoint.getConfig(
      adapterInfo.address,
      sendLibAddress,
      dstEid,
      CONFIG_TYPE_ULN
    );
    console.log("Send ULN config:", sendUlnConfig);

    const sendExecutorConfig = await endpoint.getConfig(
      adapterInfo.address,
      sendLibAddress,
      dstEid,
      CONFIG_TYPE_EXECUTOR
    );
    console.log("Send Executor config:", sendExecutorConfig);

    const receiveUlnConfig = await endpoint.getConfig(
      adapterInfo.address,
      receiveLibAddress,
      dstEid,
      CONFIG_TYPE_ULN
    );
    console.log("Receive ULN config:", receiveUlnConfig);
  } catch (e: any) {
    console.log("Could not verify config:", e.message);
  }

  console.log("\n" + "=".repeat(70));
  console.log("✅ DVN & Executor Configuration Complete!");
  console.log("=".repeat(70));
  console.log("\nAdapter:", adapterInfo.address);
  console.log("Destination EID:", dstEid);
  console.log("DVNs:", dvnAddresses);
  console.log("Executor:", executorAddress);
  console.log("\nYou should now be able to send messages to this destination.");
  console.log("\nRetry your bridge transaction:");
  console.log(
    `  ADAPTER_KEY=${adapterKey} DST_ENDPOINT_ID=${dstEid} AMOUNT=<amount> RECIPIENT=<address> yarn bridge:send --network ${networkName}`
  );
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
