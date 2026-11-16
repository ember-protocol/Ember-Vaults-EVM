import { ethers } from "hardhat";
import * as fs from "fs";
import { getCcipConfig, getRemoteConfig, poolKeyForVault } from "../../config/ccip.config";

/**
 * Configures a lane on this chain's EmberTokenPool: which remote chain it talks to, which
 * pool and token live on the far side, and the per-direction rate limits.
 *
 * Run this on BOTH chains — each pool only ever describes the remote side, so a working lane
 * needs one call per chain, not two per chain.
 *
 * Reads the remote pool and token out of the remote chain's deployment file, so deploy both
 * pools first. Rate limits default to disabled, which is the right starting point for a
 * testnet rehearsal; set them deliberately before mainnet — Chainlink confirmed there are no
 * limits other than the ones configured here.
 *
 * ON AN EXISTING LANE this script never removes and re-adds. `applyChainUpdates` deletes the
 * chain's remote-pool set and BOTH fast-finality rate-limit configs on removal, and re-adding
 * refills the buckets to full capacity. A re-run to nudge a limit would therefore silently drop
 * FTF limits and any second remote pool left in place during a pool migration. Limits go through
 * `setRateLimitConfig` and pools through `addRemotePool`, which is what those calls are for.
 *
 * Inbound limits default ~10% above outbound, so ordinary timing and batching differences on the
 * far side don't trip the inbound bucket. Set them explicitly to override.
 *
 * Required ENV:
 *   VAULT_KEY        Key of the vault in the deployment file
 *
 * Optional ENV:
 *   REMOTE_NETWORK   Override the lane partner (defaults per config/ccip.config.ts)
 *   RATE_LIMIT_CAPACITY / RATE_LIMIT_RATE   Enable rate limiting, in token base units.
 *                    These are the OUTBOUND values.
 *   RATE_LIMIT_INBOUND_CAPACITY / RATE_LIMIT_INBOUND_RATE
 *                    Inbound overrides. Default to outbound +10%, rounded up.
 *   LANE_RECREATE    "true" to force the destructive remove+re-add path. Only needed to change
 *                    a lane's remote TOKEN address. Wipes FTF limits and extra remote pools.
 *   IS_ETH_VAULT     "true" to look the vault up under ethVaults
 */
