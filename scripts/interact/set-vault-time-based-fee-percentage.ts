import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Sets time-based withdrawal fee percentage for one vault.
 *
 * Required ENV variables:
 * - VAULT_KEY: Key of the vault in deployment file
 * - NEW_PERCENTAGE: New time-based fee percentage (1e18 = 100%)
 *
 * Optional ENV variables:
 * - IS_ETH_VAULT=true to target ethVaults, otherwise vaults
 */
async function main() {
  console.log("\n⏱️ Setting Vault Time-Based Fee Percentage...\n");

  const isEthVault = process.env.IS_ETH_VAULT === "true";
  const vaultKey = process.env.VAULT_KEY;
  const newPercentageRaw = process.env.NEW_PERCENTAGE;

  if (!vaultKey || !newPercentageRaw) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("Required:");
    console.log("  VAULT_KEY");
    console.log("  NEW_PERCENTAGE");
    process.exit(1);
  }

  const newPercentage = BigInt(newPercentageRaw);
  if (newPercentage >= 10n ** 18n) {
    console.error("❌ Error: NEW_PERCENTAGE must be < 1e18 (100%)");
    process.exit(1);
  }

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  const protocolConfigAddress = deploymentInfo.contracts?.protocolConfig?.proxyAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: Protocol config not found in deployment file");
    process.exit(1);
  }

  const vaults = isEthVault
    ? deploymentInfo.contracts?.ethVaults
    : deploymentInfo.contracts?.vaults;
  const vaultInfo = vaults?.[vaultKey];
  if (!vaultInfo?.proxyAddress) {
    console.error(`❌ Error: Vault '${vaultKey}' not found or missing proxy address`);
    process.exit(1);
  }

  const vault = await ethers.getContractAt(
    isEthVault ? "EmberETHVault" : "EmberVault",
    vaultInfo.proxyAddress
  );
  const validatorAddress = await vault.vaultValidator();
  const validator = await ethers.getContractAt("EmberVaultValidator", validatorAddress);
  const current = await validator.withdrawalFee(vaultInfo.proxyAddress);

  console.log("Network:", networkName);
  console.log("Signer:", signer.address);
  console.log("Vault Key:", vaultKey);
  console.log("Vault Address:", vaultInfo.proxyAddress);
  console.log("Validator:", validatorAddress);
  console.log("Current Time-Based Fee:", current.timeBasedFeePercentage.toString());
  console.log("New Time-Based Fee:", newPercentage.toString());

  if (current.timeBasedFeePercentage === newPercentage) {
    console.log("✅ Time-based fee percentage already set. No action needed.");
    process.exit(0);
  }

  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);
  const tx = await protocolConfig.updateVaultTimeBasedFeePercentage(
    vaultInfo.proxyAddress,
    newPercentage
  );
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  const updated = await validator.withdrawalFee(vaultInfo.proxyAddress);
  if (updated.timeBasedFeePercentage !== newPercentage) {
    console.error("❌ Verification failed for time-based fee percentage update");
    process.exit(1);
  }

  console.log(
    "✅ Time-based fee percentage updated successfully:",
    updated.timeBasedFeePercentage.toString()
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
