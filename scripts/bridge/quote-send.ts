import { ethers } from "hardhat";
import * as fs from "fs";
import { addressToBytes32, LZ_ENDPOINT_IDS } from "../../config/layerzero.config";

/**
 * Quotes the fee for bridging receipt tokens via LayerZero OFT
 * This is a read-only operation that doesn't send any transaction
 *
 * Required ENV variables:
 * - ADAPTER_KEY: Key of the OFT adapter in deployment file
 * - DST_ENDPOINT_ID: LayerZero endpoint ID of the destination chain
 * - AMOUNT: Amount of tokens to bridge (in token units)
 * - RECIPIENT: Recipient address on the destination chain
 *
 * Optional ENV variables:
 * - MIN_AMOUNT: Minimum amount to receive (defaults to AMOUNT)
 * - EXTRA_OPTIONS: Extra options for LayerZero (hex string)
 */
async function main() {
  console.log("\n💰 Quoting LayerZero OFT Bridge Fee...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
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
  const amount = process.env.AMOUNT;
  const recipient = process.env.RECIPIENT;
  const minAmount = process.env.MIN_AMOUNT;
  const extraOptions = process.env.EXTRA_OPTIONS || "0x";

  if (!adapterKey || !dstEndpointId || !amount || !recipient) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  ADAPTER_KEY       - Key of the OFT adapter in deployment file");
    console.log("  DST_ENDPOINT_ID   - LayerZero endpoint ID of destination chain");
    console.log("  AMOUNT            - Amount of tokens to bridge");
    console.log("  RECIPIENT         - Recipient address on destination chain");

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

    process.exit(1);
  }

  // Get adapter info from deployment
  const adapterInfo = deploymentInfo.contracts.oftAdapters?.[adapterKey];
  if (!adapterInfo) {
    console.error(`❌ Error: OFT adapter '${adapterKey}' not found!`);
    process.exit(1);
  }

  const dstEid = parseInt(dstEndpointId);

  // Get adapter and token contracts
  const adapter = await ethers.getContractAt("EmberVaultOFTAdapter", adapterInfo.address);
  const tokenAddress = await adapter.token();
  const token = await ethers.getContractAt("IERC20Metadata", tokenAddress);

  // Get token details
  const tokenDecimals = await token.decimals();
  const tokenSymbol = await token.symbol();

  // Parse amount with correct decimals
  const amountLD = ethers.parseUnits(amount, tokenDecimals);
  const minAmountLD = minAmount ? ethers.parseUnits(minAmount, tokenDecimals) : amountLD;

  // Convert recipient to bytes32
  const recipientBytes32 = addressToBytes32(recipient);

  console.log("Quote Parameters:");
  console.log("  Adapter:", adapterInfo.address);
  console.log("  Token:", tokenSymbol);
  console.log("  Destination EID:", dstEid);
  console.log("  Amount:", amount, tokenSymbol);
  console.log("  Recipient:", recipient);
  console.log();

  // Check peer is configured
  const peer = await adapter.peers(dstEid);
  if (peer === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    console.error("❌ Error: No peer configured for endpoint ID", dstEid);
    process.exit(1);
  }

  // Build SendParam struct
  const sendParam = {
    dstEid: dstEid,
    to: recipientBytes32,
    amountLD: amountLD,
    minAmountLD: minAmountLD,
    extraOptions: extraOptions,
    composeMsg: "0x",
    oftCmd: "0x",
  };

  // Get OFT quote
  const oftQuote = await adapter.quoteOFT(sendParam);
  console.log("OFT Quote:");
  console.log(
    "  Amount Sent:",
    ethers.formatUnits(oftQuote.oftReceipt.amountSentLD, tokenDecimals),
    tokenSymbol
  );
  console.log(
    "  Amount Received:",
    ethers.formatUnits(oftQuote.oftReceipt.amountReceivedLD, tokenDecimals),
    tokenSymbol
  );
  console.log(
    "  Min Limit:",
    ethers.formatUnits(oftQuote.oftLimit.minAmountLD, tokenDecimals),
    tokenSymbol
  );
  console.log(
    "  Max Limit:",
    ethers.formatUnits(oftQuote.oftLimit.maxAmountLD, tokenDecimals),
    tokenSymbol
  );

  // Get messaging fee quote
  const quotedFee = await adapter.quoteSend(sendParam, false);

  console.log("\nMessaging Fee:");
  console.log("  Native Fee:", ethers.formatEther(quotedFee.nativeFee), "ETH");
  console.log("  LZ Token Fee:", quotedFee.lzTokenFee.toString());

  // Calculate total cost
  const ethPrice = 2500; // Approximate, for display purposes
  const feeUSD = parseFloat(ethers.formatEther(quotedFee.nativeFee)) * ethPrice;
  console.log(`  Estimated USD: ~$${feeUSD.toFixed(2)} (at $${ethPrice}/ETH)`);

  console.log("\n" + "=".repeat(50));
  console.log("Quote Summary");
  console.log("=".repeat(50));
  console.log(`Send: ${amount} ${tokenSymbol}`);
  console.log(
    `Receive: ${ethers.formatUnits(oftQuote.oftReceipt.amountReceivedLD, tokenDecimals)} ${tokenSymbol}`
  );
  console.log(`Fee: ${ethers.formatEther(quotedFee.nativeFee)} ETH`);
  console.log("=".repeat(50) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
