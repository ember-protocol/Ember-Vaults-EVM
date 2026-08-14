import { ethers } from "hardhat";
import * as fs from "fs";

type DeploymentInfo = {
  contracts?: {
    protocolConfig?: {
      proxyAddress?: string;
    };
    depositParkingLots?: Record<string, ParkingLotRecord>;
    vaults?: Record<string, VaultDeploymentRecord>;
  };
};

type VaultDeploymentRecord = {
  proxyAddress?: string;
  name?: string;
  parkingLotAddress?: string;
  parkingLotUpdatedAt?: string;
  [key: string]: unknown;
};

type ParkingLotRecord = {
  proxyAddress?: string;
  vault?: string;
  [key: string]: unknown;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Sets the deposit parking lot on one or more EmberVault (USDC) vaults. Calls
 * EmberProtocolConfig.setVaultParkingLot(vault, newParkingLot), which forwards
 * to vault.setParkingLot — onlyProtocolConfig onlyAdmin(caller) on the vault
 * side, so the transaction sender must be the vault admin.
 *
 * Passing the zero address (`NEW_PARKING_LOT=0x0`) clears the gate and
 * restores permissionless direct deposits.
 *
 * Only EmberVault has a parkingLot slot — EmberETHVault does not — so this
 * script targets `deployment.contracts.vaults` only and does not accept an
 * IS_ETH_VAULT flag.
 *
 * Usage:
 *   yarn admin:update-parking-lot --network <NETWORK>
 *   NEW_PARKING_LOT=0x... yarn admin:update-parking-lot --network <NETWORK>
 *   NEW_PARKING_LOT=0x0 VAULT_KEYS=emberHilbertBtc yarn admin:update-parking-lot --network <NETWORK>
 *
 * Optional ENV variables:
 *   NEW_PARKING_LOT - Parking lot address to set on every processed vault
 *                     (single value applied uniformly). Pass 0x0 or `0` to
 *                     clear the gate. Defaults to per-vault lookup in
 *                     deploymentInfo.contracts.depositParkingLots[<vaultKey>]
 *                     .proxyAddress when omitted.
 *   VAULT_KEYS      - Comma-separated vault keys from deployment JSON
 *                     (omit to process all vaults)
 *
 * Notes:
 * - Only the vault ADMIN can change the parking lot. The signer must be admin
 *   on every targeted vault (admin is per-vault). In production the admin is
 *   the admin timelock; this script signs directly and is intended for the
 *   dev/test flow where the signer's EOA is the admin. Route through the
 *   timelock via the tx-bytes flow in ember-utils for production changes.
 * - The vault reverts SameValue() if the target already matches, so this
 *   script skips locally to avoid a guaranteed revert.
 * - The deployment JSON's per-vault `parkingLotAddress` + `parkingLotUpdatedAt`
 *   fields are updated on success. Failures are reported but do not abort the
 *   loop.
 */
async function main() {
  console.log("\n🅿️  Updating Vault Parking Lot...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(signer.address)),
    "ETH\n"
  );

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  console.log("📂 Loading deployment file:", deploymentFileName);
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8")) as DeploymentInfo;

  const protocolConfigAddress = deploymentInfo.contracts?.protocolConfig?.proxyAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: Protocol config not found in deployment file!");
    process.exit(1);
  }

  const vaults = deploymentInfo.contracts?.vaults;
  if (!vaults || Object.keys(vaults).length === 0) {
    console.error("❌ Error: No vaults found in deployment file!");
    process.exit(1);
  }

  const parkingLotsMap = deploymentInfo.contracts?.depositParkingLots ?? {};

  // If NEW_PARKING_LOT is provided, apply the same address to every processed
  // vault. If omitted, resolve per-vault from the depositParkingLots map.
  const newParkingLotEnv = process.env.NEW_PARKING_LOT;
  const uniformParkingLot: string | null = (() => {
    if (!newParkingLotEnv) return null;
    if (newParkingLotEnv === "0" || newParkingLotEnv.toLowerCase() === "0x0") return ZERO_ADDRESS;
    if (!ethers.isAddress(newParkingLotEnv)) {
      console.error(`❌ Error: Invalid parking lot address: ${newParkingLotEnv}`);
      process.exit(1);
    }
    return newParkingLotEnv;
  })();

  const vaultKeysEnv = process.env.VAULT_KEYS;
  let vaultKeysToProcess: string[];
  if (vaultKeysEnv) {
    vaultKeysToProcess = vaultKeysEnv.split(",").map((k) => k.trim());
    console.log("🎯 Processing specific vaults:", vaultKeysToProcess.join(", "));
  } else {
    vaultKeysToProcess = Object.keys(vaults);
    console.log("🎯 Processing ALL vaults:", vaultKeysToProcess.join(", "));
  }

  for (const vaultKey of vaultKeysToProcess) {
    if (!vaults[vaultKey]) {
      console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!`);
      console.log("Available vaults:");
      Object.keys(vaults).forEach((key) => console.log(`  - ${key}`));
      process.exit(1);
    }
  }

  // Resolve target parking lot per vault: uniform (env) or per-vault lookup.
  const targets: Array<{ vaultKey: string; targetParkingLot: string; source: string }> = [];
  for (const vaultKey of vaultKeysToProcess) {
    if (uniformParkingLot !== null) {
      targets.push({ vaultKey, targetParkingLot: uniformParkingLot, source: "env" });
      continue;
    }
    const pl = parkingLotsMap[vaultKey]?.proxyAddress;
    if (!pl) {
      console.error(
        `❌ Error: No NEW_PARKING_LOT env override and no depositParkingLots.${vaultKey}.proxyAddress in deployment file.`
      );
      console.log(
        "Deploy the parking lot for this vault first, or pass NEW_PARKING_LOT=0x... explicitly."
      );
      process.exit(1);
    }
    if (!ethers.isAddress(pl)) {
      console.error(
        `❌ Error: Invalid parking lot address in deployment file for ${vaultKey}: ${pl}`
      );
      process.exit(1);
    }
    targets.push({ vaultKey, targetParkingLot: pl, source: "deployment file" });
  }

  console.log("Protocol Config:", protocolConfigAddress);
  console.log(
    "Parking Lot mode:",
    uniformParkingLot !== null
      ? `uniform → ${uniformParkingLot} (env)`
      : "per-vault (from deployment file)"
  );

  console.log("\n" + "=".repeat(70));
  console.log("📋 Vaults to Process:");
  console.log("=".repeat(70));
  for (const { vaultKey, targetParkingLot, source } of targets) {
    const vaultInfo = vaults[vaultKey];
    console.log(`\n${vaultKey}:`);
    console.log(`  Name: ${vaultInfo.name ?? "Unknown"}`);
    console.log(`  Address: ${vaultInfo.proxyAddress ?? "Missing"}`);
    console.log(`  Target Parking Lot: ${targetParkingLot} (${source})`);
    console.log(`  Stored Parking Lot: ${String(vaultInfo.parkingLotAddress ?? "Not set")}`);
  }
  console.log("\n" + "=".repeat(70));

  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);

  const results: Array<{
    vaultKey: string;
    success: boolean;
    skipped?: boolean;
    reason?: string;
    blockNumber?: number;
    txHash?: string;
    error?: string;
  }> = [];

  let deploymentJsonChanged = false;

  for (const { vaultKey, targetParkingLot } of targets) {
    const vaultInfo = vaults[vaultKey];

    console.log("\n" + "-".repeat(70));
    console.log(`🛠️ Processing ${vaultKey}`);
    console.log("-".repeat(70));

    try {
      if (!vaultInfo.proxyAddress) {
        throw new Error("Vault proxy address not found in deployment file");
      }

      const vault = await ethers.getContractAt("EmberVault", vaultInfo.proxyAddress);
      const vaultRoles = await vault.roles();
      const currentAdmin = vaultRoles.admin;
      const currentParkingLot: string = await vault.parkingLot();

      console.log("Vault Address:", vaultInfo.proxyAddress);
      console.log("Current Admin:", currentAdmin);
      console.log("Current Parking Lot:", currentParkingLot);
      console.log("Target Parking Lot: ", targetParkingLot);

      // Already at target — skip on-chain call. The vault reverts SameValue()
      // in setParkingLot, so this is not just a gas optimization: hitting the
      // contract in this state would fail the whole tx.
      if (currentParkingLot.toLowerCase() === targetParkingLot.toLowerCase()) {
        console.log("✅ Parking lot already set on-chain. Skipping contract update.");
        if (vaultInfo.parkingLotAddress !== targetParkingLot) {
          vaultInfo.parkingLotAddress = targetParkingLot;
          deploymentJsonChanged = true;
          console.log("📝 Deployment JSON parkingLotAddress field synchronized.");
        }
        results.push({
          vaultKey,
          success: true,
          skipped: true,
          reason: "Parking lot already set",
        });
        continue;
      }

      // Pre-flight: only the vault admin can change the parking lot.
      if (signer.address.toLowerCase() !== currentAdmin.toLowerCase()) {
        throw new Error(
          `Signer (${signer.address}) is not the vault admin (${currentAdmin}). Only the admin can change the parking lot.`
        );
      }

      // Static-call simulation for a clearer revert reason on failure.
      try {
        await protocolConfig.setVaultParkingLot.staticCall(
          vaultInfo.proxyAddress,
          targetParkingLot
        );
      } catch (staticCallError: any) {
        const detail = staticCallError.reason ?? staticCallError.message ?? "unknown";
        throw new Error(`Static-call simulation reverted: ${detail}`);
      }

      console.log("Updating parking lot on-chain...");
      const tx = await protocolConfig.setVaultParkingLot(vaultInfo.proxyAddress, targetParkingLot);
      console.log("Transaction hash:", tx.hash);

      const receipt = await tx.wait();
      console.log("Transaction confirmed in block:", receipt?.blockNumber);

      const updatedParkingLot: string = await vault.parkingLot();
      if (updatedParkingLot.toLowerCase() !== targetParkingLot.toLowerCase()) {
        throw new Error(
          `Parking lot verification failed. Expected ${targetParkingLot} but got ${updatedParkingLot}`
        );
      }

      console.log("✅ Parking lot updated successfully.");

      vaultInfo.parkingLotAddress = targetParkingLot;
      vaultInfo.parkingLotUpdatedAt = new Date().toISOString();
      deploymentJsonChanged = true;

      results.push({
        vaultKey,
        success: true,
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
      });
    } catch (error: any) {
      console.error(`❌ Failed to process ${vaultKey}:`, error.message);
      results.push({
        vaultKey,
        success: false,
        error: error.message,
      });
    }
  }

  if (deploymentJsonChanged) {
    fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
    console.log("\n✅ Deployment file updated:", deploymentFileName);
  } else {
    console.log("\nℹ️ Deployment file unchanged.");
  }

  const successful = results.filter((r) => r.success && !r.skipped);
  const skipped = results.filter((r) => r.success && r.skipped);
  const failed = results.filter((r) => !r.success);

  console.log("\n" + "=".repeat(70));
  console.log("📊 PARKING LOT UPDATE SUMMARY");
  console.log("=".repeat(70));
  console.log(`\n✅ Updated: ${successful.length}`);
  console.log(`⏭️ Skipped: ${skipped.length}`);
  console.log(`❌ Failed:  ${failed.length}`);

  for (const r of successful) {
    console.log(`  - ${r.vaultKey} -> block ${String(r.blockNumber ?? "n/a")}`);
  }
  for (const r of skipped) {
    console.log(`  - ${r.vaultKey} -> ${r.reason}`);
  }
  for (const r of failed) {
    console.log(`  - ${r.vaultKey} -> ${r.error}`);
  }

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
