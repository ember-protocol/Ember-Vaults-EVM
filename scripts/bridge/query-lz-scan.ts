import { LZ_ENDPOINT_IDS } from "../../config/layerzero.config";

/**
 * Queries LayerZero Scan for a transaction status
 *
 * Required ENV variables:
 * - TX_HASH: The transaction hash to query (Sui or EVM format)
 *
 * Optional ENV variables:
 * - NETWORK: "testnet" or "mainnet" (defaults to "testnet")
 * - SRC_CHAIN: Source chain name for filtering (e.g., "sui", "sepolia")
 */

interface LzMessage {
  guid: string;
  srcUaAddress: string;
  dstUaAddress: string;
  srcChainKey: string;
  dstChainKey: string;
  srcEid: number;
  dstEid: number;
  srcTxHash: string;
  dstTxHash?: string;
  status: string;
  created: string;
  updated: string;
}

interface LzScanResponse {
  data?: LzMessage[];
  messages?: LzMessage[];
  error?: string;
}

async function main() {
  console.log("\n🔍 Querying LayerZero Scan...\n");

  const txHash = "0x6d83f37bb6410c9e362b5f8b4fffbc43e9acc373eac341870bd6494d9a22deef";
  const network = process.env.NETWORK || "testnet";
  const srcChain = process.env.SRC_CHAIN;

  if (!txHash) {
    console.error("❌ Error: TX_HASH environment variable is required!");
    console.log("\nUsage:");
    console.log("  TX_HASH=<hash> yarn bridge:lz-scan");
    console.log("\nOptional:");
    console.log("  NETWORK=testnet|mainnet (default: testnet)");
    console.log("  SRC_CHAIN=sui|sepolia|ethereum (for filtering)");
    console.log("\nExample:");
    console.log("  TX_HASH=BhpNRuQkMmnvfR68NKvwJHtFMwf4fyd5fFfxmFLjCdY6 yarn bridge:lz-scan");
    process.exit(1);
  }

  const baseUrl =
    network === "mainnet"
      ? "https://api.layerzeroscan.com"
      : "https://api-testnet.layerzeroscan.com";

  console.log("Configuration:");
  console.log("  Transaction Hash:", txHash);
  console.log("  Network:", network);
  console.log("  API Base URL:", baseUrl);
  if (srcChain) {
    console.log("  Source Chain Filter:", srcChain);
  }
  console.log();

  try {
    // Try multiple API endpoints as LayerZero Scan API structure may vary
    const endpoints = [
      `/v1/messages/tx/${txHash}`,
      `/tx/${txHash}`,
      `/api/trpc/messages.list?input=${encodeURIComponent(JSON.stringify({ hash: txHash }))}`,
    ];

    let messages: LzMessage[] = [];
    let successEndpoint = "";

    for (const endpoint of endpoints) {
      try {
        const url = `${baseUrl}${endpoint}`;
        console.log(`Trying: ${url}`);

        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0",
          },
        });

        if (response.ok) {
          const data = (await response.json()) as LzScanResponse;

          if (data.data && Array.isArray(data.data)) {
            messages = data.data;
            successEndpoint = endpoint;
            break;
          } else if (data.messages && Array.isArray(data.messages)) {
            messages = data.messages;
            successEndpoint = endpoint;
            break;
          } else if (Array.isArray(data)) {
            messages = data;
            successEndpoint = endpoint;
            break;
          }
        }
      } catch (e) {
        // Try next endpoint
        continue;
      }
    }

    if (messages.length === 0) {
      // Try the web scraping approach as fallback
      console.log("\nAPI endpoints didn't return data. Checking web interface...");
      console.log("\n" + "=".repeat(70));
      console.log("📋 MANUAL CHECK REQUIRED");
      console.log("=".repeat(70));
      console.log("\nPlease visit LayerZero Scan directly:");
      console.log(
        `\n  ${network === "mainnet" ? "https://layerzeroscan.com" : "https://testnet.layerzeroscan.com"}/tx/${txHash}`
      );
      console.log("\nAlternatively, search for the transaction hash on:");
      console.log(
        `  ${network === "mainnet" ? "https://layerzeroscan.com" : "https://testnet.layerzeroscan.com"}`
      );

      // Also provide some helpful context
      console.log("\n" + "-".repeat(40));
      console.log("📊 What to look for:");
      console.log("-".repeat(40));
      console.log("  Status: INFLIGHT | DELIVERED | FAILED | BLOCKED");
      console.log("  Source: Should show Sui Testnet (EID 40378)");
      console.log("  Destination: Should show Sepolia (EID 40161)");
      console.log("\n  If DELIVERED: Tokens should be minted");
      console.log("  If INFLIGHT: Wait for DVN confirmations");
      console.log("  If FAILED: Check error message for revert reason");
      console.log("  If BLOCKED: May need to manually retry");

      console.log("\n" + "=".repeat(70) + "\n");
      return;
    }

    console.log(`\n✅ Found ${messages.length} message(s) via ${successEndpoint}\n`);

    // Display messages
    console.log("=".repeat(70));
    console.log("📋 LAYERZERO MESSAGE STATUS");
    console.log("=".repeat(70));

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      console.log(`\nMessage ${i + 1}:`);
      console.log("-".repeat(40));
      console.log("  GUID:", msg.guid);
      console.log("  Status:", getStatusEmoji(msg.status), msg.status);
      console.log();
      console.log("  Source Chain:", msg.srcChainKey, `(EID: ${msg.srcEid})`);
      console.log("  Source Address:", msg.srcUaAddress);
      console.log("  Source Tx:", msg.srcTxHash);
      console.log();
      console.log("  Destination Chain:", msg.dstChainKey, `(EID: ${msg.dstEid})`);
      console.log("  Destination Address:", msg.dstUaAddress);
      if (msg.dstTxHash) {
        console.log("  Destination Tx:", msg.dstTxHash);
      } else {
        console.log("  Destination Tx: (pending)");
      }
      console.log();
      console.log("  Created:", msg.created);
      console.log("  Updated:", msg.updated);

      // Status-specific guidance
      console.log("\n  " + "-".repeat(36));
      printStatusGuidance(msg.status);
    }

    console.log("\n" + "=".repeat(70) + "\n");
  } catch (error: any) {
    console.error("❌ Error querying LayerZero Scan:", error.message);
    console.log("\nPlease check the transaction manually at:");
    console.log(
      `  ${network === "mainnet" ? "https://layerzeroscan.com" : "https://testnet.layerzeroscan.com"}/tx/${txHash}`
    );
  }
}

