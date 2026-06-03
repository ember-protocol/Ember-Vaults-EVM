import { ethers } from "hardhat";
import * as fs from "fs";
import {
  getLzEndpoint,
  addressToBytes32,
  LZ_ENDPOINT_IDS,
  DEFAULT_GAS_LIMITS,
} from "../../config/layerzero.config";

/**
 * Bridges receipt tokens to another chain via LayerZero OFT
 *
 * Required ENV variables:
 * - ADAPTER_KEY: Key of the OFT adapter in deployment file
 * - DST_ENDPOINT_ID: LayerZero endpoint ID of the destination chain
 * - AMOUNT: Amount of tokens to bridge (in token units, e.g., "100" for 100 tokens)
 * - RECIPIENT: Recipient address on the destination chain
 *
 * Optional ENV variables:
 * - MIN_AMOUNT: Minimum amount to receive (slippage protection, defaults to AMOUNT)
 * - EXTRA_OPTIONS: Extra options for LayerZero (hex string)
 * - COMPOSE_MSG: Compose message for additional execution on destination (hex string)
 * - REFUND_ADDRESS: Address to receive refunds (defaults to sender)
 * - QUOTE_ONLY: If "true", only quotes the fee without sending
 */
async function main() {
  console.log("\n🚀 Bridging Receipt Tokens via LayerZero OFT...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Sender:", signer.address);
  console.log(
    "Sender Balance:",
    ethers.formatEther(await ethers.provider.getBalance(signer.address)),
    "ETH\n"
  );

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
  const composeMsg = process.env.COMPOSE_MSG || "0x";
  const refundAddress = process.env.REFUND_ADDRESS;
  const quoteOnly = process.env.QUOTE_ONLY === "true";

  if (!adapterKey || !dstEndpointId || !amount || !recipient) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  ADAPTER_KEY       - Key of the OFT adapter in deployment file");
    console.log("  DST_ENDPOINT_ID   - LayerZero endpoint ID of destination chain");
    console.log("  AMOUNT            - Amount of tokens to bridge");
    console.log("  RECIPIENT         - Recipient address on destination chain");
    console.log("\nOptional variables:");
    console.log("  MIN_AMOUNT        - Minimum amount to receive (slippage protection)");
    console.log("  EXTRA_OPTIONS     - Extra LayerZero options (hex string)");
    console.log("  COMPOSE_MSG       - Compose message for destination (hex string)");
    console.log("  REFUND_ADDRESS    - Address for refunds (default: sender)");
    console.log("  QUOTE_ONLY        - Set to 'true' to only get fee quote");

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
    console.error(`❌ Error: OFT adapter '${adapterKey}' not found in deployment file!`);
    process.exit(1);
  }

  const dstEid = parseInt(dstEndpointId);

  // Get adapter and token contracts
  const adapter = await ethers.getContractAt("EmberVaultMintBurnOFTAdapter", adapterInfo.address);
  const tokenAddress = await adapter.token();
  const token = await ethers.getContractAt("IERC20Metadata", tokenAddress);

  // Get token details
  const tokenDecimals = await token.decimals();
  const tokenSymbol = await token.symbol();
  const tokenBalance = await token.balanceOf(signer.address);

  // Parse amount with correct decimals
  const amountLD = ethers.parseUnits(amount, tokenDecimals);
  const minAmountLD = minAmount ? ethers.parseUnits(minAmount, tokenDecimals) : amountLD;

  // Convert recipient to bytes32
  const recipientBytes32 = addressToBytes32(recipient);

  console.log("Bridge Configuration:");
  console.log("  Adapter Key:", adapterKey);
  console.log("  Adapter Address:", adapterInfo.address);
  console.log("  Token:", tokenSymbol, `(${tokenAddress})`);
  console.log("  Token Decimals:", tokenDecimals);
  console.log("  Sender Balance:", ethers.formatUnits(tokenBalance, tokenDecimals), tokenSymbol);
  console.log("  Destination Endpoint ID:", dstEid);
  console.log("  Recipient:", recipient);
  console.log("  Recipient (bytes32):", recipientBytes32);
  console.log("  Amount:", amount, tokenSymbol, `(${amountLD.toString()} wei)`);
  console.log("  Min Amount:", minAmount || amount, tokenSymbol);
  console.log("  Refund Address:", refundAddress || signer.address);
  console.log("  Quote Only:", quoteOnly);
  console.log();

  // Check balance
  if (tokenBalance < amountLD) {
    console.error("❌ Error: Insufficient token balance!");
    console.log("Required:", ethers.formatUnits(amountLD, tokenDecimals), tokenSymbol);
    console.log("Available:", ethers.formatUnits(tokenBalance, tokenDecimals), tokenSymbol);
    process.exit(1);
  }

  // Check peer is configured
  const peer = await adapter.peers(dstEid);
  if (peer === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    console.error("❌ Error: No peer configured for endpoint ID", dstEid);
    console.log("Configure peer first using: yarn bridge:set-peer");
    process.exit(1);
  }
  console.log("Peer configured:", peer);

  // Check enforced options
  console.log("\nChecking enforced options...");
  try {
    // Message type 1 = SEND
    const enforcedOptions = await adapter.enforcedOptions(dstEid, 1);
    if (enforcedOptions === "0x" || enforcedOptions === "0x0" || enforcedOptions.length <= 2) {
      console.log("⚠️  Warning: No enforced options set for destination EID", dstEid);
      console.log("   This may cause quoteSend to fail. Consider setting enforced options.");
    } else {
      console.log("Enforced options (SEND):", enforcedOptions);
    }
  } catch (e: any) {
    console.log("⚠️  Could not check enforced options:", e.message);
  }

  // Build SendParam struct
  const sendParam = {
    dstEid: dstEid,
    to: recipientBytes32,
    amountLD: amountLD,
    minAmountLD: minAmountLD,
    extraOptions: extraOptions,
    composeMsg: composeMsg,
    oftCmd: "0x", // Empty for standard send
  };

  // Quote the messaging fee
  console.log("\n📊 Quoting messaging fee...");

  let quotedFee;
  try {
    quotedFee = await adapter.quoteSend(sendParam, false);
  } catch (quoteError: any) {
    console.error("\n❌ Error: quoteSend failed!");
    console.log("\nDiagnostics:");
    console.log("  - Peer address:", peer);
    console.log("  - Destination EID:", dstEid);
    console.log("  - Adapter address:", adapterInfo.address);

    // Try to get more specific error
    try {
      const iface = adapter.interface;
      if (quoteError.data && quoteError.data.length > 2) {
        try {
          const decodedError = iface.parseError(quoteError.data);
          console.log("  - Decoded error:", decodedError?.name, decodedError?.args);
        } catch {
          console.log("  - Raw revert data:", quoteError.data);
        }
      }
    } catch {}

    console.log("\nPossible causes:");
    console.log(
      "  1. Enforced options not set - Run: ADAPTER_KEY=" +
        adapterKey +
        " DST_ENDPOINT_ID=" +
        dstEid +
        " yarn bridge:set-enforced-options"
    );
    console.log(
      "  2. Incorrect peer address - Verify the peer matches the destination OFT adapter"
    );
    console.log("  3. DVN/Executor not configured on the LayerZero endpoint");
    console.log("  4. Message library not initialized for this pathway");

    // Check if we should try with default gas options
    if (extraOptions === "0x") {
      console.log("\n💡 Tip: Try providing extraOptions with gas limit:");
      console.log("   EXTRA_OPTIONS=0x00030100110100000000000000000000000000030d40");
      console.log("   (This encodes: lzReceive gas = 200000)");
    }

    throw quoteError;
  }

  console.log("Messaging Fee:");
  console.log("  Native Fee:", ethers.formatEther(quotedFee.nativeFee), "ETH");
  console.log("  LZ Token Fee:", quotedFee.lzTokenFee.toString());

  // Also get OFT quote for more details
  const oftQuote = await adapter.quoteOFT(sendParam);
  console.log("\nOFT Quote:");
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
    "  Min Amount:",
    ethers.formatUnits(oftQuote.oftLimit.minAmountLD, tokenDecimals),
    tokenSymbol
  );
  console.log(
    "  Max Amount:",
    ethers.formatUnits(oftQuote.oftLimit.maxAmountLD, tokenDecimals),
    tokenSymbol
  );

  if (quoteOnly) {
    console.log("\n✅ Quote complete (QUOTE_ONLY=true, not sending)");
    process.exit(0);
  }

  // Check ETH balance for fee
  const ethBalance = await ethers.provider.getBalance(signer.address);
  if (ethBalance < quotedFee.nativeFee) {
    console.error("\n❌ Error: Insufficient ETH for messaging fee!");
    console.log("Required:", ethers.formatEther(quotedFee.nativeFee), "ETH");
    console.log("Available:", ethers.formatEther(ethBalance), "ETH");
    process.exit(1);
  }

  // Check and set approval
  const allowance = await token.allowance(signer.address, adapterInfo.address);
  if (allowance < amountLD) {
    console.log("\n📝 Approving adapter for token transfer...");
    const approveTx = await token.approve(adapterInfo.address, amountLD);
    console.log("Approval tx:", approveTx.hash);
    await approveTx.wait();
    console.log("Approval confirmed");
  } else {
    console.log("\n✅ Sufficient allowance already granted");
  }

  // Send tokens
  console.log("\n🚀 Sending tokens...");
  const messagingFee = {
    nativeFee: quotedFee.nativeFee,
    lzTokenFee: 0n, // Pay in native token
  };

  const tx = await adapter.send(sendParam, messagingFee, refundAddress || signer.address, {
    value: quotedFee.nativeFee,
  });

  console.log("Transaction hash:", tx.hash);
  console.log("Waiting for confirmation...");

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Parse events
  console.log("\n📋 Transaction Events:");
  for (const log of receipt?.logs || []) {
    try {
      const parsed = adapter.interface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (parsed) {
        console.log(`  ${parsed.name}:`, parsed.args);
      }
    } catch (e) {
      // Not an adapter event, skip
    }
  }

  // Check new balance
  const newBalance = await token.balanceOf(signer.address);
  console.log("\nNew Balance:", ethers.formatUnits(newBalance, tokenDecimals), tokenSymbol);
  console.log(
    "Tokens Bridged:",
    ethers.formatUnits(tokenBalance - newBalance, tokenDecimals),
    tokenSymbol
  );

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Bridge Transaction Submitted Successfully!");
  console.log("=".repeat(70));
  console.log("\nTransaction Hash:", tx.hash);
  console.log("Amount:", amount, tokenSymbol);
  console.log("Destination Endpoint ID:", dstEid);
  console.log("Recipient:", recipient);
  console.log("Fee Paid:", ethers.formatEther(quotedFee.nativeFee), "ETH");
  console.log("\n💡 Track your transaction:");
  console.log("   LayerZero Scan: https://layerzeroscan.com/tx/" + tx.hash);
  console.log("\n⏳ The tokens will arrive on the destination chain shortly.");
  console.log("   Delivery time depends on the destination chain's finality.");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
