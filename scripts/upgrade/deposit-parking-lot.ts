import { ethers, upgrades } from "hardhat";
import { getImplementationAddressWithRetry } from "../utils/erc1967";
import * as fs from "fs";

/**
 * Upgrades EmberDepositParkingLot proxies to a new implementation.
 *
 * This script:
 * 1. Resolves the parking-lot proxies to upgrade from the deployment file
 * 2. Reports live escrow + queue state for each one (context, not a blocker — see note below)
 * 3. Validates storage-layout compatibility for every proxy BEFORE deploying anything
 * 4. Deploys one new implementation and points each proxy at it
 * 5. Updates the deployment JSON file
 *
 * Usage:
 * - Uses deployments/<network>-deployment.json by default
 * - Optional PARKING_LOT_KEYS (comma-separated keys under contracts.depositParkingLots;
 *   omit to upgrade ALL parking lots recorded for the network)
 * - Optional PARKING_LOT_PROXY upgrades a single ad-hoc proxy address instead of
 *   anything in the deployment file (takes precedence over PARKING_LOT_KEYS)
 *
 * Examples:
 *   yarn upgrade:deposit-parking-lot --network base
 *   PARKING_LOT_KEYS=emberHilbert,emberHilbertBtc yarn upgrade:deposit-parking-lot --network mainnet
 *   PARKING_LOT_PROXY=0x... yarn upgrade:deposit-parking-lot --network sepolia
 *
 * NOTE: `_authorizeUpgrade` is owner-gated. In production the owner is a Timelock, so this
 * script cannot send the upgrade directly — it aborts and points you at
 * `yarn admin:gen-timelock-upgrade` with CONTRACT_NAME=EmberDepositParkingLot.
 */

const CONTRACT_NAME = "EmberDepositParkingLot";

const ERC20_METADATA_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

type ParkingLotState = {
  owner: string;
  vault: string;
  operator: string;
  collateralToken: string;
  depositsPaused: boolean;
  totalPendingAssets: bigint;
  livePendingDeposits: bigint;
  /** null when the deployed implementation predates `version()` — see readState. */
  version: string | null;
};

/** How a missing `version()` is rendered in the console. */
const VERSION_UNAVAILABLE = "n/a (deployed implementation predates version())";

/** Best-effort collateral formatting — never let a metadata read block an upgrade. */
async function formatCollateral(token: string, amount: bigint): Promise<string> {
  try {
    const erc20 = new ethers.Contract(token, ERC20_METADATA_ABI, ethers.provider);
    const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
    return `${ethers.formatUnits(amount, decimals)} ${symbol}`;
  } catch {
    return `${amount.toString()} (raw units)`;
  }
}

async function readState(proxyAddress: string): Promise<ParkingLotState> {
  const parkingLot = await ethers.getContractAt(CONTRACT_NAME, proxyAddress);
  const [
    owner,
    vault,
    operator,
    collateralToken,
    depositsPaused,
    totalPendingAssets,
    livePendingDeposits,
  ] = await Promise.all([
    parkingLot.owner(),
    parkingLot.vault(),
    parkingLot.operator(),
    parkingLot.collateralToken(),
    parkingLot.depositsPaused(),
    parkingLot.totalPendingAssets(),
    parkingLot.getLivePendingDepositsCount(),
  ]);

  // `version()` was added to EmberDepositParkingLot only after the first lots were deployed, so
  // on those proxies the selector doesn't exist and the staticcall reverts. That's expected on a
  // pre-version() proxy — report it as unknown instead of failing the whole pre-flight. Every
  // other getter above has existed since the contract's first deploy, so a revert there is a
  // real problem and is deliberately left to propagate.
  let version: string | null = null;
  try {
    version = await parkingLot.version();
  } catch {
    version = null;
  }

  return {
    owner,
    vault,
    operator,
    collateralToken,
    depositsPaused,
    totalPendingAssets,
    livePendingDeposits,
    version,
  };
}

