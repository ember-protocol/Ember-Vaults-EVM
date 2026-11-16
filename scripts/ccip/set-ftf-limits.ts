import { ethers } from "hardhat";
import * as fs from "fs";
import { getCcipConfig, getLanePartners, poolKeyForVault } from "../../config/ccip.config";

/**
 * Sets the FAST-FINALITY rate limits on a pool's lanes.
 *
 * TokenPool 2.0 keeps two independent rate-limit buckets per lane: one for default-finality
 * transfers and one for faster-than-finality. `ccip:apply-chain-updates` writes only the former
 * and deliberately leaves FTF untouched, so without this script the FTF buckets stay disabled —
 * i.e. an FTF-enabled lane is unthrottled on the very path that trades reorg safety for latency.
 * A source-chain reorg after an early mint leaves duplicated shares on the destination, and the
 * rate limit is what bounds how much can be minted inside the reorg window.
 *
 * Run this on BOTH chains of a lane: each pool only describes its own side.
 *
 * `setRateLimitConfig` is onlyOwnerOrRateLimitAdmin, so this can be sent by the ops multisig
 * once it is set as `rateLimitAdmin` (see `ccip:set-dynamic-config`) rather than waiting out
 * the owner timelock. That is the point of having a rateLimitAdmin at all: tightening a limit
 * during an incident must not be a 12h operation.
 *
 * Required ENV:
 *   VAULT_KEY               Key of the vault in the deployment file
 *   FTF_RATE_LIMIT_CAPACITY Bucket capacity, in token base units
 *   FTF_RATE_LIMIT_RATE     Refill rate per second, in token base units
 *
 * Optional ENV:
 *   REMOTE_NETWORK          Only this lane. Defaults to every configured lane partner.
 *   FTF_INBOUND_CAPACITY / FTF_INBOUND_RATE
 *                           Inbound overrides. Default to outbound +10%, matching
 *                           apply-chain-updates: inbound is sized against the far side's
 *                           outbound, and a tripped inbound bucket strands shares that have
 *                           already burned at the source.
 *   DISABLE                 "true" to disable the FTF buckets (capacity and rate must be 0).
 */
