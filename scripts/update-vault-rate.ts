import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Updates a vault's rate (share -> deposit-asset price).
 *
 * On-chain path:
 *   EmberVault.updateVaultRate(newRate) — called on the vault itself, not via
 *   the protocol config, and onlyRateManager. Signer here MUST therefore be the
 *   vault's rate manager. If the rate manager is a Fordefi vault, build the tx
 *   in vaults-ops instead.
 *
 * Units:
 *   NEW_RATE is a human decimal (e.g. "1.084551646"), scaled to 1e18 with string
 *   math — the contract stores the rate in 1e18 fixed-point, 1e18 = 1.0.
 *
 * Checks before sending, in the contract's order:
 *   protocol not paused, privileged ops not paused, rateUpdateInterval elapsed,
 *   within protocolConfig min/max rate, change within maxRateChangePerUpdate,
 *   different from the current rate.
 *   Plus an off-chain deviation guard (default 10%, as in vaults-ops): the
 *   on-chain maxRateChangePerUpdate can be as loose as 99.9%, which would let a
 *   misplaced decimal wipe out the share price.
 *
 * Required ENV variables:
 *   VAULT_KEY                  - Key of the vault in deployment file (e.g. "emberUdl")
 *   NEW_RATE                   - New rate as a decimal (e.g. "1.084551646")
 *
 * Optional ENV variables:
 *   IS_ETH_VAULT               - "true" to target ethVaults instead of vaults
 *   MAX_RATE_DEVIATION_PERCENT - Override the off-chain deviation guard (default 10)
 */
const DEFAULT_MAX_RATE_DEVIATION_PERCENT = 10;
const ONE_E18 = 10n ** 18n;

// Decimal string -> 1e18 fixed-point, without passing through a float.
function scaleTo1e18(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`NEW_RATE must be a plain decimal like "1.084551646", got "${value}"`);
  }
  const [whole, frac = ""] = value.split(".");
  if (frac.length > 18) {
    throw new Error(`NEW_RATE has more than 18 decimal places: "${value}"`);
  }
  return BigInt(whole) * ONE_E18 + BigInt(frac.padEnd(18, "0"));
}

// 1e18 fixed-point -> percent string, 4 decimals.
const asPercent = (v: bigint) => {
  const scaled = (v * 1_000_000n) / ONE_E18; // hundredths of a basis point
  return `${(scaled / 10_000n).toString()}.${(scaled % 10_000n).toString().padStart(4, "0")}%`;
};

