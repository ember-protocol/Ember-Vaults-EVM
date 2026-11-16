import { ethers } from "hardhat";
import * as fs from "fs";

type VaultDeploymentRecord = {
  proxyAddress?: string;
  name?: string;
  admin?: string;
  protocolConfig?: string;
  collateralToken?: string;
  [key: string]: unknown;
};

type DeploymentInfo = {
  contracts?: {
    protocolConfig?: { proxyAddress?: string };
    vaults?: Record<string, VaultDeploymentRecord>;
    atomicLiquidityVaults?: Record<string, VaultDeploymentRecord>;
  };
};

/** 1e18 == 100%. Mirrors AtomicLiquidityLib.PERCENT_MAX. */
const PERCENT_MAX = 10n ** 18n;

/**
 * Minimal ABIs, deliberately hand-written rather than resolved by artifact name:
 * `IERC20Metadata` is ambiguous across the OpenZeppelin tree (HH701) and the share is
 * only ever read through these four functions.
 */
const ERC4626_METADATA_ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

/** The swap path calls this on the source share; probed so a missing impl is caught early. */
const PAUSE_STATUS_ABI = ["function pauseStatus() view returns (bool, bool, bool)"];

/**
 * Whitelists (or re-configures, or de-lists) a source EmberVault share on an Atomic
 * Liquidity Vault, routed through EmberProtocolConfig.setVaultEmberShareWhitelist.
 *
 * Usage:
 *   ALV_KEY=<key> SHARE_KEY=<key> FEE_PCT=0.5 HOLDBACK_PCT=10 \
 *   MAX_CAPACITY_PCT=<pct> MAX_UTILIZATION_PCT=<pct> \
 *     yarn interact:set-atomic-ember-share-whitelist --network <NETWORK>
 *
 * Nothing is sent unless EXECUTE=true. The default run simulates the call with
 * staticCall, prints the resolved arguments and the encoded calldata, and stops —
 * these percentages gate real money, so a dry run is the default, not the opt-in.
 *
 * Both the vault being written to and the share being whitelisted come from the
 * environment and from nowhere else — no inference, no default.
 *
 * Environment Variables:
 *   ALV_KEY              - atomicLiquidityVaults key in the deployment JSON. Required unless
 *                          ALV_ADDRESS is set; never inferred, even with one atomic vault.
 *   ALV_ADDRESS          - Bypass the deployment JSON and target this address directly.
 *   SHARE_KEY            - vaults key of the source EmberVault to whitelist (e.g. emberEarn)
 *   SHARE_ADDRESS        - Bypass the deployment JSON and use this share address.
 *   WHITELISTED          - "false" to de-list. Default "true".
 *   FEE_PCT              - Base swap fee, in percent (0.5 => 0.5% => 5e15). Required.
 *   HOLDBACK_PCT         - Holdback share of gross, in percent (10 => 10% => 1e17). Required.
 *   MAX_CAPACITY_PCT     - Per-24h epoch cap, as a percent of the SOURCE vault's
 *                          totalAssets(). Required — 0 caps every swap at zero.
 *   MAX_UTILIZATION_PCT  - Concentration cap: post-swap held value of this share as a
 *                          percent of the ALV's totalAssets(). Required — 0 reverts
 *                          every swap once the ALV holds any assets.
 *   MIN_SWAP_GROSS       - Dust floor per swap, in COLLATERAL units (human decimal, e.g.
 *                          "1" => 1 USDC). "0" disables. Default "0".
 *   MAX_HELD_VALUE_ABS   - Absolute ceiling on held value, in COLLATERAL units (human
 *                          decimal). "0" disables. Default "0".
 *   EXECUTE              - "true" to actually send the transaction. Default dry run.
 *
 * Notes:
 * - `setEmberShareWhitelist` is `onlyProtocolConfig onlyAdmin(caller)`, so the call must
 *   go through the vault's own protocolConfig and the signer must BE the vault admin.
 *   Both are checked on-chain before sending.
 * - The contract enforces `IERC4626(share).asset() == collateralToken` on whitelist-enable.
 *   That check is mirrored here so a wrong share fails with a readable message instead of
 *   an `InvalidStrategy` revert.
 * - The swap path also calls `pauseStatus()` on the share. A share that doesn't implement
 *   it whitelists fine but reverts on every swap, so it is probed here too.
 * - `feeMultiplierCurve` is deliberately NOT touched by this setter — re-running it
 *   preserves any tuned curve. Use the dedicated tier setter for that.
 * - Percentages are 1e18-scaled WAD fractions, NOT basis points: 1e18 = 100%,
 *   1e16 = 1%, 5e15 = 0.5%.
 */
