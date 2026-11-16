import { ethers } from "hardhat";
import * as fs from "fs";

type VaultDeploymentRecord = {
  proxyAddress?: string;
  name?: string;
  admin?: string;
  protocolConfig?: string;
  [key: string]: unknown;
};

type DeploymentInfo = {
  contracts?: {
    protocolConfig?: { proxyAddress?: string };
    vaults?: Record<string, VaultDeploymentRecord>;
    atomicLiquidityVaults?: Record<string, VaultDeploymentRecord>;
  };
};

/** 1e18 == 100% (and 1e18 == 1x for multipliers). Mirrors AtomicLiquidityLib.PERCENT_MAX. */
const PERCENT_MAX = 10n ** 18n;
/** AtomicLiquidityLib.MAX_FEE_MULTIPLIER — 100x. */
const MAX_FEE_MULTIPLIER = 100n * PERCENT_MAX;
/** AtomicLiquidityLib.MAX_FEE_MULTIPLIER_TIERS. */
const MAX_FEE_MULTIPLIER_TIERS = 20;

type Tier = {
  /** Utilization threshold, WAD. */
  threshold: bigint;
  /** Effective fee at/above the threshold, WAD, as the operator stated it. */
  effectiveFee: bigint;
  /** Derived `effectiveFee / baseFee`, WAD. What the contract actually stores. */
  multiplier: bigint;
  /** Human echo of the input, for logs. */
  label: string;
};

/**
 * Writes an EmberShare fee-multiplier curve one tier at a time, through
 * EmberProtocolConfig.updateVaultEmberShareFeeMultiplierTier.
 *
 * The curve is expressed the way it gets discussed — "0.5% from 50% utilization" — and the
 * script derives the multiplier the contract actually stores (`effectiveFee / feePercentage`),
 * refusing anything that isn't exactly representable against the stored base fee.
 *
 * Usage:
 *   ALV_KEY=<key> SHARE_KEY=<key> CURVE="50:0.5,80:1" \
 *     yarn interact:set-atomic-ember-share-fee-curve --network <NETWORK>
 *
 * Nothing is sent unless EXECUTE=true.
 *
 * Environment Variables:
 *   ALV_KEY       - atomicLiquidityVaults key in the deployment JSON. Required unless
 *                   ALV_ADDRESS is set; never inferred.
 *   ALV_ADDRESS   - Bypass the deployment JSON and target this address directly.
 *   SHARE_KEY     - vaults key of the source EmberVault whose curve is being set.
 *   SHARE_ADDRESS - Bypass the deployment JSON and use this share address.
 *   CURVE         - Comma-separated `utilizationPct:effectiveFeePct` pairs, e.g.
 *                   "50:0.5,80:1" = 0.5% from 50% utilization, 1% from 80%. Below the
 *                   lowest threshold the base `feePercentage` applies unscaled.
 *   REMOVE        - Comma-separated utilization thresholds to delete, e.g. "80".
 *                   Applied after CURVE. Reverts TierNotFound if a threshold is absent.
 *   EXECUTE       - "true" to actually send the transactions. Default dry run.
 *
 * Notes:
 * - The share must already be whitelisted: the tier setter reads `feePercentage` and
 *   `holdbackPercentage` out of the stored config, so run
 *   `interact:set-atomic-ember-share-whitelist` first.
 * - One transaction PER TIER — this is not a batch call. A partial failure leaves a partial
 *   curve, so the run reports exactly which tiers landed.
 * - The contract enforces: multiplier in [1x, 100x], effective fee < 100%,
 *   effective + holdback <= 100%, curve length <= 20, and multipliers non-decreasing with
 *   ascending thresholds. All are checked here first.
 * - The curve is preserved across `setEmberShareWhitelist` calls, so re-running the whitelist
 *   setter will NOT wipe it — but raising the base fee or holdback later can be rejected by
 *   the top tier's revalidation.
 */