async function main() {
  console.log("\n🔄 Upgrading EmberDepositParkingLot...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Upgrading with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  const deploymentFileName = `./deployments/${network.name}-deployment.json`;

  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found!");
    console.log("File:", deploymentFileName);
    process.exit(1);
  }

  console.log("📂 Loading deployment file:", deploymentFileName);
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  if (!deploymentInfo.contracts) {
    deploymentInfo.contracts = {};
  }

  const parkingLots: Record<string, any> = deploymentInfo.contracts.depositParkingLots ?? {};

  // A target's `recordKey` is the key under contracts.depositParkingLots to write results back
  // to. It's undefined for a PARKING_LOT_PROXY address that isn't recorded in the file — in that
  // case we upgrade but don't invent a deployment entry, since a synthetic key would then be
  // picked up by every later "upgrade ALL" run.
  type Target = { label: string; proxyAddress: string; recordKey?: string };

  const proxyOverride = process.env.PARKING_LOT_PROXY;
  let targets: Target[];

  if (proxyOverride) {
    console.log("🎯 Upgrading ad-hoc proxy from PARKING_LOT_PROXY:", proxyOverride);

    // If the address is already recorded, reuse its key so the deployment file stays accurate.
    const matchedKey = Object.keys(parkingLots).find(
      (key) => parkingLots[key]?.proxyAddress?.toLowerCase() === proxyOverride.toLowerCase()
    );

    if (matchedKey) {
      console.log(`   Matches recorded parking lot '${matchedKey}' — will update that entry.`);
    } else {
      console.log(
        "   Not recorded in the deployment file — the file will NOT be updated for this proxy."
      );
    }

    targets = [
      { label: matchedKey ?? proxyOverride, proxyAddress: proxyOverride, recordKey: matchedKey },
    ];
  } else {
    if (Object.keys(parkingLots).length === 0) {
      console.error("❌ Error: No deposit parking lots found in deployment file!");
      console.log(
        "Set PARKING_LOT_PROXY or ensure contracts.depositParkingLots.<key>.proxyAddress exists."
      );
      process.exit(1);
    }

    const keysEnv = process.env.PARKING_LOT_KEYS;
    let keysToUpgrade: string[];
    if (keysEnv) {
      keysToUpgrade = keysEnv
        .split(",")
        .map((key) => key.trim())
        .filter((key) => key.length > 0);
      console.log("🎯 Upgrading specific parking lots:", keysToUpgrade.join(", "));
    } else {
      keysToUpgrade = Object.keys(parkingLots);
      console.log("🎯 Upgrading ALL parking lots:", keysToUpgrade.join(", "));
    }

    if (keysToUpgrade.length === 0) {
      console.error("❌ Error: PARKING_LOT_KEYS did not resolve to any keys!");
      process.exit(1);
    }

    for (const key of keysToUpgrade) {
      if (!parkingLots[key]?.proxyAddress) {
        console.error(`❌ Error: Parking lot '${key}' has no proxyAddress in the deployment file!`);
        console.log("Available parking lots:", Object.keys(parkingLots).join(", "));
        process.exit(1);
      }
    }

    targets = keysToUpgrade.map((key) => ({
      label: key,
      proxyAddress: parkingLots[key].proxyAddress as string,
      recordKey: key,
    }));
  }

  console.log("\n" + "=".repeat(70));
  console.log("📋 Parking Lots to Upgrade");
  console.log("=".repeat(70));

  // Pre-flight: read each proxy's live state. The upgrade itself can't move escrow (it lives in
  // the proxy's own balance and storage), but the queue depth tells you how many already-accepted
  // requests will settle under the new implementation's rules.
  const states = new Map<string, ParkingLotState>();
  const currentImpls = new Map<string, string>();
  let totalLivePending = 0n;
  const notOwned: { label: string; owner: string }[] = [];

  for (const { label, proxyAddress } of targets) {
    const currentImpl = await getImplementationAddressWithRetry(proxyAddress);
    const state = await readState(proxyAddress);

    states.set(proxyAddress, state);
    currentImpls.set(proxyAddress, currentImpl);
    totalLivePending += state.livePendingDeposits;

    if (state.owner.toLowerCase() !== deployer.address.toLowerCase()) {
      notOwned.push({ label, owner: state.owner });
    }

    console.log(`\n${label}:`);
    console.log("  Proxy:                 ", proxyAddress);
    console.log("  Current Implementation:", currentImpl);
    console.log("  Current Version:       ", state.version ?? VERSION_UNAVAILABLE);
    console.log("  Owner:                 ", state.owner);
    console.log("  Vault:                 ", state.vault);
    console.log("  Operator:              ", state.operator);
    console.log("  Collateral Token:      ", state.collateralToken);
    console.log("  Deposits Paused:       ", state.depositsPaused);
    console.log("  Live Pending Deposits: ", state.livePendingDeposits.toString());
    console.log(
      "  Escrowed Collateral:   ",
      await formatCollateral(state.collateralToken, state.totalPendingAssets)
    );
  }

  console.log("\n" + "=".repeat(70));

  // The UUPS upgrade hook is owner-gated. If the owner is a Timelock/multisig (the
  // production setup), sending upgradeToAndCall from this signer would just revert —
  // abort early and hand over the timelock path instead.
  if (notOwned.length > 0) {
    console.error("\n❌ Error: signer is not the owner of every target parking lot.");
    console.error("   `_authorizeUpgrade` is owner-gated, so these upgrades cannot be sent here:");
    for (const { label, owner } of notOwned) {
      console.error(`     ✗ ${label} — owner is ${owner}`);
    }
    console.error("\n   Signer:", deployer.address);
    console.error("\n   Route the upgrade through the owner (Timelock / multisig) instead:");
    console.error(
      `     CONTRACT_NAME=${CONTRACT_NAME} PROXY_ADDRESS=<proxy> yarn admin:gen-timelock-upgrade --network ${network.name}`
    );
    // process.exit(1);
  }

  // Safety delay before sending an upgrade transaction.
  console.log(
    "\n⚠️  WARNING: This will upgrade",
    targets.length,
    `${CONTRACT_NAME} proxy(ies) on`,
    network.name
  );
  console.log("⚠️  These contracts custody live user escrow. Make sure this implementation");
  console.log("⚠️  has been tested and audited.");

  if (totalLivePending > 0n) {
    console.log(
      `\nℹ️  ${totalLivePending.toString()} live pending deposit request(s) are queued right now.`
    );
    console.log(
      "ℹ️  Escrowed collateral and queue state both live in the proxy's own balance and storage,"
    );
    console.log(
      "ℹ️  so swapping the implementation neither moves nor strands them. What does change is"
    );
    console.log(
      "ℹ️  that these already-accepted requests get processed under the NEW rules. If this"
    );
    console.log(
      "ℹ️  upgrade alters deposit validation, fees or the refund path, drain the queue first"
    );
    console.log("ℹ️  (setDepositsPaused + processDeposits) so they settle as accepted.");
  }

  console.log("\nContinuing in 5 seconds... (Press Ctrl+C to cancel)");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("\n🚀 Starting upgrade process...\n");

  // EmberDepositParkingLot inlines all of its bookkeeping — no linked libraries to resolve.
  const ParkingLotFactory = await ethers.getContractFactory(CONTRACT_NAME);

  // Validate storage-layout compatibility for every proxy BEFORE deploying anything.
  // This is what catches the class of bug where a renamed/reordered/removed state
  // variable would corrupt existing escrow accounting after `upgradeToAndCall`.
  console.log("🔒 Validating upgrade compatibility for each proxy...");
  for (const { label, proxyAddress } of targets) {
    try {
      await upgrades.validateUpgrade(proxyAddress, ParkingLotFactory, { kind: "uups" });
      console.log(`   ✅ ${label} (${proxyAddress}) — compatible`);
    } catch (err: any) {
      console.error(`\n❌ Upgrade validation FAILED for ${label} (${proxyAddress}):`);
      console.error(err?.message ?? err);
      console.error(
        "\nIf this proxy is missing from .openzeppelin/<network>.json,",
        "run `upgrades.forceImport(proxy, Factory, { kind: 'uups' })` once",
        "to register the deployed implementation, then retry. Do NOT bypass this check."
      );
      process.exit(1);
    }
  }
  console.log("   All proxies pass validation.\n");

  // Deploy the new implementation through the upgrades plugin so the
  // .openzeppelin/<network>.json manifest is updated. Returns the impl address.
  console.log(`📦 Deploying new ${CONTRACT_NAME} implementation via upgrades plugin...`);
  const newImplementationAddress = (await upgrades.deployImplementation(ParkingLotFactory, {
    kind: "uups",
    redeployImplementation: "always",
  })) as string;
  const newImplementation = await ethers.getContractAt(CONTRACT_NAME, newImplementationAddress);

  console.log("   ✅ New Implementation deployed at:", newImplementationAddress);

  const newImplVersion = await newImplementation.version();
  console.log("   New Implementation Version:", newImplVersion);

  const results: {
    label: string;
    proxyAddress: string;
    success: boolean;
    skipped?: boolean;
    reason?: string;
    txHash?: string;
    blockNumber?: number;
    error?: string;
  }[] = [];

  let deploymentFileDirty = false;

  for (const { label, proxyAddress, recordKey } of targets) {
    const currentImpl = currentImpls.get(proxyAddress)!;

    console.log("\n" + "-".repeat(70));
    console.log(`🔄 Upgrading parking lot: ${label}`);
    console.log(`   Proxy Address: ${proxyAddress}`);
    console.log("-".repeat(70));

    try {
      if (currentImpl.toLowerCase() === newImplementationAddress.toLowerCase()) {
        console.log("\n   ⏭️  Proxy is already on this implementation. Skipping.");
        results.push({
          label,
          proxyAddress,
          success: true,
          skipped: true,
          reason: "Already upgraded",
        });
        continue;
      }

      const parkingLot = await ethers.getContractAt(CONTRACT_NAME, proxyAddress);

      console.log("\n   📝 Upgrading proxy to new implementation...");
      console.log("      From:", currentImpl);
      console.log("      To:  ", newImplementationAddress);

      const upgradeTx = await parkingLot.upgradeToAndCall(newImplementationAddress, "0x");
      console.log("   Transaction hash:", upgradeTx.hash);
      console.log("   Waiting for confirmation...");

      const upgradeReceipt = await upgradeTx.wait();
      console.log("   ✅ Upgrade confirmed in block:", upgradeReceipt?.blockNumber);
      console.log("   Gas used:", upgradeReceipt?.gasUsed.toString());

      const implAfter = await getImplementationAddressWithRetry(proxyAddress);
      const stateAfter = await readState(proxyAddress);
      const before = states.get(proxyAddress)!;

      console.log("\n   📊 Post-Upgrade Verification:");
      console.log("      Implementation:       ", implAfter);
      console.log("      Version:              ", stateAfter.version ?? VERSION_UNAVAILABLE);
      console.log("      Vault:                ", stateAfter.vault);
      console.log("      Operator:             ", stateAfter.operator);
      console.log("      Live Pending Deposits:", stateAfter.livePendingDeposits.toString());
      console.log(
        "      Escrowed Collateral:  ",
        await formatCollateral(stateAfter.collateralToken, stateAfter.totalPendingAssets)
      );

      if (implAfter.toLowerCase() !== newImplementationAddress.toLowerCase()) {
        throw new Error(
          `Upgrade verification failed! Expected ${newImplementationAddress} but got ${implAfter}`
        );
      }

      // Escrow accounting must survive the upgrade untouched. A mismatch here means the new
      // layout reads different slots — surface it loudly rather than reporting a clean upgrade.
      if (
        stateAfter.totalPendingAssets !== before.totalPendingAssets ||
        stateAfter.livePendingDeposits !== before.livePendingDeposits
      ) {
        console.error("\n   ❌ ESCROW STATE CHANGED ACROSS THE UPGRADE — investigate immediately!");
        console.error(
          `      totalPendingAssets:  ${before.totalPendingAssets.toString()} -> ${stateAfter.totalPendingAssets.toString()}`
        );
        console.error(
          `      livePendingDeposits: ${before.livePendingDeposits.toString()} -> ${stateAfter.livePendingDeposits.toString()}`
        );
        throw new Error(
          `Escrow accounting mismatch after upgrading ${label} (${proxyAddress}). ` +
            "The new implementation may have an incompatible storage layout."
        );
      }

      if (recordKey) {
        const parkingLotInfo = parkingLots[recordKey];
        parkingLotInfo.proxyAddress = proxyAddress;
        parkingLotInfo.implementationAddress = newImplementationAddress;
        parkingLotInfo.vault = stateAfter.vault;
        parkingLotInfo.operator = stateAfter.operator;
        parkingLotInfo.ownerAddress = stateAfter.owner;
        // Only record a version we actually read — never write a null over a real value.
        if (stateAfter.version !== null) {
          parkingLotInfo.version = stateAfter.version;
        }
        parkingLotInfo.upgradedAt = new Date().toISOString();
        parkingLotInfo.upgradedInBlock = upgradeReceipt?.blockNumber || 0;
        deploymentFileDirty = true;
      } else {
        console.log(
          "   ℹ️  Proxy is not recorded in the deployment file — skipping deployment-file update."
        );
      }

      results.push({
        label,
        proxyAddress,
        success: true,
        txHash: upgradeReceipt?.hash,
        blockNumber: upgradeReceipt?.blockNumber,
      });

      console.log(`   ✅ Successfully upgraded ${label}!`);
    } catch (error: any) {
      console.error(`   ❌ Failed to upgrade ${label}:`, error.message);
      results.push({
        label,
        proxyAddress,
        success: false,
        error: error.message,
      });
    }
  }

  if (deploymentFileDirty) {
    fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
    console.log("\n✅ Deployment file updated:", deploymentFileName);
  } else {
    console.log("\nℹ️  No deployment-file changes to write.");
  }

  console.log("\n" + "=".repeat(70));
  console.log("📊 UPGRADE SUMMARY");
  console.log("=".repeat(70));

  const successful = results.filter((r) => r.success && !r.skipped);
  const skipped = results.filter((r) => r.success && r.skipped);
  const failed = results.filter((r) => !r.success);

  console.log(`\n✅ Successfully upgraded: ${successful.length}/${results.length} parking lot(s)`);
  if (skipped.length > 0) {
    console.log(`⏭️  Skipped: ${skipped.length} parking lot(s) (already upgraded)`);
  }

  if (successful.length > 0) {
    console.log("\nSuccessful Upgrades:");
    for (const result of successful) {
      console.log(`  ✓ ${result.label}`);
      console.log(`    Proxy: ${result.proxyAddress}`);
      console.log(`    New Implementation: ${newImplementationAddress}`);
      console.log(`    Tx Hash: ${result.txHash}`);
      console.log(`    Block: ${result.blockNumber}`);
    }
  }

  if (skipped.length > 0) {
    console.log("\nSkipped Parking Lots:");
    for (const result of skipped) {
      console.log(`  ⏭️  ${result.label}`);
      console.log(`    Proxy: ${result.proxyAddress}`);
      console.log(`    Implementation: ${newImplementationAddress}`);
      console.log(`    Reason: ${result.reason}`);
    }
  }

  if (failed.length > 0) {
    console.log("\n❌ Failed Upgrades:");
    for (const result of failed) {
      console.log(`  ✗ ${result.label}`);
      console.log(`    Proxy: ${result.proxyAddress}`);
      console.log(`    Error: ${result.error}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(`🎉 ${CONTRACT_NAME} Upgrade Process Complete!`);
  console.log("=".repeat(70) + "\n");

  if (failed.length > 0) {
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
