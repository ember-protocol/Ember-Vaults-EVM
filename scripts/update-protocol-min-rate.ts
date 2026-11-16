import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Updates the protocol-wide minRate (the floor every vault rate is checked
 * against in EmberVault.updateVaultRate).
 *
 * On-chain path:
 *   EmberProtocolConfig.updateMinRate(newValue)
 *   which is onlyOwner. Signer here MUST therefore be the protocol config
 *   owner. If that owner is a Timelock or a Safe, use the timelock flow in
 *   scripts/admin instead of calling this directly.
 *
 * Fixed-point:
 *   minRate is stored in 1e18 fixed-point where 1e18 = 100%. A freshly
 *   deployed protocol config carries the contract's MIN_RATE constant of
 *   250000000000000000 (25%), which is far too high for vaults whose share
 *   price starts well below 1.0 — ethereum runs 10000000 for that reason.
 *   Common values:
 *     NEW_MIN_RATE=10000000                  -> ~0% (ethereum's value)
 *     NEW_MIN_RATE=250000000000000000        -> 25% (contract default)
 *
 *   The contract rejects 0, anything above maxRate or defaultRate
 *   (InvalidRate), and same-value (SameValue).
 *
 * Required ENV variables:
 *   NEW_MIN_RATE - New minRate in the 1e18 convention above
 *
 * Example:
 *   NEW_MIN_RATE=10000000 npx hardhat run scripts/update-protocol-min-rate.ts --network monad
 */
async function main() {
  console.log("\n👤 Updating Protocol Min Rate...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log();

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  const newMinRate = process.env.NEW_MIN_RATE;
  if (!newMinRate) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  NEW_MIN_RATE - New minRate (1e18 fixed-point, e.g. 10000000000000000 = 1%)");
    process.exit(1);
  }

  let newMinRateBig: bigint;
  try {
    newMinRateBig = BigInt(newMinRate);
  } catch {
    console.error(
      `❌ Error: NEW_MIN_RATE must be an integer (1e18 fixed-point), got "${newMinRate}"`
    );
    process.exit(1);
  }
  if (newMinRateBig <= 0n) {
    console.error(
      `❌ Error: NEW_MIN_RATE must be > 0 (contract reverts with InvalidRate on 0). Got ${newMinRateBig.toString()}.`
    );
    process.exit(1);
  }

  const protocolConfigAddress = deploymentInfo.contracts.protocolConfig?.proxyAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: Protocol config not found in deployment file!");
    process.exit(1);
  }

  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);
  const config = await protocolConfig.protocolConfig();
  const owner = await protocolConfig.owner();
  const currentMinRate: bigint = BigInt(config.minRate);
  const maxRate: bigint = BigInt(config.maxRate);
  const defaultRate: bigint = BigInt(config.defaultRate);

  const ONE_E18 = 10n ** 18n;
  const asPercent = (v: bigint) => {
    // Keep 6 decimals: minRate is routinely far below 1%, so the 2-decimal
    // format used for per-update ceilings would print every candidate as 0.00%.
    const scaled = (v * 100_000_000n) / ONE_E18;
    const whole = scaled / 1_000_000n;
    const frac = scaled % 1_000_000n;
    return `${whole.toString()}.${frac.toString().padStart(6, "0")}%`;
  };

  console.log("Configuration:");
  console.log("  Protocol Config:", protocolConfigAddress);
  console.log("  Owner:", owner);
  console.log("  Current Min Rate:", `${currentMinRate.toString()} (${asPercent(currentMinRate)})`);
  console.log("  New Min Rate:    ", `${newMinRateBig.toString()} (${asPercent(newMinRateBig)})`);
  console.log("  Max Rate:        ", `${maxRate.toString()} (${asPercent(maxRate)})`);
  console.log("  Default Rate:    ", `${defaultRate.toString()} (${asPercent(defaultRate)})`);
  console.log("  Signer matches Owner:", signer.address.toLowerCase() === owner.toLowerCase());
  console.log();

  if (currentMinRate === newMinRateBig) {
    console.log("✅ New minRate equals current. No action needed.");
    process.exit(0);
  }
  if (newMinRateBig > maxRate || newMinRateBig > defaultRate) {
    console.error(
      `❌ Error: NEW_MIN_RATE=${newMinRateBig.toString()} exceeds maxRate (${maxRate.toString()}) or defaultRate (${defaultRate.toString()}); the contract reverts with InvalidRate.`
    );
    process.exit(1);
  }

  // Raising the floor above a live vault's rate does not revert here, but it
  // silently locks that vault out of every future rate update. Surface it
  // before signing rather than at the next updateVaultRate.
  const vaults = deploymentInfo.contracts.vaults ?? {};
  const stranded: string[] = [];
  for (const [key, info] of Object.entries<any>(vaults)) {
    try {
      const vault = await ethers.getContractAt("EmberVault", info.proxyAddress);
      const rate = await vault.rate();
      if (BigInt(rate.value) < newMinRateBig) {
        stranded.push(`${key} (${info.name}): ${BigInt(rate.value).toString()}`);
      }
    } catch {
      console.warn(`⚠️  Could not read rate for vault '${key}'; skipping the floor check.`);
    }
  }
  if (stranded.length > 0) {
    console.warn(
      `⚠️  These vaults have a current rate BELOW the proposed minRate and would be unable to update their rate afterwards:`
    );
    stranded.forEach((s) => console.warn(`     - ${s}`));
    console.warn();
  }

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    console.warn(
      `⚠️  Signer ${signer.address} is not the protocol config owner ${owner}. The tx will revert with OwnableUnauthorizedAccount(). If the owner is a Timelock/Safe, use the timelock flow in scripts/admin to produce tx bytes for offline signing.`
    );
  }

  console.log("Updating protocol minRate...");
  const tx = await protocolConfig.updateMinRate(newMinRateBig);
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  const updatedConfig = await protocolConfig.protocolConfig();
  const updated: bigint = BigInt(updatedConfig.minRate);
  if (updated === newMinRateBig) {
    console.log("\n✅ Protocol minRate updated successfully!");
    console.log("Updated Min Rate:", `${updated.toString()} (${asPercent(updated)})`);
  } else {
    console.error("\n❌ Error: minRate verification failed!");
    console.log("Expected:", newMinRateBig.toString());
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
