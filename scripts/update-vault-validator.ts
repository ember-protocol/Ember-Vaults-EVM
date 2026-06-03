import { ethers } from "hardhat";
import * as fs from "fs";

type DeploymentInfo = {
  contracts?: {
    protocolConfig?: {
      proxyAddress?: string;
    };
    vaultValidator?: {
      proxyAddress?: string;
    };
    vaults?: Record<string, VaultDeploymentRecord>;
    ethVaults?: Record<string, VaultDeploymentRecord>;
  };
};

type VaultDeploymentRecord = {
  proxyAddress?: string;
  name?: string;
  validatorAddress?: string;
  validatorUpdatedAt?: string;
  [key: string]: unknown;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Sets the validator contract on one or more vaults. Calls
 * EmberProtocolConfig.setVaultValidator(vault, validator), which forwards to
 * vault.setVaultValidator — onlyAdmin on the vault side.
 *
 * Used to repair vaults whose `vaultValidator` storage slot is `0x0` after
 * the OFT-PR storage layout shift (fields inserted before vaultValidator
 * pushed validator's data into bridgeAdapter's slot, leaving vaultValidator
 * in a previously-zeroed gap slot).
 *
 * Usage:
 *   yarn admin:update-validator --network <NETWORK>
 *   NEW_VALIDATOR=0x... yarn admin:update-validator --network <NETWORK>
 *   VAULT_KEYS=<KEY_1>,<KEY_2> yarn admin:update-validator --network <NETWORK>
 *   IS_ETH_VAULT=true yarn admin:update-validator --network <NETWORK>
 *
 * Optional ENV variables:
 *   NEW_VALIDATOR - Validator address (defaults to
 *                   deploymentInfo.contracts.vaultValidator.proxyAddress)
 *   VAULT_KEYS    - Comma-separated vault keys from deployment JSON
 *                   (omit to process all vaults in the selected collection)
 *   IS_ETH_VAULT  - "true" to target ethVaults instead of vaults
 *
 * Notes:
 * - Only the vault ADMIN can change the validator. The signer must be admin
 *   on every targeted vault (admin is per-vault).
 * - The contract does NOT enforce SameValue, but already-correct vaults are
 *   skipped locally to avoid wasted gas.
 * - The deployment JSON's `validatorAddress` field is updated for each vault
 *   that confirms successfully. Failures are reported but do not abort the
 *   loop.
 */
async function main() {
  console.log("\n🛡️  Updating Vault Validator...\n");

  const isEthVault = process.env.IS_ETH_VAULT === "true";

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

  const vaults = isEthVault
    ? deploymentInfo.contracts?.ethVaults
    : deploymentInfo.contracts?.vaults;
  if (!vaults || Object.keys(vaults).length === 0) {
    console.error("❌ Error: No vaults found in deployment file!");
    process.exit(1);
  }

  const newValidatorRaw =
    process.env.NEW_VALIDATOR ?? deploymentInfo.contracts?.vaultValidator?.proxyAddress;

  if (!newValidatorRaw) {
    console.error("❌ Error: No validator address available!");
    console.log(
      "Set NEW_VALIDATOR explicitly, or deploy the validator first via: yarn deploy:vault-validator"
    );
    process.exit(1);
  }

  const newValidator =
    newValidatorRaw === "0" || newValidatorRaw.toLowerCase() === "0x0"
      ? ZERO_ADDRESS
      : newValidatorRaw;
  if (!ethers.isAddress(newValidator)) {
    console.error(`❌ Error: Invalid validator address: ${newValidatorRaw}`);
    process.exit(1);
  }

  const contractName = isEthVault ? "EmberETHVault" : "EmberVault";

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

  console.log("Protocol Config:", protocolConfigAddress);
  console.log(
    "Target Validator:",
    newValidator,
    process.env.NEW_VALIDATOR ? "(env)" : "(from deployment file)"
  );
  console.log("Vault Type:", isEthVault ? "ethVaults" : "vaults");

  console.log("\n" + "=".repeat(70));
  console.log("📋 Vaults to Process:");
  console.log("=".repeat(70));
  for (const vaultKey of vaultKeysToProcess) {
    const vaultInfo = vaults[vaultKey];
    console.log(`\n${vaultKey}:`);
    console.log(`  Name: ${vaultInfo.name ?? "Unknown"}`);
    console.log(`  Address: ${vaultInfo.proxyAddress ?? "Missing"}`);
    console.log(`  Stored Validator: ${String(vaultInfo.validatorAddress ?? "Not set")}`);
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

  for (const vaultKey of vaultKeysToProcess) {
    const vaultInfo = vaults[vaultKey];

    console.log("\n" + "-".repeat(70));
    console.log(`🛠️ Processing ${vaultKey}`);
    console.log("-".repeat(70));

    try {
      if (!vaultInfo.proxyAddress) {
        throw new Error("Vault proxy address not found in deployment file");
      }

      const vault = await ethers.getContractAt(contractName, vaultInfo.proxyAddress);
      const vaultRoles = await vault.roles();
      const currentAdmin = vaultRoles.admin;
      const currentValidator: string = await vault.vaultValidator();

      console.log("Vault Address:", vaultInfo.proxyAddress);
      console.log("Current Admin:", currentAdmin);
      console.log("Current Validator:", currentValidator);

      // Already at target — skip on-chain call (the contract doesn't
      // enforce SameValue but it's still a wasted gas call). Sync the
      // deployment JSON if it's stale.
      if (currentValidator.toLowerCase() === newValidator.toLowerCase()) {
        console.log("✅ Validator already set on-chain. Skipping contract update.");
        if (vaultInfo.validatorAddress !== newValidator) {
          vaultInfo.validatorAddress = newValidator;
          deploymentJsonChanged = true;
          console.log("📝 Deployment JSON validatorAddress field synchronized.");
        }
        results.push({
          vaultKey,
          success: true,
          skipped: true,
          reason: "Validator already set",
        });
        continue;
      }

      // Pre-flight: only the vault admin can change the validator.
      if (signer.address.toLowerCase() !== currentAdmin.toLowerCase()) {
        throw new Error(
          `Signer (${signer.address}) is not the vault admin (${currentAdmin}). Only the admin can change the validator.`
        );
      }

      // Static-call simulation for a clearer revert reason on failure.
      try {
        await protocolConfig.setVaultValidator.staticCall(vaultInfo.proxyAddress, newValidator);
      } catch (staticCallError: any) {
        const detail = staticCallError.reason ?? staticCallError.message ?? "unknown";
        throw new Error(`Static-call simulation reverted: ${detail}`);
      }

      console.log("Updating validator on-chain...");
      const tx = await protocolConfig.setVaultValidator(vaultInfo.proxyAddress, newValidator);
      console.log("Transaction hash:", tx.hash);

      const receipt = await tx.wait();
      console.log("Transaction confirmed in block:", receipt?.blockNumber);

      const updatedValidator: string = await vault.vaultValidator();
      if (updatedValidator.toLowerCase() !== newValidator.toLowerCase()) {
        throw new Error(
          `Validator verification failed. Expected ${newValidator} but got ${updatedValidator}`
        );
      }

      console.log("✅ Validator updated successfully.");

      vaultInfo.validatorAddress = newValidator;
      vaultInfo.validatorUpdatedAt = new Date().toISOString();
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
  console.log("📊 VALIDATOR UPDATE SUMMARY");
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