async function main() {
  console.log("\n🔗 Applying CCIP chain updates...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const local = getCcipConfig(networkName);
  const remote = getRemoteConfig(networkName, process.env.REMOTE_NETWORK);

  console.log("Local: ", local.label, `(selector ${local.chainSelector})`);
  console.log("Remote:", remote.label, `(selector ${remote.chainSelector})`);
  console.log("Signer:", signer.address, "\n");

  const vaultKey = process.env.VAULT_KEY;
  if (!vaultKey) {
    console.error("❌ Error: VAULT_KEY is required.");
    process.exit(1);
  }
  const poolKey = poolKeyForVault(vaultKey);

  const localFile = `./deployments/${networkName}-deployment.json`;
  const remoteFile = `./deployments/${remote.network}-deployment.json`;
  for (const f of [localFile, remoteFile]) {
    if (!fs.existsSync(f)) {
      console.error("❌ Error: deployment file not found:", f);
      process.exit(1);
    }
  }
  const localInfo = JSON.parse(fs.readFileSync(localFile, "utf8"));
  const remoteInfo = JSON.parse(fs.readFileSync(remoteFile, "utf8"));

  const localPoolInfo = localInfo.contracts.ccipTokenPools?.[poolKey];
  const remotePoolInfo = remoteInfo.contracts.ccipTokenPools?.[poolKey];
  if (!localPoolInfo) {
    console.error(`❌ Error: no pool '${poolKey}' in ${localFile}. Deploy it first.`);
    process.exit(1);
  }
  if (!remotePoolInfo) {
    console.error(`❌ Error: no pool '${poolKey}' in ${remoteFile}.`);
    console.log("   Deploy the pool on the remote chain first — this script reads its address");
    console.log(
      `   from there:  VAULT_KEY=${vaultKey} yarn ccip:deploy-pool --network ${remote.network}`
    );
    process.exit(1);
  }

  const pool = await ethers.getContractAt("EmberTokenPool", localPoolInfo.address);

  const owner = await pool.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("❌ Error: applyChainUpdates is onlyOwner.");
    console.log("   Pool owner:", owner);
    console.log("   Signer:    ", signer.address);
    console.log("   If the owner is a Timelock or Safe, generate the calldata instead of");
    console.log("   sending directly — see the ember-utils tx-bytes flow.");
    process.exit(1);
  }

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const remotePoolEncoded = coder.encode(["address"], [remotePoolInfo.address]);
  const remoteTokenEncoded = coder.encode(["address"], [remotePoolInfo.vaultAddress]);

  const capacity = BigInt(process.env.RATE_LIMIT_CAPACITY || "0");
  const rate = BigInt(process.env.RATE_LIMIT_RATE || "0");
  const rateLimitEnabled = capacity > 0n || rate > 0n;
  if (rateLimitEnabled && (capacity === 0n || rate === 0n)) {
    console.error("❌ Error: set both RATE_LIMIT_CAPACITY and RATE_LIMIT_RATE, or neither.");
    process.exit(1);
  }

  // Inbound is sized against the REMOTE side's outbound, which we cannot read from here, so we
  // assume the lane is configured symmetrically and add headroom. Equal buckets leave no room
  // for the far side batching a little differently, and a tripped inbound bucket stalls delivery
  // of messages that have already burned on the source chain.
  const HEADROOM_NUM = 11n;
  const HEADROOM_DEN = 10n;
  const withHeadroom = (v: bigint) => (v * HEADROOM_NUM + HEADROOM_DEN - 1n) / HEADROOM_DEN;
  const inboundCapacity = BigInt(
    process.env.RATE_LIMIT_INBOUND_CAPACITY || withHeadroom(capacity).toString()
  );
  const inboundRate = BigInt(process.env.RATE_LIMIT_INBOUND_RATE || withHeadroom(rate).toString());

  const outboundConfig = { isEnabled: rateLimitEnabled, capacity, rate };
  const inboundConfig = {
    isEnabled: rateLimitEnabled,
    capacity: inboundCapacity,
    rate: inboundRate,
  };

  console.log("Lane configuration:");
  console.log("  Local pool:   ", localPoolInfo.address);
  console.log("  Remote pool:  ", remotePoolInfo.address);
  console.log("  Remote token: ", remotePoolInfo.vaultAddress);
  console.log(
    "  Out limits:   ",
    rateLimitEnabled ? `capacity=${capacity} rate=${rate}/s` : "disabled"
  );
  console.log(
    "  In limits:    ",
    rateLimitEnabled ? `capacity=${inboundCapacity} rate=${inboundRate}/s` : "disabled"
  );
  console.log();

  if (!rateLimitEnabled) {
    console.log("⚠️  Rate limiting is DISABLED. Fine for a rehearsal; decide the numbers");
    console.log("    deliberately before mainnet — CCIP applies no limits of its own.\n");
  }

  const alreadySupported = await pool.isSupportedChain(remote.chainSelector);
  const recreate = process.env.LANE_RECREATE === "true";

  let receipt;

  if (!alreadySupported) {
    // ---- new lane: applyChainUpdates is the only call that can create one ----------
    const chainUpdate = {
      remoteChainSelector: remote.chainSelector,
      remotePoolAddresses: [remotePoolEncoded],
      remoteTokenAddress: remoteTokenEncoded,
      outboundRateLimiterConfig: outboundConfig,
      inboundRateLimiterConfig: inboundConfig,
    };
    const tx = await pool.applyChainUpdates([], [chainUpdate]);
    receipt = await tx.wait();
    console.log("✅ Lane added — applyChainUpdates confirmed in block", receipt?.blockNumber);
  } else if (recreate) {
    // ---- explicit, destructive re-create -------------------------------------------
    const storedTokenNow = await pool.getRemoteToken(remote.chainSelector);
    console.log("⚠️  LANE_RECREATE=true — removing and re-adding the lane.");
    console.log("    This DELETES, for this chain selector:");
    console.log("      • every registered remote pool (not just the one below)");
    console.log("      • both fast-finality rate-limit configs");
    console.log("    and refills the rate-limit buckets to full capacity.");
    console.log("    Current remote token:", storedTokenNow);
    console.log("    New remote token:    ", remoteTokenEncoded, "\n");

    const chainUpdate = {
      remoteChainSelector: remote.chainSelector,
      remotePoolAddresses: [remotePoolEncoded],
      remoteTokenAddress: remoteTokenEncoded,
      outboundRateLimiterConfig: outboundConfig,
      inboundRateLimiterConfig: inboundConfig,
    };
    const tx = await pool.applyChainUpdates([remote.chainSelector], [chainUpdate]);
    receipt = await tx.wait();
    console.log("✅ Lane re-created in block", receipt?.blockNumber);
    console.log("⚠️  Re-apply any fast-finality limits now — they were deleted.");
  } else {
    // ---- existing lane: update in place --------------------------------------------
    // Removing the chain to re-add it would wipe the remote-pool set and both FTF rate-limit
    // configs, and refill the buckets. Everything that can change without that is changed with
    // the call meant for it.
    console.log("ℹ️  Lane already configured — updating it in place.\n");

    const storedToken = await pool.getRemoteToken(remote.chainSelector);
    if (storedToken.toLowerCase() !== remoteTokenEncoded.toLowerCase()) {
      console.error("❌ Error: the lane's remote TOKEN differs from the deployment file.");
      console.error("   on-chain:", storedToken);
      console.error("   expected:", remoteTokenEncoded);
      console.error("   Only applyChainUpdates can change a remote token, and it does so by");
      console.error("   removing the chain — which also deletes every remote pool and both");
      console.error("   fast-finality rate-limit configs for this lane.");
      console.error("   If that is genuinely what you want, re-run with LANE_RECREATE=true and");
      console.error("   re-apply the FTF limits afterwards.");
      process.exit(1);
    }

    const poolRegistered = await pool.isRemotePool(remote.chainSelector, remotePoolEncoded);
    if (!poolRegistered) {
      console.log("  Registering remote pool:", remotePoolInfo.address);
      console.log("  (added, not replaced — in-flight messages from an older pool stay valid)");
      const txPool = await pool.addRemotePool(remote.chainSelector, remotePoolEncoded);
      receipt = await txPool.wait();
      console.log("  ✅ addRemotePool confirmed in block", receipt?.blockNumber);
    } else {
      console.log("  Remote pool already registered — nothing to add.");
    }

    // setRateLimitConfig goes through RateLimiter._setTokenBucketConfig, which assigns
    // `tokens = capacity` unconditionally. Writing the limits a lane already has would therefore
    // refill an exhausted bucket and permit another full burst — the same refill this script
    // avoids by not re-creating the lane. So compare first and only write on a real change.
    const sameBucket = (b: any, c: { isEnabled: boolean; capacity: bigint; rate: bigint }) =>
      b.isEnabled === c.isEnabled && b.capacity === c.capacity && b.rate === c.rate;

    const [curOut, curIn] = await pool.getCurrentRateLimiterState(remote.chainSelector, false);
    if (sameBucket(curOut, outboundConfig) && sameBucket(curIn, inboundConfig)) {
      console.log("  Rate limits already match — skipping setRateLimitConfig.");
      console.log("     Writing them would refill both buckets to full capacity.");
    } else {
      console.log("  Setting rate limits (default finality)...");
      console.log("     ⚠️  this refills BOTH buckets to full capacity — in-flight throttling");
      console.log("         is reset, so a burst can immediately follow this transaction.");
      const txLimits = await pool.setRateLimitConfig([
        {
          remoteChainSelector: remote.chainSelector,
          fastFinality: false,
          outboundRateLimiterConfig: outboundConfig,
          inboundRateLimiterConfig: inboundConfig,
        },
      ]);
      receipt = await txLimits.wait();
      console.log("  ✅ setRateLimitConfig confirmed in block", receipt?.blockNumber);
    }
    console.log("     Fast-finality limits are a separate config and were left untouched.");
  }

  // ---- verify ---------------------------------------------------------------------
  // tx.wait() only proves the transaction was mined on the node that answered. Behind a load
  // balancer the next read can hit a node that has not caught up and report the lane as
  // unconfigured when it is fine, so poll until the state is visible before judging.
  let supported = false;
  for (let i = 0; i < 20; i++) {
    supported = await pool.isSupportedChain(remote.chainSelector);
    if (supported) break;
    if (i === 0) console.log("  ⏳ waiting for the lane to be visible on the RPC...");
    await new Promise((r) => setTimeout(r, 3000));
  }
  const [storedToken, isRemote] = await Promise.all([
    pool.getRemoteToken(remote.chainSelector),
    pool.isRemotePool(remote.chainSelector, remotePoolEncoded),
  ]);
  console.log("\n📊 Verification:");
  console.log("  isSupportedChain:", supported);
  console.log(
    "  remote token:    ",
    storedToken === remoteTokenEncoded ? "✅ matches" : "❌ MISMATCH"
  );
  console.log("  remote pool:     ", isRemote ? "✅ registered" : "❌ NOT registered");

  localPoolInfo.lanes = localPoolInfo.lanes || {};
  localPoolInfo.lanes[remote.chainSelector.toString()] = {
    remoteNetwork: remote.network,
    remoteChainSelector: remote.chainSelector.toString(),
    remotePool: remotePoolInfo.address,
    remoteToken: remotePoolInfo.vaultAddress,
    rateLimits: {
      enabled: rateLimitEnabled,
      outbound: { capacity: capacity.toString(), rate: rate.toString() },
      inbound: { capacity: inboundCapacity.toString(), rate: inboundRate.toString() },
    },
    configuredAt: new Date().toISOString(),
    txHash: receipt?.hash,
    blockNumber: receipt?.blockNumber,
  };
  fs.writeFileSync(localFile, JSON.stringify(localInfo, null, 2) + "\n");
  console.log("\n✅ Lane recorded in", localFile);

  console.log("\n💡 Next: run the mirror of this on the remote chain, if you have not already:");
  console.log(
    `   VAULT_KEY=${vaultKey} yarn ccip:apply-chain-updates --network ${remote.network}\n`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