async function main() {
  console.log("\n📈 Setting Atomic EmberShare fee-multiplier curve...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8")) as DeploymentInfo;

  // ---- resolve the atomic vault (never inferred) ----
  const atomicVaults = deploymentInfo.contracts?.atomicLiquidityVaults ?? {};
  let alvAddress = process.env.ALV_ADDRESS?.trim();
  let alvRecord: VaultDeploymentRecord | undefined;
  if (!alvAddress) {
    const alvKeys = Object.keys(atomicVaults);
    const alvKey = process.env.ALV_KEY?.trim();
    if (!alvKey) {
      console.error("❌ Error: set ALV_KEY (or ALV_ADDRESS) — the target vault is never inferred.");
      console.log("Atomic vaults in this deployment:", alvKeys.join(", ") || "(none)");
      process.exit(1);
    }
    alvRecord = atomicVaults[alvKey];
    if (!alvRecord?.proxyAddress) {
      console.error(`❌ Error: atomic vault '${alvKey}' not found (or has no proxyAddress).`);
      console.log("Available:", alvKeys.join(", ") || "(none)");
      process.exit(1);
    }
    alvAddress = alvRecord.proxyAddress;
    console.log(`Atomic Vault: ${alvKey} -> ${alvAddress}`);
  } else {
    console.log("Atomic Vault:", alvAddress, "(from ALV_ADDRESS)");
  }

  // ---- resolve the source share (never inferred) ----
  let shareAddress = process.env.SHARE_ADDRESS?.trim();
  if (!shareAddress) {
    const shareKey = process.env.SHARE_KEY?.trim();
    if (!shareKey) {
      console.error("❌ Error: set SHARE_KEY (or SHARE_ADDRESS).");
      process.exit(1);
    }
    const shareRecord = deploymentInfo.contracts?.vaults?.[shareKey];
    if (!shareRecord?.proxyAddress) {
      console.error(`❌ Error: vault '${shareKey}' not found (or has no proxyAddress).`);
      console.log("Available:", Object.keys(deploymentInfo.contracts?.vaults ?? {}).join(", "));
      process.exit(1);
    }
    shareAddress = shareRecord.proxyAddress;
    console.log(`Source Share: ${shareKey} (${shareRecord.name ?? "?"}) -> ${shareAddress}`);
  } else {
    console.log("Source Share:", shareAddress, "(from SHARE_ADDRESS)");
  }

  const execute = process.env.EXECUTE?.toLowerCase() === "true";
  const pct = (wad: bigint) => `${ethers.formatUnits(wad, 16)}%`;
  const mult = (wad: bigint) => `${ethers.formatUnits(wad, 18)}x`;

  // ---- stored config: the base fee the multipliers are relative to ----
  const alv = await ethers.getContractAt("AtomicLiquidity", alvAddress);
  const onChainProtocolConfig: string = await alv.protocolConfig();
  const onChainAdmin: string = (await alv.roles()).admin;
  const stored = await alv.emberShareConfigs(shareAddress);
  const baseFee: bigint = stored.feePercentage;
  const holdback: bigint = stored.holdbackPercentage;

  console.log("\n" + "=".repeat(70));
  console.log("📋 Stored config for this share");
  console.log("=".repeat(70));
  console.log("  whitelisted             :", stored.whitelisted);
  console.log("  feePercentage (base)    :", baseFee.toString(), `(${pct(baseFee)})`);
  console.log("  holdbackPercentage      :", holdback.toString(), `(${pct(holdback)})`);
  console.log(
    "  maxUtilizationPercentage:",
    stored.maxUtilizationPercentage.toString(),
    `(${pct(stored.maxUtilizationPercentage)})`
  );
  console.log("  protocolConfig          :", onChainProtocolConfig);
  console.log("  admin                   :", onChainAdmin);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (signer.address.toLowerCase() !== onChainAdmin.toLowerCase()) {
    errors.push(
      `Signer ${signer.address} is not the vault admin ${onChainAdmin}. Only the admin can set tiers.`
    );
  }
  if (!stored.whitelisted) {
    errors.push(
      "Share is not whitelisted — run interact:set-atomic-ember-share-whitelist first, the tier setter reads the base fee out of that config."
    );
  }
  if (baseFee === 0n) {
    errors.push(
      "Stored feePercentage is 0 — every multiplier resolves to a 0 fee, so a curve is meaningless."
    );
  }

  // ---- parse CURVE into tiers, deriving multipliers off the stored base ----
  const curveRaw = process.env.CURVE?.trim() ?? "";
  const removeRaw = process.env.REMOVE?.trim() ?? "";
  if (!curveRaw && !removeRaw) {
    console.error("❌ Error: set CURVE (and/or REMOVE). Nothing to do.");
    process.exit(1);
  }

  const parsePct = (label: string, raw: string): bigint => {
    try {
      return ethers.parseUnits(raw.trim(), 16);
    } catch {
      console.error(`❌ Error: '${raw}' in ${label} is not a number.`);
      process.exit(1);
    }
  };

  const tiers: Tier[] = [];
  if (curveRaw) {
    for (const pair of curveRaw.split(",")) {
      const [thresholdRaw, feeRaw] = pair.split(":");
      if (thresholdRaw === undefined || feeRaw === undefined) {
        console.error(
          `❌ Error: CURVE entry '${pair}' is not 'utilizationPct:effectiveFeePct' (e.g. 50:0.5).`
        );
        process.exit(1);
      }
      const threshold = parsePct("CURVE", thresholdRaw);
      const effectiveFee = parsePct("CURVE", feeRaw);
      if (baseFee === 0n) continue; // already an error; avoid dividing by zero
      // The contract stores a multiplier and computes base * multiplier / 1e18 at swap time.
      // Derive it, then require the round-trip to be exact — a curve that silently lands on
      // 0.4999% because the base doesn't divide cleanly is not what anyone asked for.
      const multiplier = (effectiveFee * PERCENT_MAX) / baseFee;
      const roundTrip = (baseFee * multiplier) / PERCENT_MAX;
      if (roundTrip !== effectiveFee) {
        errors.push(
          `CURVE ${thresholdRaw.trim()}:${feeRaw.trim()} — ${pct(effectiveFee)} is not exactly representable against a ${pct(baseFee)} base fee (nearest is ${pct(roundTrip)}). Adjust the base fee or the tier.`
        );
      }
      tiers.push({
        threshold,
        effectiveFee,
        multiplier,
        label: `${thresholdRaw.trim()}% -> ${feeRaw.trim()}%`,
      });
    }
  }

  const removals = removeRaw
    ? removeRaw.split(",").map((raw) => ({ threshold: parsePct("REMOVE", raw), label: raw.trim() }))
    : [];

  // ---- mirror every contract guard ----
  for (const tier of tiers) {
    if (tier.threshold > PERCENT_MAX) {
      errors.push(`Tier ${tier.label}: threshold above 100%.`);
    }
    if (tier.multiplier < PERCENT_MAX) {
      errors.push(
        `Tier ${tier.label}: multiplier ${mult(tier.multiplier)} is below 1x — a tier can never discount the base fee. Lower the base fee instead.`
      );
    }
    if (tier.multiplier > MAX_FEE_MULTIPLIER) {
      errors.push(`Tier ${tier.label}: multiplier ${mult(tier.multiplier)} exceeds the 100x cap.`);
    }
    if (tier.effectiveFee >= PERCENT_MAX) {
      errors.push(`Tier ${tier.label}: effective fee must be strictly below 100%.`);
    }
    if (tier.effectiveFee + holdback > PERCENT_MAX) {
      errors.push(
        `Tier ${tier.label}: effective fee ${pct(tier.effectiveFee)} + holdback ${pct(holdback)} exceeds 100% — swaps at this utilization would revert.`
      );
    }
  }

  const sorted = [...tiers].sort((a, b) => (a.threshold < b.threshold ? -1 : 1));
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].multiplier < sorted[index - 1].multiplier) {
      errors.push(
        `Curve is not monotonic: ${sorted[index].label} charges less than ${sorted[index - 1].label}. Higher utilization must not be cheaper.`
      );
    }
    if (sorted[index].threshold === sorted[index - 1].threshold) {
      errors.push(`Duplicate threshold ${pct(sorted[index].threshold)} in CURVE.`);
    }
  }
  if (tiers.length > MAX_FEE_MULTIPLIER_TIERS) {
    errors.push(
      `CURVE has ${tiers.length} tiers; the contract caps the curve at ${MAX_FEE_MULTIPLIER_TIERS}.`
    );
  }

  // The utilization cap truncates the curve: tiers above it can never be reached.
  const maxUtilization: bigint = stored.maxUtilizationPercentage;
  for (const tier of sorted) {
    if (maxUtilization > 0n && tier.threshold >= maxUtilization) {
      warnings.push(
        `Tier at ${pct(tier.threshold)} is at or above maxUtilizationPercentage (${pct(maxUtilization)}) — swaps revert before reaching it, so this tier is unreachable.`
      );
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("📈 Curve to write");
  console.log("=".repeat(70));
  console.log(
    `  below ${sorted.length > 0 ? pct(sorted[0].threshold) : "any threshold"}: ${pct(baseFee)} (base, 1x — implicit, not a tier)`
  );
  for (const tier of sorted) {
    console.log(
      `  from ${pct(tier.threshold).padStart(7)} : ${pct(tier.effectiveFee).padStart(7)}  = base x ${mult(tier.multiplier)}  [threshold=${tier.threshold} multiplier=${tier.multiplier}]`
    );
  }
  for (const removal of removals) {
    console.log(`  remove tier at ${removal.label}% [threshold=${removal.threshold}]`);
  }

  for (const warning of warnings) console.log("⚠️ ", warning);
  if (errors.length > 0) {
    console.error("\n❌ Pre-flight failed:");
    for (const error of errors) console.error("  -", error);
    process.exit(1);
  }

  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", onChainProtocolConfig);

  type Operation = { label: string; threshold: bigint; multiplier: bigint; remove: boolean };
  const operations: Operation[] = [
    ...sorted.map((tier) => ({
      label: `set ${tier.label}`,
      threshold: tier.threshold,
      multiplier: tier.multiplier,
      remove: false,
    })),
    ...removals.map((removal) => ({
      label: `remove ${removal.label}%`,
      threshold: removal.threshold,
      multiplier: 0n,
      remove: true,
    })),
  ];

  console.log("\n" + "=".repeat(70));
  console.log(
    `🧮 Calldata (${operations.length} transaction${operations.length === 1 ? "" : "s"}, one per tier)`
  );
  console.log("=".repeat(70));
  console.log("to  :", onChainProtocolConfig);
  for (const operation of operations) {
    console.log(`\n${operation.label}`);
    console.log(
      "data:",
      protocolConfig.interface.encodeFunctionData("updateVaultEmberShareFeeMultiplierTier", [
        alvAddress,
        shareAddress,
        operation.threshold,
        operation.multiplier,
        operation.remove,
      ])
    );
  }

  console.log("\n🧪 Simulating each tier (staticCall)...");
  for (const operation of operations) {
    // Simulated against current state, so a later tier is not simulated against the earlier
    // one having landed. Monotonicity across the batch is checked above instead.
    await protocolConfig.updateVaultEmberShareFeeMultiplierTier.staticCall(
      alvAddress,
      shareAddress,
      operation.threshold,
      operation.multiplier,
      operation.remove
    );
    console.log(`  ✅ ${operation.label}`);
  }

  if (!execute) {
    console.log("\nℹ️ Dry run only. Re-run with EXECUTE=true to send the transactions.");
    return;
  }

  console.log("\n🚀 Sending transactions (ascending threshold, to keep the curve monotonic)...");
  const landed: string[] = [];
  for (const operation of operations) {
    try {
      const tx = await protocolConfig.updateVaultEmberShareFeeMultiplierTier(
        alvAddress,
        shareAddress,
        operation.threshold,
        operation.multiplier,
        operation.remove
      );
      console.log(`  ${operation.label} -> ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`     confirmed in block ${receipt?.blockNumber}`);
      landed.push(operation.label);
    } catch (error: any) {
      console.error(`  ❌ ${operation.label} failed: ${error.message}`);
      console.error(
        `\n⚠️  PARTIAL CURVE ON CHAIN. Landed: ${landed.join(", ") || "(none)"}. Re-run after fixing — the setter is an upsert, so replaying the whole CURVE is safe.`
      );
      process.exit(1);
    }
  }

  console.log(`\n✅ ${landed.length} tier operation(s) applied.`);
  console.log(
    "ℹ️ The curve has no on-chain getter by design — reconstruct it from EmberShareFeeMultiplierTierUpdated events."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
