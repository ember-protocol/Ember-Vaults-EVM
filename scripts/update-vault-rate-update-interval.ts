import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Updates the vault's rateUpdateInterval — the minimum time that must elapse
 * between two updateVaultRate calls.
 *
 * On-chain path:
 *   EmberProtocolConfig.updateVaultRateUpdateInterval(vault, newInterval)
 *     -> IEmberVault(vault).setRateUpdateInterval(msg.sender, newInterval)
 *   which is onlyAdmin(caller). Signer here MUST therefore be the vault admin.
 *   If the vault's admin is a Timelock or a Safe, use the tx-bytes flow in
 *   ember-utils instead (yarn evm-update-vault-rate-update-interval).
 *
 * Units:
 *   rateUpdateInterval is stored in MILLISECONDS. Handy conversions:
 *     NEW_INTERVAL=3600000     -> 1 hour   (MIN_RATE_INTERVAL floor)
 *     NEW_INTERVAL=21600000    -> 6 hours
 *     NEW_INTERVAL=43200000    -> 12 hours
 *     NEW_INTERVAL=86400000    -> 24 hours (MAX_RATE_INTERVAL ceiling)
 *   The ProtocolConfig enforces
 *     minRateInterval <= newInterval <= maxRateInterval
 *   (defaults: 1h..24h in ms; both are admin-adjustable so the live values may
 *   be tighter). Same-value updates revert with SameValue. The script reads
 *   the live bounds and refuses out-of-range values before signing.
 *
 * Required ENV variables:
 *   VAULT_KEY     - Key of the vault in deployment file (e.g. "emberUdl")
 *   NEW_INTERVAL  - New rate update interval in MILLISECONDS
 *
 * Optional ENV variables:
 *   IS_ETH_VAULT  - "true" to target ethVaults instead of vaults
 */
