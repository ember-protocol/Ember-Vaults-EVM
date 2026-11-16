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
    timelocks?: {
      admin?: {
        address?: string;
      };
    };
    vaults?: Record<string, VaultDeploymentRecord>;
    ethVaults?: Record<string, VaultDeploymentRecord>;
    atomicLiquidityVaults?: Record<string, VaultDeploymentRecord>;
  };
};

type VaultDeploymentRecord = {
  proxyAddress?: string;
  name?: string;
  validatorAddress?: string;
  admin?: string;
  protocolConfig?: string;
  [key: string]: unknown;
};

const VAULT_COLLECTIONS = ["vaults", "ethVaults", "atomicLiquidityVaults"] as const;
type VaultCollection = (typeof VAULT_COLLECTIONS)[number];

/** Hardhat artifact name backing each deployment-JSON collection. */
const CONTRACT_NAME_BY_COLLECTION: Record<VaultCollection, string> = {
  vaults: "EmberVault",
  ethVaults: "EmberETHVault",
  atomicLiquidityVaults: "AtomicLiquidity",
};

/**
 * Resolves the deployment-JSON collection to operate on. VAULT_TYPE is the
 * modern knob; IS_ETH_VAULT is kept working so existing runbooks don't break.
 */
function resolveVaultCollection(): VaultCollection {
  const raw = process.env.VAULT_TYPE?.trim();

  if (!raw) {
    return process.env.IS_ETH_VAULT === "true" ? "ethVaults" : "vaults";
  }

  switch (raw.toLowerCase()) {
    case "vault":
    case "vaults":
      return "vaults";
    case "eth":
    case "ethvault":
    case "ethvaults":
      return "ethVaults";
    case "alv":
    case "atomic":
    case "atomicvault":
    case "atomicvaults":
    case "atomicliquidity":
    case "atomicliquidityvault":
    case "atomicliquidityvaults":
      return "atomicLiquidityVaults";
    default:
      console.error(`❌ Error: Unknown VAULT_TYPE '${raw}'.`);
      console.log(`Valid values: ${VAULT_COLLECTIONS.join(", ")}`);
      console.log("Aliases: eth, atomic, alv");
      process.exit(1);
  }
}

/**
 * Sets the deployed validator contract on standard vaults, ETH vaults or
 * atomic liquidity vaults.
 *
 * Usage:
 *   yarn interact:set-vault-validator --network <NETWORK>
 *   VAULT_KEYS=<VAULT_KEY_1>,<VAULT_KEY_2> yarn interact:set-vault-validator --network <NETWORK>
 *   VAULT_TYPE=atomicLiquidityVaults yarn interact:set-vault-validator --network <NETWORK>
 *   IS_ETH_VAULT=true yarn interact:set-vault-validator --network <NETWORK>
 *
 * Environment Variables:
 *   VAULT_TYPE   - Collection to target: vaults (default) | ethVaults |
 *                  atomicLiquidityVaults. Aliases: eth, atomic, alv
 *   IS_ETH_VAULT - Legacy flag, "true" is equivalent to VAULT_TYPE=ethVaults
 *   VAULT_KEYS   - Comma-separated vault keys from deployment JSON (optional)
 *
 * Notes:
 * - EmberVault, EmberETHVault and AtomicLiquidity all expose the same
 *   `setVaultValidator(caller, validator)` behind `onlyProtocolConfig
 *   onlyAdmin(caller)`, so every collection routes through
 *   EmberProtocolConfig.setVaultValidator identically.
 * - The validator address is read from deploymentInfo.contracts.vaultValidator.proxyAddress.
 * - The script exits if no validator is defined in the deployment JSON.
 * - Only the vault ADMIN can set the validator, and admin is per-vault. The
 *   expected admin is taken from the deployment JSON (`<vault>.admin`, falling
 *   back to `timelocks.admin.address`) and the signer is checked against it
 *   before sending — atomic vaults in particular are commonly admin'd by a
 *   different account than the classic vaults on the same network, so this
 *   fails fast with a readable message instead of an opaque revert.
 * - Each call is routed through the vault's own `protocolConfig` when the
 *   deployment JSON records one, since `onlyProtocolConfig` checks the address
 *   the vault itself stores.
 * - If the current validator already matches, the on-chain update is skipped.
 * - The validator address is written back to each targeted vault entry in the deployment JSON.
 * - If VAULT_KEYS is omitted, the script processes all vaults in the selected collection.
 */