function getStatusEmoji(status: string): string {
  switch (status?.toUpperCase()) {
    case "DELIVERED":
      return "✅";
    case "INFLIGHT":
      return "🔄";
    case "FAILED":
      return "❌";
    case "BLOCKED":
      return "🚫";
    case "CONFIRMING":
      return "⏳";
    default:
      return "❓";
  }
}

function printStatusGuidance(status: string): void {
  switch (status?.toUpperCase()) {
    case "DELIVERED":
      console.log("  ✅ Message was successfully delivered!");
      console.log("     Tokens should be minted on the destination chain.");
      console.log("     If not visible, check the destination transaction.");
      break;
    case "INFLIGHT":
      console.log("  🔄 Message is in flight - being verified by DVNs.");
      console.log("     This typically takes 1-5 minutes.");
      console.log("     Please wait for DVN confirmations.");
      break;
    case "CONFIRMING":
      console.log("  ⏳ Message is confirming - waiting for block confirmations.");
      console.log("     This should complete shortly.");
      break;
    case "FAILED":
      console.log("  ❌ Message delivery failed!");
      console.log("     Check the destination chain for revert reason.");
      console.log("     Common issues: insufficient gas, contract revert.");
      break;
    case "BLOCKED":
      console.log("  🚫 Message is blocked and needs manual intervention.");
      console.log("     This may require retrying the message.");
      break;
    default:
      console.log("  ❓ Unknown status - please check LayerZero Scan directly.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
