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
  [key: string]: unknown;
};

/**
 * Sets the deployed validator contract on standard vaults or ETH vaults.
 *
 * Usage:
 *   yarn interact:set-vault-validator --network <NETWORK>
 *   VAULT_KEYS=<VAULT_KEY_1>,<VAULT_KEY_2> yarn interact:set-vault-validator --network <NETWORK>
 *   IS_ETH_VAULT=true yarn interact:set-vault-validator --network <NETWORK>
 *
 * Environment Variables:
 *   IS_ETH_VAULT - Set to true to target ethVaults, otherwise targets vaults
 *   VAULT_KEYS  - Comma-separated vault keys from deployment JSON (optional)
 *
 * Notes:
 * - The validator address is read from deploymentInfo.contracts.vaultValidator.proxyAddress.
 * - The script exits if no validator is defined in the deployment JSON.
 * - If the current validator already matches, the on-chain update is skipped.
 * - The validator address is written back to each targeted vault entry in the deployment JSON.
 * - If VAULT_KEYS is omitted, the script processes all vaults in the selected collection.
 */
async function main() {
  console.log("\n🛡️ Setting Vault Validator...\n");

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

  const validatorAddress = deploymentInfo.contracts?.vaultValidator?.proxyAddress;
  if (!validatorAddress) {
    console.error("❌ Error: Vault validator not found in deployment file!");
    console.log("Deploy the validator first using: yarn deploy:vault-validator");
    process.exit(1);
  }

  const vaults = isEthVault
    ? deploymentInfo.contracts?.ethVaults
    : deploymentInfo.contracts?.vaults;
  if (!vaults || Object.keys(vaults).length === 0) {
    console.error("❌ Error: No vaults found in deployment file!");
    process.exit(1);
  }

  const contractName = isEthVault ? "EmberETHVault" : "EmberVault";

  const vaultKeysEnv = process.env.VAULT_KEYS;
  let vaultKeysToProcess: string[];

  if (vaultKeysEnv) {
    vaultKeysToProcess = vaultKeysEnv.split(",").map((key) => key.trim());
    console.log("🎯 Processing specific vaults:", vaultKeysToProcess.join(", "));
  } else {
    vaultKeysToProcess = Object.keys(vaults);
    console.log("🎯 Processing ALL vaults:", vaultKeysToProcess.join(", "));
  }

  for (const vaultKey of vaultKeysToProcess) {
    if (!vaults[vaultKey]) {
      console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!`);
      console.log("Available vaults:");
      Object.keys(vaults).forEach((key) => {
        console.log(`  - ${key}`);
      });
      process.exit(1);
    }
  }

  console.log("Protocol Config:", protocolConfigAddress);
  console.log("Target Validator:", validatorAddress);
  console.log("Vault Type:", isEthVault ? "ethVaults" : "vaults");

  console.log("\n" + "=".repeat(70));
  console.log("📋 Vaults to Process:");
  console.log("=".repeat(70));
  for (const vaultKey of vaultKeysToProcess) {
    const vaultInfo = vaults[vaultKey];
    console.log(`\n${vaultKey}:`);
    console.log(`  Type: ${isEthVault ? "ETH" : "Standard"}`);
    console.log(`  Name: ${vaultInfo.name || "Unknown"}`);
    console.log(`  Address: ${vaultInfo.proxyAddress || "Missing"}`);
    console.log(`  Stored Validator: ${String(vaultInfo.validatorAddress || "Not set")}`);
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
      const currentValidator = await vault.vaultValidator();

      console.log("Vault Address:", vaultInfo.proxyAddress);
      console.log("Current Validator:", currentValidator);
      console.log("Target Validator:", validatorAddress);

      const shouldUpdateOnChain = currentValidator.toLowerCase() !== validatorAddress.toLowerCase();

      if (!shouldUpdateOnChain) {
        console.log("✅ Validator already set on-chain. Skipping contract update.");
      } else {
        console.log("Updating validator on-chain...");
        const tx = await protocolConfig.setVaultValidator(vaultInfo.proxyAddress, validatorAddress);
        console.log("Transaction hash:", tx.hash);

        const receipt = await tx.wait();
        console.log("Transaction confirmed in block:", receipt?.blockNumber);

        const updatedValidator = await vault.vaultValidator();
        if (updatedValidator.toLowerCase() !== validatorAddress.toLowerCase()) {
          throw new Error(
            `Validator verification failed. Expected ${validatorAddress} but got ${updatedValidator}`
          );
        }

        console.log("✅ Validator updated successfully.");

        results.push({
          vaultKey,
          success: true,
          txHash: tx.hash,
          blockNumber: receipt?.blockNumber,
        });
      }

      if (vaultInfo.validatorAddress !== validatorAddress) {
        vaultInfo.validatorAddress = validatorAddress;
        deploymentJsonChanged = true;
        console.log("📝 Deployment JSON validator address synchronized.");
      }

      if (!shouldUpdateOnChain) {
        results.push({
          vaultKey,
          success: true,
          skipped: true,
          reason: "Validator already set",
        });
      }
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
    console.log("\nℹ️ Deployment file already had the expected validator addresses.");
  }

  const successful = results.filter((result) => result.success && !result.skipped);
  const skipped = results.filter((result) => result.success && result.skipped);
  const failed = results.filter((result) => !result.success);

  console.log("\n" + "=".repeat(70));
  console.log("📊 VALIDATOR UPDATE SUMMARY");
  console.log("=".repeat(70));
  console.log(`\n✅ Updated: ${successful.length}`);
  console.log(`⏭️ Skipped: ${skipped.length}`);
  console.log(`❌ Failed: ${failed.length}`);

  for (const result of successful) {
    console.log(`  - ${result.vaultKey} -> block ${String(result.blockNumber || "n/a")}`);
  }

  for (const result of skipped) {
    console.log(`  - ${result.vaultKey} -> ${result.reason}`);
  }

  for (const result of failed) {
    console.log(`  - ${result.vaultKey} -> ${result.error}`);
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