async function main() {
  console.log("\n🔗 Setting Atomic EmberShare whitelist...\n");

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

  // ---- resolve the atomic vault ----
  const atomicVaults = deploymentInfo.contracts?.atomicLiquidityVaults ?? {};
  let alvAddress = process.env.ALV_ADDRESS?.trim();
  let alvRecord: VaultDeploymentRecord | undefined;

  if (!alvAddress) {
    const alvKeys = Object.keys(atomicVaults);
    // Never inferred, not even when the network has exactly one atomic vault: the target
    // of a whitelist write is stated explicitly or the script refuses to run.
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

  // ---- resolve the source share ----
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

  const whitelisted = (process.env.WHITELISTED ?? "true").toLowerCase() !== "false";
  const execute = process.env.EXECUTE?.toLowerCase() === "true";

  // ---- percentages: percent in, WAD out (1% == 1e16) ----
  const pctToWad = (name: string, raw: string | undefined): bigint => {
    if (raw === undefined || raw.trim() === "") {
      console.error(`❌ Error: ${name} is required (percent, e.g. 0.5 for 0.5%).`);
      process.exit(1);
    }
    let wad: bigint;
    try {
      wad = ethers.parseUnits(raw.trim(), 16);
    } catch {
      console.error(`❌ Error: ${name}='${raw}' is not a number.`);
      process.exit(1);
    }
    if (wad < 0n) {
      console.error(`❌ Error: ${name} cannot be negative.`);
      process.exit(1);
    }
    return wad;
  };

  const feePercentage = pctToWad("FEE_PCT", process.env.FEE_PCT);
  const holdbackPercentage = pctToWad("HOLDBACK_PCT", process.env.HOLDBACK_PCT);
  const maxCapacityPercentage = pctToWad("MAX_CAPACITY_PCT", process.env.MAX_CAPACITY_PCT);
  const maxUtilizationPercentage = pctToWad("MAX_UTILIZATION_PCT", process.env.MAX_UTILIZATION_PCT);

  // ---- on-chain reads: vault wiring + guards the contract will apply ----
  const alv = await ethers.getContractAt("AtomicLiquidity", alvAddress);
  const collateralToken: string = await alv.collateralToken();
  const onChainProtocolConfig: string = await alv.protocolConfig();
  const roles = await alv.roles();
  const onChainAdmin: string = roles.admin;
  const alvTotalAssets: bigint = await alv.totalAssets();

  const collateral = new ethers.Contract(collateralToken, ERC4626_METADATA_ABI, signer);
  const collateralDecimals = Number(await collateral.decimals());
  const collateralSymbol: string = await collateral.symbol();

  const parseCollateral = (name: string, raw: string | undefined): bigint => {
    const value = (raw ?? "0").trim() || "0";
    try {
      return ethers.parseUnits(value, collateralDecimals);
    } catch {
      console.error(`❌ Error: ${name}='${raw}' is not a valid ${collateralSymbol} amount.`);
      process.exit(1);
    }
  };
  const minSwapGross = parseCollateral("MIN_SWAP_GROSS", process.env.MIN_SWAP_GROSS);
  const maxHeldValueAbsolute = parseCollateral(
    "MAX_HELD_VALUE_ABS",
    process.env.MAX_HELD_VALUE_ABS
  );

  const share = new ethers.Contract(shareAddress, ERC4626_METADATA_ABI, signer);
  let shareAsset = "";
  let shareTotalAssets = 0n;
  let shareSymbol = "?";
  try {
    shareAsset = await share.asset();
    shareTotalAssets = await share.totalAssets();
    shareSymbol = await share.symbol();
  } catch (error: any) {
    console.error("❌ Error: could not read the share as an ERC-4626:", error.message);
    process.exit(1);
  }

  const fmt = (value: bigint) => ethers.formatUnits(value, collateralDecimals);
  const pct = (wad: bigint) => `${ethers.formatUnits(wad, 16)}%`;

  console.log("\n" + "=".repeat(70));
  console.log("📋 Resolved configuration");
  console.log("=".repeat(70));
  console.log("Atomic Vault        :", alvAddress);
  console.log(
    "  collateralToken   :",
    collateralToken,
    `(${collateralSymbol}, ${collateralDecimals}dp)`
  );
  console.log("  protocolConfig    :", onChainProtocolConfig);
  console.log("  admin             :", onChainAdmin);
  console.log("  totalAssets       :", fmt(alvTotalAssets), collateralSymbol);
  console.log("  strategy          :", await alv.strategy());
  console.log("Source Share        :", shareAddress, `(${shareSymbol})`);
  console.log("  asset()           :", shareAsset);
  console.log("  totalAssets       :", fmt(shareTotalAssets), collateralSymbol);
  console.log("\nwhitelisted             :", whitelisted);
  console.log("feePercentage           :", feePercentage.toString(), `(${pct(feePercentage)})`);
  console.log(
    "maxCapacityPercentage   :",
    maxCapacityPercentage.toString(),
    `(${pct(maxCapacityPercentage)})`
  );
  console.log(
    "holdbackPercentage      :",
    holdbackPercentage.toString(),
    `(${pct(holdbackPercentage)})`
  );
  console.log(
    "maxUtilizationPercentage:",
    maxUtilizationPercentage.toString(),
    `(${pct(maxUtilizationPercentage)})`
  );
  console.log(
    "minSwapGross            :",
    minSwapGross.toString(),
    minSwapGross === 0n ? "(disabled)" : `(${fmt(minSwapGross)} ${collateralSymbol})`
  );
  console.log(
    "maxHeldValueAbsolute    :",
    maxHeldValueAbsolute.toString(),
    maxHeldValueAbsolute === 0n
      ? "(disabled)"
      : `(${fmt(maxHeldValueAbsolute)} ${collateralSymbol})`
  );

  // ---- pre-flight: everything the contract will revert on, checked readably ----
  const errors: string[] = [];
  const warnings: string[] = [];

  if (signer.address.toLowerCase() !== onChainAdmin.toLowerCase()) {
    errors.push(
      `Signer ${signer.address} is not the vault admin ${onChainAdmin}. Only the admin can set the whitelist.`
    );
  }
  const declaredProtocolConfig =
    alvRecord?.protocolConfig || deploymentInfo.contracts?.protocolConfig?.proxyAddress;
  if (
    declaredProtocolConfig &&
    declaredProtocolConfig.toLowerCase() !== onChainProtocolConfig.toLowerCase()
  ) {
    warnings.push(
      `Deployment JSON says protocolConfig ${declaredProtocolConfig} but the vault reports ${onChainProtocolConfig}. Routing through the vault's own — onlyProtocolConfig checks that one.`
    );
  }
  if (shareAddress.toLowerCase() === alvAddress.toLowerCase()) {
    errors.push("The share cannot be the atomic vault itself (contract reverts InvalidValue).");
  }
  if (whitelisted && shareAsset.toLowerCase() !== collateralToken.toLowerCase()) {
    errors.push(
      `Share asset() ${shareAsset} != vault collateralToken ${collateralToken}. Whitelist-enable reverts InvalidStrategy.`
    );
  }
  if (feePercentage >= PERCENT_MAX) errors.push("FEE_PCT must be strictly below 100%.");
  if (holdbackPercentage > PERCENT_MAX) errors.push("HOLDBACK_PCT cannot exceed 100%.");
  if (maxCapacityPercentage > PERCENT_MAX) errors.push("MAX_CAPACITY_PCT cannot exceed 100%.");
  if (maxUtilizationPercentage > PERCENT_MAX)
    errors.push("MAX_UTILIZATION_PCT cannot exceed 100%.");
  if (feePercentage + holdbackPercentage > PERCENT_MAX) {
    errors.push("FEE_PCT + HOLDBACK_PCT cannot exceed 100% (net payout would underflow).");
  }

  if (whitelisted) {
    if (maxCapacityPercentage === 0n) {
      warnings.push(
        "MAX_CAPACITY_PCT is 0 — the per-epoch cap resolves to 0, so EVERY swap reverts EmberShareCapExceeded."
      );
    }
    if (maxUtilizationPercentage === 0n) {
      warnings.push(
        "MAX_UTILIZATION_PCT is 0 — every swap reverts EmberShareUtilizationCapExceeded as soon as the ALV holds any assets."
      );
    }
    try {
      await new ethers.Contract(shareAddress, PAUSE_STATUS_ABI, signer).pauseStatus.staticCall();
    } catch {
      warnings.push(
        "Share does not answer pauseStatus() — the swap path calls it, so swaps would revert even though the whitelist write succeeds."
      );
    }
    const epochCap = (shareTotalAssets * maxCapacityPercentage) / PERCENT_MAX;
    console.log(
      `\n💡 Derived per-24h epoch cap: ${fmt(epochCap)} ${collateralSymbol}` +
        ` (${pct(maxCapacityPercentage)} of the source vault's ${fmt(shareTotalAssets)} ${collateralSymbol})`
    );
    if (alvTotalAssets === 0n) {
      warnings.push(
        "ALV totalAssets() is 0 — it cannot pay out a swap yet. Seed the vault (deposit / strategy) before enabling swaps in anger."
      );
    }
  }

  for (const warning of warnings) console.log("⚠️ ", warning);
  if (errors.length > 0) {
    console.error("\n❌ Pre-flight failed:");
    for (const error of errors) console.error("  -", error);
    process.exit(1);
  }

  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", onChainProtocolConfig);
  const args = [
    alvAddress,
    shareAddress,
    whitelisted,
    feePercentage,
    maxCapacityPercentage,
    holdbackPercentage,
    maxUtilizationPercentage,
    minSwapGross,
    maxHeldValueAbsolute,
  ] as const;

  console.log("\n" + "=".repeat(70));
  console.log("🧮 Calldata");
  console.log("=".repeat(70));
  console.log("to  :", onChainProtocolConfig);
  console.log(
    "data:",
    protocolConfig.interface.encodeFunctionData("setVaultEmberShareWhitelist", [...args])
  );

  console.log("\n🧪 Simulating (staticCall)...");
  await protocolConfig.setVaultEmberShareWhitelist.staticCall(...args);
  console.log("✅ Simulation passed.");

  if (!execute) {
    console.log("\nℹ️ Dry run only. Re-run with EXECUTE=true to send the transaction.");
    return;
  }

  console.log("\n🚀 Sending transaction...");
  const tx = await protocolConfig.setVaultEmberShareWhitelist(...args);
  console.log("Transaction hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block:", receipt?.blockNumber);

  const stored = await alv.emberShareConfigs(shareAddress);
  console.log("\n📖 Stored config read back:");
  console.log("  whitelisted             :", stored.whitelisted);
  console.log(
    "  feePercentage           :",
    stored.feePercentage.toString(),
    `(${pct(stored.feePercentage)})`
  );
  console.log(
    "  maxCapacityPercentage   :",
    stored.maxCapacityPercentage.toString(),
    `(${pct(stored.maxCapacityPercentage)})`
  );
  console.log(
    "  holdbackPercentage      :",
    stored.holdbackPercentage.toString(),
    `(${pct(stored.holdbackPercentage)})`
  );
  console.log(
    "  maxUtilizationPercentage:",
    stored.maxUtilizationPercentage.toString(),
    `(${pct(stored.maxUtilizationPercentage)})`
  );
  console.log("  minSwapGross            :", stored.minSwapGross.toString());
  console.log("  maxHeldValueAbsolute    :", stored.maxHeldValueAbsolute.toString());

  if (
    stored.whitelisted !== whitelisted ||
    stored.feePercentage !== feePercentage ||
    stored.maxCapacityPercentage !== maxCapacityPercentage ||
    stored.holdbackPercentage !== holdbackPercentage ||
    stored.maxUtilizationPercentage !== maxUtilizationPercentage ||
    stored.minSwapGross !== minSwapGross ||
    stored.maxHeldValueAbsolute !== maxHeldValueAbsolute
  ) {
    console.error("❌ Read-back does not match the requested configuration.");
    process.exit(1);
  }
  console.log("\n✅ EmberShare whitelist configured.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