async function main() {
  console.log("\n📈 Updating Vault Rate...\n");

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
  const newRateInput = process.env.NEW_RATE;

  if (!vaultKey || !newRateInput) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  VAULT_KEY - Key of the vault in deployment file");
    console.log('  NEW_RATE  - New rate as a decimal (e.g. "1.084551646")');

    console.log("\nAvailable vaults:");
    const vaults = isEthVault
      ? deploymentInfo.contracts.ethVaults
      : deploymentInfo.contracts.vaults;
    if (vaults) {
      Object.keys(vaults).forEach((key) => {
        const vault = vaults[key];
        console.log(`  - ${key}: ${vault.name}`);
        console.log(`      Address: ${vault.proxyAddress}`);
        console.log(`      Rate Manager: ${vault.rateManager}`);
      });
    }

    process.exit(1);
  }

  let newRate: bigint;
  try {
    newRate = scaleTo1e18(newRateInput.trim());
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
  if (newRate === 0n) {
    console.error(
      "❌ Error: NEW_RATE must be > 0 — a zero rate makes the vault's shares worthless."
    );
    process.exit(1);
  }

  const maxDeviationPercent = Number(
    process.env.MAX_RATE_DEVIATION_PERCENT ?? DEFAULT_MAX_RATE_DEVIATION_PERCENT
  );
  if (!Number.isFinite(maxDeviationPercent) || maxDeviationPercent <= 0) {
    console.error(
      `❌ Error: Invalid MAX_RATE_DEVIATION_PERCENT: ${process.env.MAX_RATE_DEVIATION_PERCENT}`
    );
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

  // Read current on-chain state
  const vaultContractName = isEthVault ? "EmberETHVault" : "EmberVault";
  const vault = await ethers.getContractAt(vaultContractName, vaultInfo.proxyAddress);
  const protocolConfig = await ethers.getContractAt(
    "EmberProtocolConfig",
    await vault.protocolConfig()
  );
  const vaultRoles = await vault.roles();
  const rate = await vault.rate();
  const currentRate: bigint = BigInt(rate.value);
  const maxRateChange: bigint = BigInt(rate.maxRateChangePerUpdate);
  const lastUpdatedAt: bigint = BigInt(rate.lastUpdatedAt);
  const rateUpdateInterval: bigint = BigInt(rate.rateUpdateInterval);
  const minRate: bigint = BigInt(await protocolConfig.getMinRate());
  const maxRate: bigint = BigInt(await protocolConfig.getMaxRate());
  const latestBlock = await ethers.provider.getBlock("latest");
  const chainNowMs = BigInt(latestBlock!.timestamp) * 1000n;
  const eligibleAtMs = lastUpdatedAt + rateUpdateInterval;

  // Mirrors FixedPointMath.percentChangeFrom: floor(|new - current| * 1e18 / current)
  const delta = newRate > currentRate ? newRate - currentRate : currentRate - newRate;
  const percentChange = currentRate === 0n ? 0n : (delta * ONE_E18) / currentRate;

  console.log("Configuration:");
  console.log("  Vault Key:", vaultKey);
  console.log("  Vault Name:", vaultInfo.name);
  console.log("  Vault Address:", vaultInfo.proxyAddress);
  console.log("  Rate Manager:", vaultRoles.rateManager);
  console.log("  Current Rate:", `${ethers.formatUnits(currentRate, 18)} (${currentRate})`);
  console.log("  New Rate:    ", `${ethers.formatUnits(newRate, 18)} (${newRate})`);
  console.log("  Change:      ", asPercent(percentChange));
  console.log("  Max Change Per Update (on-chain):", asPercent(maxRateChange));
  console.log("  Deviation Guard (off-chain):     ", `${maxDeviationPercent}%`);
  console.log(
    "  Last Updated:",
    new Date(Number(lastUpdatedAt)).toISOString(),
    `(interval ${Number(rateUpdateInterval) / 3_600_000}h)`
  );
  console.log(
    "  Signer matches Rate Manager:",
    signer.address.toLowerCase() === vaultRoles.rateManager.toLowerCase()
  );
  console.log();

  // Same value: the contract reverts SameValue(), so there's nothing to send.
  if (newRate === currentRate) {
    console.log("✅ New rate equals current. No action needed.");
    process.exit(0);
  }

  // Preflight checks, in the contract's order. Any failure exits before sending.
  const fail = (msg: string): never => {
    console.error(`❌ ${msg}`);
    process.exit(1);
  };
  if (signer.address.toLowerCase() !== vaultRoles.rateManager.toLowerCase()) {
    fail(
      `Signer ${signer.address} is not the vault rate manager ${vaultRoles.rateManager} — the tx would revert Unauthorized(). If the rate manager is a Fordefi vault, use vaults-ops.`
    );
  }
  if (await protocolConfig.getProtocolPauseStatus()) {
    fail("Protocol is paused — the tx would revert ProtocolPaused().");
  }
  if ((await vault.pauseStatus()).privilegedOperations) {
    fail("Vault privileged operations are paused — the tx would revert OperationPaused().");
  }
  if (chainNowMs < eligibleAtMs) {
    const minutes = Number(eligibleAtMs - chainNowMs) / 60_000;
    fail(
      `Rate update interval has not elapsed — the tx would revert InvalidInterval(). Eligible at ${new Date(Number(eligibleAtMs)).toISOString()} (in ${minutes.toFixed(1)} min).`
    );
  }
  if (newRate < minRate || newRate > maxRate) {
    fail(
      `New rate is outside protocol bounds [${ethers.formatUnits(minRate, 18)}, ${ethers.formatUnits(maxRate, 18)}] — the tx would revert InvalidRate().`
    );
  }
  if (percentChange > maxRateChange) {
    fail(
      `Change ${asPercent(percentChange)} exceeds the vault's maxRateChangePerUpdate ${asPercent(maxRateChange)} — the tx would revert InvalidRate(). Split it across several updates.`
    );
  }
  // Compared in basis points so a fractional override (e.g. 0.5) isn't truncated to 0.
  const maxDeviationBps = BigInt(Math.round(maxDeviationPercent * 100));
  if (currentRate > 0n && delta * 10_000n > currentRate * maxDeviationBps) {
    fail(
      `Change ${asPercent(percentChange)} exceeds the ${maxDeviationPercent}% deviation guard — check the decimal placement. Set MAX_RATE_DEVIATION_PERCENT to override if the move is real.`
    );
  }

  // Static-call simulation for a clearer revert reason on failure
  try {
    await vault.updateVaultRate.staticCall(newRate);
  } catch (error: any) {
    fail(`Static-call simulation reverted: ${error.reason ?? error.shortMessage ?? error.message}`);
  }

  console.log("Updating vault rate...");
  const tx = await vault.updateVaultRate(newRate);
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify on-chain state
  const updated: bigint = BigInt((await vault.rate()).value);
  if (updated === newRate) {
    console.log("\n✅ Vault rate updated successfully!");
    console.log("Updated Rate:", `${ethers.formatUnits(updated, 18)} (${updated})`);
  } else {
    console.error("\n❌ Error: rate verification failed!");
    console.log("Expected:", newRate.toString());
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
