/**
 * Tracks a CCIP transfer from its source transaction through to delivery.
 *
 * Reads the source receipt for our own EmberBridgeSent event and the OnRamp's
 * CCIPMessageSent (which is where the messageId lives — the pool events deliberately do not
 * carry one), then looks for the matching ExecutionStateChanged on the destination OffRamp.
 *
 * Broadcasts nothing. Runs standalone under ts-node so it can talk to both chains at once,
 * which `hardhat run --network` cannot.
 *
 * Usage:
 *   TX_HASH=0x... yarn ccip:track
 *
 * Optional ENV:
 *   SOURCE_NETWORK   Defaults to sepolia
 *   DEST_NETWORK     Required when the source has more than one lane partner (e.g. sepolia)
 *   LOOKBACK_BLOCKS  Destination blocks to scan. Defaults to 60000.
 *   CHUNK_BLOCKS     Blocks per getLogs call. Defaults to 1000 — Pharos Atlantic rejects
 *                    anything larger, and most public RPCs cap the range somewhere.
 *   POOL_KEY         Required when a network has more than one CCIP pool, so the delivery and
 *                    supply reads are made against the vault the transfer actually belongs to.
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { getCcipConfig, getLanePartners } from "../../config/ccip.config";

dotenv.config();

/**
 * Resolves the destination chain. Uses DEST_NETWORK when given; otherwise the sole lane partner.
 * Sepolia is a hub with two spokes, so it has no safe default — say which one.
 */
function resolveDestination(sourceNetwork: string): string {
  const override = process.env.DEST_NETWORK;
  const partners = getLanePartners(sourceNetwork);
  if (override) {
    if (partners.length > 0 && !partners.includes(override)) {
      throw new Error(
        `No configured lane '${sourceNetwork}' -> '${override}'. Known partners: ${partners.join(", ")}`
      );
    }
    return override;
  }
  if (partners.length === 1) return partners[0];
  throw new Error(
    partners.length === 0
      ? `No lane partner configured for '${sourceNetwork}'.`
      : `'${sourceNetwork}' has multiple lane partners (${partners.join(", ")}). Set DEST_NETWORK.`
  );
}

/**
 * CCIP 1.6 OnRamp. The message id is nested inside a non-indexed struct, so it has to be decoded.
 * 2.0 reshaped this event and promoted destChainSelector, sender and messageId to topics, which
 * is why the source leg below discriminates on topic count rather than on a fixed ABI.
 */
const ONRAMP_ABI_16 = [
  "event CCIPMessageSent(uint64 indexed destChainSelector, uint64 indexed sequenceNumber, tuple(tuple(bytes32 messageId, uint64 sourceChainSelector, uint64 destChainSelector, uint64 sequenceNumber, uint64 nonce) header, address sender, bytes data, bytes receiver, bytes extraArgs, address feeToken, uint256 feeTokenAmount, uint256 feeValueJuels, tuple(address sourcePoolAddress, bytes destTokenAddress, bytes extraData, uint256 amount, bytes destExecData)[] tokenAmounts) message)",
];

/**
 * ExecutionStateChanged, both generations. messageId is topic3 in each, so one getLogs filter
 * matches both — but the non-indexed payload differs (1.6 carries messageHash and gasUsed, 2.0
 * does not), so parsing has to try each shape.
 */
const OFFRAMP_EVENTS: { label: string; sig: string }[] = [
  {
    label: "1.6",
    sig: "event ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed sequenceNumber, bytes32 indexed messageId, bytes32 messageHash, uint8 state, bytes returnData, uint256 gasUsed)",
  },
  {
    label: "2.0",
    sig: "event ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed messageNumber, bytes32 indexed messageId, uint8 state, bytes returnData)",
  },
];

const POOL_ABI = [
  "event EmberBridgeSent(uint64 indexed remoteChainSelector, address indexed originalSender, bytes receiver, uint256 amountGross, uint256 amountBurned)",
  "event EmberBridgeReceived(uint64 indexed remoteChainSelector, address indexed receiver, bytes originalSender, uint256 amount)",
];

const ROUTER_ABI = [
  "function getOnRamp(uint64) view returns (address)",
  "function getOffRamps() view returns (tuple(uint64 sourceChainSelector, address offRamp)[])",
];

const EXEC_STATE = ["UNTOUCHED", "IN_PROGRESS", "SUCCESS", "FAILURE"];

