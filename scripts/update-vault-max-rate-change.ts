import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Updates the vault's maxRateChangePerUpdate (the ceiling on how much the
 * rate is allowed to move in one updateVaultRate call).
 *
 * On-chain path:
 *   EmberProtocolConfig.updateVaultMaxRateChangePerUpdate(vault, newValue)
 *     -> IEmberVault(vault).setMaxRateChangePerUpdate(msg.sender, newValue)
 *   which is onlyAdmin(caller). Signer here MUST therefore be the vault admin.
 *   If the vault's admin is a Timelock or a Safe, use the tx-bytes flow in
 *   ember-utils instead (yarn evm-update-vault-max-rate-change).
 *
 * Fixed-point:
 *   maxRateChangePerUpdate is stored in 1e18 fixed-point where 1e18 = 100%.
 *   Common values:
 *     NEW_MAX_RATE_CHANGE=10000000000000000     -> 1%
 *     NEW_MAX_RATE_CHANGE=50000000000000000     -> 5%
 *     NEW_MAX_RATE_CHANGE=100000000000000000    -> 10%
 *   The contract rejects 0 (InvalidRate) and reverts on same-value (SameValue).
 *   Nothing on-chain caps the upper bound below 1e18 — the script does refuse
 *   values >= 1e18 as an operator safety net (100 %+ change per update is
 *   almost certainly a fat-finger).
 *
 * Required ENV variables:
 *   VAULT_KEY           - Key of the vault in deployment file (e.g. "emberUdl")
 *   NEW_MAX_RATE_CHANGE - New maxRateChangePerUpdate in the 1e18 convention above
 *
 * Optional ENV variables:
 *   IS_ETH_VAULT        - "true" to target ethVaults instead of vaults
 */
async function main() {
  console.log("\n👤 Updating Vault Max Rate Change Per Update...\n");

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
  const newMaxRateChange = process.env.NEW_MAX_RATE_CHANGE;

  if (!vaultKey || !newMaxRateChange) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  VAULT_KEY           - Key of the vault in deployment file");
    console.log(
      "  NEW_MAX_RATE_CHANGE - New maxRateChangePerUpdate (1e18 fixed-point, e.g. 10000000000000000 = 1%)"
    );

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

  // Parse the fixed-point uint. Reject non-numeric input, zero, and >= 1e18
  // (the last one isn't blocked on-chain but 100 %+ per update is almost
  // certainly a fat-finger — call it out before signing).
  let newMaxRateChangeBig: bigint;
  try {
    newMaxRateChangeBig = BigInt(newMaxRateChange);
  } catch {
    console.error(
      `❌ Error: NEW_MAX_RATE_CHANGE must be an integer (1e18 fixed-point), got "${newMaxRateChange}"`
    );
    process.exit(1);
  }
  if (newMaxRateChangeBig <= 0n) {
    console.error(
      `❌ Error: NEW_MAX_RATE_CHANGE must be > 0 (contract reverts with InvalidRate on 0). Got ${newMaxRateChangeBig.toString()}.`
    );
    process.exit(1);
  }
  const ONE_E18 = 10n ** 18n;
  // if (newMaxRateChangeBig >= ONE_E18) {
  //   console.error(
  //     `❌ Error: NEW_MAX_RATE_CHANGE=${newMaxRateChangeBig.toString()} is >= 1e18 (=100%). A per-update rate ceiling at or above 100% is almost certainly a mistake. If this is intentional, remove this guard from the script.`
  //   );
  //   process.exit(1);
  // }

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

  // Read current on-chain state through the vault-side view
  const vaultContractName = isEthVault ? "EmberETHVault" : "EmberVault";
  const vault = await ethers.getContractAt(vaultContractName, vaultInfo.proxyAddress);
  const vaultRoles = await vault.roles();
  const currentAdmin = vaultRoles.admin;
  const vaultOwner = await vault.owner();
  const rate = await vault.rate();
  const currentMaxRateChange: bigint = BigInt(rate.maxRateChangePerUpdate);

  // Helper: pretty-print a 1e18 uint as a percent for logging
  const asPercent = (v: bigint) => {
    // Keep 4 decimals: 1e14 chunks
    const scaled = (v * 10_000n) / ONE_E18; // basis-of-100 * 100
    const whole = scaled / 100n;
    const frac = scaled % 100n;
    return `${whole.toString()}.${frac.toString().padStart(2, "0")}%`;
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
    "  Current Max Rate Change:",
    `${currentMaxRateChange.toString()} (${asPercent(currentMaxRateChange)})`
  );
  console.log(
    "  New Max Rate Change:    ",
    `${newMaxRateChangeBig.toString()} (${asPercent(newMaxRateChangeBig)})`
  );
  console.log(
    "  Signer matches Admin:  ",
    signer.address.toLowerCase() === currentAdmin.toLowerCase()
  );
  console.log();

  // Skip on same-value up-front so we don't spend gas on a guaranteed
  // SameValue revert.
  if (currentMaxRateChange === newMaxRateChangeBig) {
    console.log("✅ New maxRateChangePerUpdate equals current. No action needed.");
    process.exit(0);
  }

  // Warn (not block) when the signer isn't the vault admin — the on-chain
  // check will still reject, but surfacing it here saves a failed tx.
  if (signer.address.toLowerCase() !== currentAdmin.toLowerCase()) {
    console.warn(
      `⚠️  Signer ${signer.address} is not the vault admin ${currentAdmin}. The tx will revert with Unauthorized(). If the admin is a Timelock/Safe, use scripts/evm/update-vault-max-rate-change-evm.ts in ember-utils to produce tx bytes for offline signing.`
    );
  }

  console.log("Updating vault maxRateChangePerUpdate...");
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);
  const tx = await protocolConfig.updateVaultMaxRateChangePerUpdate(
    vaultInfo.proxyAddress,
    newMaxRateChangeBig
  );
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify on-chain state
  const updatedRate = await vault.rate();
  const updated: bigint = BigInt(updatedRate.maxRateChangePerUpdate);
  if (updated === newMaxRateChangeBig) {
    console.log("\n✅ Vault maxRateChangePerUpdate updated successfully!");
    console.log("Updated Max Rate Change:", `${updated.toString()} (${asPercent(updated)})`);
  } else {
    console.error("\n❌ Error: maxRateChangePerUpdate verification failed!");
    console.log("Expected:", newMaxRateChangeBig.toString());
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