async function main() {
  console.log("\n⚡ Setting fast-finality rate limits...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const local = getCcipConfig(networkName);

  const vaultKey = process.env.VAULT_KEY;
  if (!vaultKey) {
    console.error("❌ Error: VAULT_KEY is required.");
    process.exit(1);
  }

  const disable = process.env.DISABLE === "true";
  const capacity = BigInt(process.env.FTF_RATE_LIMIT_CAPACITY || "0");
  const rate = BigInt(process.env.FTF_RATE_LIMIT_RATE || "0");

  if (!disable && (capacity === 0n || rate === 0n)) {
    console.error("❌ Error: FTF_RATE_LIMIT_CAPACITY and FTF_RATE_LIMIT_RATE are required.");
    console.error("   An FTF-enabled lane with no FTF limit is unthrottled on the reorg-exposed");
    console.error("   path. Pass DISABLE=true only if you are turning the buckets off.");
    process.exit(1);
  }
  if (disable && (capacity !== 0n || rate !== 0n)) {
    console.error("❌ Error: DISABLE=true requires both values to be 0 (the pool rejects a");
    console.error("   disabled config carrying non-zero capacity or rate).");
    process.exit(1);
  }
  // RateLimiter rejects rate > capacity outright; catch it here with a readable message.
  if (!disable && rate > capacity) {
    console.error(`❌ Error: rate (${rate}) must be <= capacity (${capacity}).`);
    process.exit(1);
  }

  const HEADROOM_NUM = 11n;
  const HEADROOM_DEN = 10n;
  const withHeadroom = (v: bigint) => (v * HEADROOM_NUM + HEADROOM_DEN - 1n) / HEADROOM_DEN;
  const inboundCapacity = disable
    ? 0n
    : BigInt(process.env.FTF_INBOUND_CAPACITY || withHeadroom(capacity).toString());
  const inboundRate = disable
    ? 0n
    : BigInt(process.env.FTF_INBOUND_RATE || withHeadroom(rate).toString());

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: deployment file not found:", deploymentFileName);
    process.exit(1);
  }
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  const poolKey = poolKeyForVault(vaultKey);
  const poolInfo = deploymentInfo.contracts.ccipTokenPools?.[poolKey];
  if (!poolInfo) {
    console.error(`❌ Error: no pool '${poolKey}' in ${deploymentFileName}.`);
    process.exit(1);
  }

  const pool = await ethers.getContractAt("EmberTokenPool", poolInfo.address);

  const partners = process.env.REMOTE_NETWORK
    ? [process.env.REMOTE_NETWORK]
    : getLanePartners(networkName);
  if (partners.length === 0) {
    console.error(`❌ Error: no lane partners configured for ${networkName}.`);
    process.exit(1);
  }

  console.log("Pool:   ", poolInfo.address);
  console.log("Network:", local.label);
  console.log("Signer: ", signer.address);
  console.log("FTF out:", disable ? "disabled" : `capacity=${capacity} rate=${rate}/s`);
  console.log(
    "FTF in: ",
    disable ? "disabled" : `capacity=${inboundCapacity} rate=${inboundRate}/s`
  );
  console.log();

  // setRateLimitConfig reverts NonExistentChain for a lane the pool does not have, so only
  // configured lanes are submitted. Everything else is reported and skipped.
  //
  // A lane whose FTF config already matches is also skipped. RateLimiter._setTokenBucketConfig
  // assigns `tokens = capacity` unconditionally, so re-writing an identical config refills the
  // bucket and permits another full burst — undoing the very reorg-exposure bound this script
  // exists to set. The same reasoning, and the same comparison, as apply-chain-updates.
  const outboundConfig = { isEnabled: !disable, capacity, rate };
  const inboundConfig = {
    isEnabled: !disable,
    capacity: inboundCapacity,
    rate: inboundRate,
  };
  const sameBucket = (b: any, c: { isEnabled: boolean; capacity: bigint; rate: bigint }) =>
    b.isEnabled === c.isEnabled && b.capacity === c.capacity && b.rate === c.rate;

  const args: any[] = [];
  let unchanged = 0;
  for (const partner of partners) {
    const remote = getCcipConfig(partner);
    const supported = await pool.isSupportedChain(remote.chainSelector);
    if (!supported) {
      console.log(`  ⏭️  ${remote.label}: lane not configured — run ccip:apply-chain-updates`);
      continue;
    }

    const [curOut, curIn] = await pool.getCurrentRateLimiterState(remote.chainSelector, true);
    if (sameBucket(curOut, outboundConfig) && sameBucket(curIn, inboundConfig)) {
      console.log(`  ⏭️  ${remote.label}: FTF limits already match — not rewriting (would refill)`);
      unchanged++;
      continue;
    }

    console.log(`  ✅ ${remote.label}: queued (selector ${remote.chainSelector})`);
    args.push({
      remoteChainSelector: remote.chainSelector,
      fastFinality: true,
      outboundRateLimiterConfig: outboundConfig,
      inboundRateLimiterConfig: inboundConfig,
    });
  }

  if (args.length === 0) {
    console.log(
      unchanged > 0
        ? `\nNothing to do — all ${unchanged} configured lane(s) already match.`
        : "\nNothing to do — no configured lanes."
    );
    process.exit(0);
  }

  const [owner, rateLimitAdmin] = await Promise.all([
    pool.owner(),
    pool.getDynamicConfig().then((c: any) => c[1]),
  ]);
  const permitted =
    owner.toLowerCase() === signer.address.toLowerCase() ||
    rateLimitAdmin.toLowerCase() === signer.address.toLowerCase();
  if (!permitted) {
    console.error("\n❌ Error: setRateLimitConfig is onlyOwnerOrRateLimitAdmin.");
    console.log("   Pool owner:    ", owner);
    console.log("   rateLimitAdmin:", rateLimitAdmin);
    console.log("   Signer:        ", signer.address);
    console.log("   If the owner is a Timelock or Safe, generate the calldata instead:");
    console.log("  ", pool.interface.encodeFunctionData("setRateLimitConfig", [args]));
    process.exit(1);
  }

  console.log(
    `\n⚠️  ${args.length} lane(s) will be written, and writing a bucket refills it to full`
  );
  console.log("    capacity — a burst can immediately follow this transaction.\n");

  const tx = await pool.setRateLimitConfig(args);
  const receipt = await tx.wait();
  console.log("✅ setRateLimitConfig confirmed in block", receipt?.blockNumber);

  // Read back rather than trust the receipt: behind a load balancer the next read can land on
  // a node that has not caught up yet.
  console.log("\n📊 Verification:");
  for (const arg of args) {
    const [out, inb] = await pool.getCurrentRateLimiterState(arg.remoteChainSelector, true);
    const fmt = (b: any) => (b.isEnabled ? `capacity=${b.capacity} rate=${b.rate}/s` : "disabled");
    console.log(`  selector ${arg.remoteChainSelector}: out ${fmt(out)} | in ${fmt(inb)}`);
  }

  poolInfo.ftfRateLimits = {
    enabled: !disable,
    outbound: { capacity: capacity.toString(), rate: rate.toString() },
    inbound: { capacity: inboundCapacity.toString(), rate: inboundRate.toString() },
    lanes: args.map((a) => a.remoteChainSelector.toString()),
    updatedAt: new Date().toISOString(),
    txHash: receipt?.hash,
    blockNumber: receipt?.blockNumber,
  };
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2) + "\n");
  console.log("\n✅ Recorded in", deploymentFileName, "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