async function main() {
  console.log("\n🛡️ Setting Vault Validator...\n");

  const vaultCollection = resolveVaultCollection();

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

  // Network-wide default. Individual vaults may record their own (atomic
  // vaults are deployed separately and could point elsewhere), so this is only
  // the fallback for entries that don't carry one.
  const defaultProtocolConfigAddress = deploymentInfo.contracts?.protocolConfig?.proxyAddress;
  if (!defaultProtocolConfigAddress) {
    console.error("❌ Error: Protocol config not found in deployment file!");
    process.exit(1);
  }

  const validatorAddress = deploymentInfo.contracts?.vaultValidator?.proxyAddress;
  if (!validatorAddress) {
    console.error("❌ Error: Vault validator not found in deployment file!");
    console.log("Deploy the validator first using: yarn deploy:vault-validator");
    process.exit(1);
  }

  // Fallback admin for vault entries that don't record an `admin` of their own.
  const timelockAdminAddress = deploymentInfo.contracts?.timelocks?.admin?.address;

  const vaults = deploymentInfo.contracts?.[vaultCollection];
  if (!vaults || Object.keys(vaults).length === 0) {
    console.error(`❌ Error: No ${vaultCollection} found in deployment file!`);
    const populated = VAULT_COLLECTIONS.filter(
      (collection) => Object.keys(deploymentInfo.contracts?.[collection] ?? {}).length > 0
    );
    if (populated.length > 0) {
      console.log("Collections present in this deployment:", populated.join(", "));
    }
    process.exit(1);
  }

  const contractName = CONTRACT_NAME_BY_COLLECTION[vaultCollection];

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

  console.log("Default Protocol Config:", defaultProtocolConfigAddress);
  console.log("Target Validator:", validatorAddress);
  console.log("Vault Type:", vaultCollection);
  console.log("Vault Contract:", contractName);
  console.log("Timelock Admin:", timelockAdminAddress || "(not in deployment)");

  console.log("\n" + "=".repeat(70));
  console.log("📋 Vaults to Process:");
  console.log("=".repeat(70));
  for (const vaultKey of vaultKeysToProcess) {
    const vaultInfo = vaults[vaultKey];
    console.log(`\n${vaultKey}:`);
    console.log(`  Type: ${vaultCollection}`);
    console.log(`  Name: ${vaultInfo.name || "Unknown"}`);
    console.log(`  Address: ${vaultInfo.proxyAddress || "Missing"}`);
    console.log(`  Stored Validator: ${String(vaultInfo.validatorAddress || "Not set")}`);
    console.log(
      `  Expected Admin: ${String(vaultInfo.admin || timelockAdminAddress || "Not set")}`
    );
  }
  console.log("\n" + "=".repeat(70));

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

      // `onlyProtocolConfig` compares against the config the vault itself
      // stores, so prefer the vault's own entry over the network default.
      const protocolConfigAddress = vaultInfo.protocolConfig || defaultProtocolConfigAddress;
      if (protocolConfigAddress.toLowerCase() !== defaultProtocolConfigAddress.toLowerCase()) {
        console.log(
          `⚠️  Vault stores protocol config ${protocolConfigAddress}, which differs from the network default ${defaultProtocolConfigAddress}. Routing through the vault's own.`
        );
      }

      console.log("Vault Address:", vaultInfo.proxyAddress);
      console.log("Protocol Config:", protocolConfigAddress);
      console.log("Current Validator:", currentValidator);
      console.log("Target Validator:", validatorAddress);

      const shouldUpdateOnChain = currentValidator.toLowerCase() !== validatorAddress.toLowerCase();

      if (!shouldUpdateOnChain) {
        console.log("✅ Validator already set on-chain. Skipping contract update.");
      } else {
        // Only the vault admin can set the validator, and admin is per-vault.
        // The deployment JSON is the declared source of truth; the live value
        // is read back so drift is reported rather than silently trusted.
        const expectedAdmin = vaultInfo.admin || timelockAdminAddress;
        const onChainAdmin: string = (await vault.roles()).admin;

        if (expectedAdmin && onChainAdmin.toLowerCase() !== expectedAdmin.toLowerCase()) {
          console.log(
            `⚠️  Admin drift: deployment JSON says ${expectedAdmin} but the vault reports ${onChainAdmin}. Trusting the on-chain value for the pre-flight check.`
          );
        }

        console.log("Vault Admin:", onChainAdmin);

        if (signer.address.toLowerCase() !== onChainAdmin.toLowerCase()) {
          throw new Error(
            `Signer (${signer.address}) is not the vault admin (${onChainAdmin}). Only the admin can set the validator.`
          );
        }

        const protocolConfig = await ethers.getContractAt(
          "EmberProtocolConfig",
          protocolConfigAddress
        );

        console.log("Updating validator on-chain...");
        const tx = await protocolConfig.setVaultValidator(vaultInfo.proxyAddress, validatorAddress);
        console.log("Transaction hash:", tx.hash);

        const receipt = await tx.wait();
        console.log("Transaction confirmed in block:", receipt?.blockNumber);

        // Some RPCs (base, Pharos) lag in reflecting the just-mined tx, so the
        // verification read can return the stale (pre-update) validator. Re-read
        // until it reflects the update before deciding success/failure.
        let updatedValidator = await vault.vaultValidator();
        for (
          let attempt = 1;
          attempt < 15 && updatedValidator.toLowerCase() !== validatorAddress.toLowerCase();
          attempt++
        ) {
          console.log(`   ⏳ validator read not reflected yet, re-checking (${attempt}/15)...`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          updatedValidator = await vault.vaultValidator();
        }
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