async function main() {
  console.log("\n👤 Updating Vault Rate Update Interval...\n");

  const isEthVault = process.env.IS_ETH_VAULT === "true";

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log();

  // Load deployment file
  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  // Parameters
  const vaultKey = process.env.VAULT_KEY;
  const newInterval = process.env.NEW_INTERVAL;

  if (!vaultKey || !newInterval) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  VAULT_KEY     - Key of the vault in deployment file");
    console.log("  NEW_INTERVAL  - New rateUpdateInterval in milliseconds (e.g. 86400000 = 24h)");

    console.log("\nAvailable vaults:");
    const vaults = isEthVault
      ? deploymentInfo.contracts.ethVaults
      : deploymentInfo.contracts.vaults;
    if (vaults) {
      Object.keys(vaults).forEach((key) => {
        const vault = vaults[key];
        console.log(`  - ${key}: ${vault.name}`);
        console.log(`      Address: ${vault.proxyAddress}`);
        console.log(`      Current Admin: ${vault.admin}`);
      });
    }

    process.exit(1);
  }

  // Parse the interval — reject non-numeric input and zero. Range check
  // against ProtocolConfig happens below once we've read the live bounds.
  let newIntervalBig: bigint;
  try {
    newIntervalBig = BigInt(newInterval);
  } catch {
    console.error(`❌ Error: NEW_INTERVAL must be an integer (milliseconds), got "${newInterval}"`);
    process.exit(1);
  }
  if (newIntervalBig <= 0n) {
    console.error(`❌ Error: NEW_INTERVAL must be > 0. Got ${newIntervalBig.toString()}.`);
    process.exit(1);
  }

  const vaults = isEthVault ? deploymentInfo.contracts.ethVaults : deploymentInfo.contracts.vaults;
  const vaultInfo = vaults?.[vaultKey];
  if (!vaultInfo) {
    console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!`);
    console.log("\nAvailable vaults:");
    if (vaults) {
      Object.keys(vaults).forEach((key) => {
        console.log(`  - ${key}`);
      });
    }
    process.exit(1);
  }

  const protocolConfigAddress = deploymentInfo.contracts.protocolConfig?.proxyAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: Protocol config not found in deployment file!");
    process.exit(1);
  }

  // Read current on-chain state through the vault-side view + live bounds
  // from ProtocolConfig. The bounds are admin-adjustable, so we read them
  // rather than trusting the compile-time MIN_RATE_INTERVAL / MAX_RATE_INTERVAL
  // constants.
  const vaultContractName = isEthVault ? "EmberETHVault" : "EmberVault";
  const vault = await ethers.getContractAt(vaultContractName, vaultInfo.proxyAddress);
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);
  const vaultRoles = await vault.roles();
  const currentAdmin = vaultRoles.admin;
  const vaultOwner = await vault.owner();
  const rate = await vault.rate();
  const currentInterval: bigint = BigInt(rate.rateUpdateInterval);
  const minInterval: bigint = BigInt(await protocolConfig.getMinRateInterval());
  const maxInterval: bigint = BigInt(await protocolConfig.getMaxRateInterval());

  // Helper: format a millisecond interval as "Nh Mm" for legibility
  const formatMs = (ms: bigint) => {
    const totalSec = ms / 1000n;
    const h = totalSec / 3600n;
    const m = (totalSec % 3600n) / 60n;
    const s = totalSec % 60n;
    const parts: string[] = [];
    if (h > 0n) parts.push(`${h}h`);
    if (m > 0n) parts.push(`${m}m`);
    if (s > 0n || parts.length === 0) parts.push(`${s}s`);
    return parts.join(" ");
  };

  console.log("Configuration:");
  console.log("  Vault Key:", vaultKey);
  console.log("  Vault Name:", vaultInfo.name);
  console.log("  Vault Address:", vaultInfo.proxyAddress);
  console.log("  Protocol Config:", protocolConfigAddress);
  console.log("  Vault Owner:", vaultOwner);
  console.log("  Current Admin:", currentAdmin);
  console.log("  Current Operator:", vaultRoles.operator);
  console.log("  Current Rate Manager:", vaultRoles.rateManager);
  console.log(
    "  Live Bounds:            ",
    `[${minInterval.toString()} (${formatMs(minInterval)}), ${maxInterval.toString()} (${formatMs(maxInterval)})]`
  );
  console.log(
    "  Current Interval:       ",
    `${currentInterval.toString()} (${formatMs(currentInterval)})`
  );
  console.log(
    "  New Interval:           ",
    `${newIntervalBig.toString()} (${formatMs(newIntervalBig)})`
  );
  console.log(
    "  Signer matches Admin:   ",
    signer.address.toLowerCase() === currentAdmin.toLowerCase()
  );
  console.log();

  // Reject values outside the live bounds up-front (the contract reverts
  // with InvalidInterval; catching it here saves a failed tx).
  if (newIntervalBig < minInterval || newIntervalBig > maxInterval) {
    console.error(
      `❌ Error: NEW_INTERVAL=${newIntervalBig.toString()} is outside the live bounds [${minInterval.toString()}, ${maxInterval.toString()}] and would revert with InvalidInterval. Pick a value in ms within that window (${formatMs(minInterval)}..${formatMs(maxInterval)}).`
    );
    process.exit(1);
  }

  // Skip on same-value up-front so we don't spend gas on a guaranteed
  // SameValue revert.
  if (currentInterval === newIntervalBig) {
    console.log("✅ New rateUpdateInterval equals current. No action needed.");
    process.exit(0);
  }

  // Warn (not block) when the signer isn't the vault admin — the on-chain
  // check will still reject, but surfacing it here saves a failed tx.
  if (signer.address.toLowerCase() !== currentAdmin.toLowerCase()) {
    console.warn(
      `⚠️  Signer ${signer.address} is not the vault admin ${currentAdmin}. The tx will revert with Unauthorized(). If the admin is a Timelock/Safe, use the tx-bytes flow in ember-utils to produce offline-signable bytes.`
    );
  }

  console.log("Updating vault rateUpdateInterval...");
  const tx = await protocolConfig.updateVaultRateUpdateInterval(
    vaultInfo.proxyAddress,
    newIntervalBig
  );
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify on-chain state
  const updatedRate = await vault.rate();
  const updated: bigint = BigInt(updatedRate.rateUpdateInterval);
  if (updated === newIntervalBig) {
    console.log("\n✅ Vault rateUpdateInterval updated successfully!");
    console.log("Updated Interval:", `${updated.toString()} (${formatMs(updated)})`);
  } else {
    console.error("\n❌ Error: rateUpdateInterval verification failed!");
    console.log("Expected:", newIntervalBig.toString());
    console.log("Got:     ", updated.toString());
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