function loadDeployment(network: string) {
  const f = `./deployments/${network}-deployment.json`;
  if (!fs.existsSync(f)) throw new Error(`deployment file not found: ${f}`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

function providerFor(network: string) {
  const envVar = getCcipConfig(network).rpcEnv;
  const url = process.env[envVar];
  if (!url) throw new Error(`${envVar} not set`);
  // See verify-ccip-config: some public endpoints cap JSON-RPC batch size, and a rejected batch
  // shows up as an undecodable result rather than an RPC error.
  return new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
}

/**
 * Walks a block range backwards in chunks, newest first, stopping at the first hit.
 * Pharos Atlantic rejects getLogs spans over 1,000 blocks, and scanning newest-first means a
 * recent delivery is found in one or two calls rather than after the whole range.
 */
async function scanChunked(
  provider: ethers.Provider,
  address: string,
  topics0: string[],
  messageId: string,
  fromBlock: number,
  toBlock: number,
  chunkSize: number
): Promise<ethers.Log[]> {
  let hi = toBlock;
  let calls = 0;
  while (hi >= fromBlock) {
    const lo = Math.max(fromBlock, hi - chunkSize + 1);
    calls++;
    try {
      const logs = await provider.getLogs({
        address,
        fromBlock: lo,
        toBlock: hi,
        // topic1 = sourceChainSelector, topic2 = sequenceNumber, topic3 = messageId
        topics: [topics0, null, null, messageId],
      });
      if (logs.length > 0) {
        console.log(`   (found after ${calls} range queries)`);
        return logs;
      }
    } catch (err: any) {
      console.warn(`   ⚠️  getLogs failed on ${address} [${lo}..${hi}]: ${err?.message ?? err}`);
      return [];
    }
    hi = lo - 1;
  }
  console.log(`   (scanned ${calls} ranges, no match)`);
  return [];
}

/** Destination chain selector, from whichever pool is recorded there. */
function dstPoolInfoSelector(dstInfo: any, network: string): string {
  const pool: any = selectPool(dstInfo, network, "destination");
  if (!pool) throw new Error("no CCIP pool recorded on the destination chain");
  return pool.chainSelector;
}

/**
 * Picks a pool out of a deployment's `ccipTokenPools` map.
 *
 * Taking the first entry is only correct while a network has exactly one pool. With several, the
 * tracked transfer can belong to one vault while the "ground truth" supply read below reports a
 * different vault's — silently, and in a script whose entire purpose is to confirm a transfer
 * landed. So: one pool, use it; more than one, require POOL_KEY and say what the choices are.
 */
function selectPool(info: any, network: string, label: string): any {
  const pools = info?.contracts?.ccipTokenPools ?? {};
  const keys = Object.keys(pools);
  if (keys.length === 0) {
    console.error(`\n❌ No ccipTokenPools recorded for ${network} (${label}).`);
    process.exit(1);
  }
  const requested = process.env.POOL_KEY;
  if (requested) {
    if (!pools[requested]) {
      console.error(
        `\n❌ POOL_KEY='${requested}' not found on ${network} (${label}). Available: ${keys.join(", ")}`
      );
      process.exit(1);
    }
    return pools[requested];
  }
  if (keys.length > 1) {
    console.error(
      `\n❌ ${network} (${label}) has ${keys.length} pools; set POOL_KEY to say which transfer to track.` +
        `\n   Available: ${keys.join(", ")}`
    );
    process.exit(1);
  }
  return pools[keys[0]];
}

async function main() {
  const txHash = process.env.TX_HASH;
  if (!txHash) {
    console.error("❌ Error: TX_HASH is required.");
    process.exit(1);
  }
  const sourceNetwork = process.env.SOURCE_NETWORK || "sepolia";
  const destNetwork = resolveDestination(sourceNetwork);
  const lookback = Number(process.env.LOOKBACK_BLOCKS || "60000");
  const chunkSize = Number(process.env.CHUNK_BLOCKS || "1000");

  const srcProvider = providerFor(sourceNetwork);
  const dstProvider = providerFor(destNetwork);
  const srcInfo = loadDeployment(sourceNetwork);
  const dstInfo = loadDeployment(destNetwork);

  console.log(`\n📦 Tracking CCIP message\n   ${sourceNetwork} -> ${destNetwork}\n   ${txHash}\n`);

  const receipt = await srcProvider.getTransactionReceipt(txHash);
  if (!receipt) {
    console.error("❌ Transaction not found on", sourceNetwork);
    process.exit(1);
  }
  console.log(
    `Source tx: block ${receipt.blockNumber}, status ${receipt.status === 1 ? "success" : "REVERTED"}`
  );

  // ---- our own event, which carries the real user -----------------------------------
  const poolIface = new ethers.Interface(POOL_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = poolIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "EmberBridgeSent") {
        console.log("\n📤 EmberBridgeSent (from our pool)");
        console.log("   originalSender:", parsed.args.originalSender);
        console.log("   amountGross:   ", parsed.args.amountGross.toString());
        console.log("   amountBurned:  ", parsed.args.amountBurned.toString());
      }
    } catch {
      /* not ours */
    }
  }

  // ---- messageId, from the OnRamp ----------------------------------------------------
  // Resolve the onRamp from the source Router rather than assuming an address, then read the
  // message id by event shape: 2.0 indexes it as topic3, 1.6 buries it in the struct.
  const srcCcip = getCcipConfig(sourceNetwork);
  const dstSelector = BigInt(dstPoolInfoSelector(dstInfo, destNetwork));
  const srcRouter = new ethers.Contract(srcCcip.router, ROUTER_ABI, srcProvider);
  const onRampAddress: string = await srcRouter.getOnRamp(dstSelector);

  const onRampIface16 = new ethers.Interface(ONRAMP_ABI_16);
  let messageId: string | undefined;
  let sequenceNumber: string | undefined;
  let rampGeneration = "unknown";

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== onRampAddress.toLowerCase()) continue;

    if (log.topics.length === 4) {
      // 2.0: (destChainSelector, sender, messageId) are all indexed.
      rampGeneration = "2.0";
      messageId = log.topics[3];
      console.log("\n📨 CCIPMessageSent (OnRamp 2.0 shape)");
      console.log("   messageId:", messageId);
      console.log("   sender:   ", ethers.getAddress("0x" + log.topics[2].slice(26)));
    } else {
      try {
        const parsed = onRampIface16.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "CCIPMessageSent") {
          rampGeneration = "1.6";
          messageId = parsed.args.message.header.messageId;
          sequenceNumber = parsed.args.message.header.sequenceNumber.toString();
          console.log("\n📨 CCIPMessageSent (OnRamp 1.6 shape)");
          console.log("   messageId:      ", messageId);
          console.log("   sequenceNumber: ", sequenceNumber);
          console.log("   sender:         ", parsed.args.message.sender);
          console.log("   feeTokenAmount: ", parsed.args.message.feeTokenAmount.toString());
        }
      } catch {
        /* not this shape */
      }
    }
  }
  if (rampGeneration !== "unknown") console.log(`   ramp generation: ${rampGeneration}`);

  if (!messageId) {
    console.error("\n❌ No CCIPMessageSent in this transaction — is it really a ccipSend?");
    process.exit(1);
  }

  // ---- delivery, from the destination OffRamp -----------------------------------------
  const dstPoolInfo: any = selectPool(dstInfo, destNetwork, "destination");
  const dstRouter = new ethers.Contract(dstPoolInfo.router, ROUTER_ABI, dstProvider);
  const srcSelector = BigInt(selectPool(srcInfo, sourceNetwork, "source").chainSelector);

  const offRamps = await dstRouter.getOffRamps();
  const matching = offRamps.filter((r: any) => BigInt(r.sourceChainSelector) === srcSelector);
  if (matching.length === 0) {
    console.error("\n❌ No OffRamp on the destination for this source chain.");
    process.exit(1);
  }

  const head = await dstProvider.getBlockNumber();
  const fromBlock = Math.max(0, head - lookback);
  const offRampIfaces = OFFRAMP_EVENTS.map((e) => ({
    label: e.label,
    iface: new ethers.Interface([e.sig]),
  }));
  const topics0 = offRampIfaces.map((f) => f.iface.getEvent("ExecutionStateChanged")!.topicHash);

  console.log(`\n🔎 Scanning ${destNetwork} OffRamps for messageId (blocks ${fromBlock}..${head})`);

  let found = false;
  for (const r of matching) {
    const logs = await scanChunked(
      dstProvider,
      r.offRamp,
      topics0,
      messageId,
      fromBlock,
      head,
      chunkSize
    );

    for (const log of logs) {
      let parsed: ethers.LogDescription | null = null;
      let shape = "?";
      for (const f of offRampIfaces) {
        try {
          const attempt = f.iface.parseLog({ topics: [...log.topics], data: log.data });
          if (attempt) {
            parsed = attempt;
            shape = f.label;
            break;
          }
        } catch {
          /* try the next shape */
        }
      }
      if (!parsed) continue;
      found = true;
      const state = Number(parsed.args.state);
      console.log(`   (decoded as the ${shape} shape)`);
      console.log(`\n📥 ExecutionStateChanged on ${r.offRamp}`);
      console.log("   block:     ", log.blockNumber);
      console.log("   tx:        ", log.transactionHash);
      console.log("   state:     ", `${EXEC_STATE[state] ?? state}`);
      if (parsed.args.gasUsed !== undefined) {
        console.log("   gasUsed:   ", parsed.args.gasUsed.toString());
      }
      if (state === 3) {
        console.log("   returnData:", parsed.args.returnData);
        console.log(
          "\n   ⚠️  FAILURE is replayable — nothing is lost. Re-execute once the cause is"
        );
        console.log("      fixed, via the CCIP Explorer's manual execution.");
      }
    }
  }

  if (!found) {
    console.log("\n⏳ No ExecutionStateChanged yet — the message is still in flight.");
    console.log("   CCIP waits for source-chain finality first, which on Ethereum is roughly");
    console.log("   15 minutes. Re-run in a few minutes.");
  }

  // ---- ground truth: did the shares actually appear? ----------------------------------
  const dstVault = new ethers.Contract(
    dstPoolInfo.vaultAddress,
    ["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"],
    dstProvider
  );
  const [supply, decimals] = await Promise.all([dstVault.totalSupply(), dstVault.decimals()]);
  console.log(
    `\n💰 ${destNetwork} vault totalSupply: ${ethers.formatUnits(supply, decimals)} (${supply} base units)`
  );
  console.log(`   https://ccip.chain.link/msg/${messageId}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
