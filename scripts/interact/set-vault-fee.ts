import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Sets the platform (management) fee percentage for one vault.
 *
 * Required ENV variables:
 * - VAULT_KEY: Key of the vault in deployment file
 * - NEW_PERCENTAGE: New platform fee percentage (capped by protocolConfig.maxFeePercentage)
 *
 * Optional ENV variables:
 * - IS_ETH_VAULT=true to target ethVaults, otherwise vaults
 */
async function main() {
  console.log("\n💸 Setting Vault Platform Fee Percentage...\n");

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
  const current = await vault.platformFee();

  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);
  // updateVaultFeePercentage reverts with InvalidFeePercentage when the new value
  // exceeds protocolConfig.maxFeePercentage — validate up front so a bad value
  // fails locally rather than as an opaque on-chain revert.
  const maxFeePercentage = (await protocolConfig.protocolConfig()).maxFeePercentage;
  if (newPercentage > maxFeePercentage) {
    console.error(
      `❌ Error: NEW_PERCENTAGE (${newPercentage.toString()}) exceeds protocol maxFeePercentage (${maxFeePercentage.toString()})`
    );
    process.exit(1);
  }

  console.log("Network:", networkName);
  console.log("Signer:", signer.address);
  console.log("Vault Key:", vaultKey);
  console.log("Vault Address:", vaultInfo.proxyAddress);
  console.log("Protocol Config:", protocolConfigAddress);
  console.log("Max Fee Percentage:", maxFeePercentage.toString());
  console.log("Current Platform Fee:", current.platformFeePercentage.toString());
  console.log("New Platform Fee:", newPercentage.toString());

  if (current.platformFeePercentage === newPercentage) {
    console.log("✅ Platform fee already set. No action needed.");
    process.exit(0);
  }

  const tx = await protocolConfig.updateVaultFeePercentage(vaultInfo.proxyAddress, newPercentage);
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  const updated = await vault.platformFee();
  if (updated.platformFeePercentage !== newPercentage) {
    console.error("❌ Verification failed for platform fee update");
    process.exit(1);
  }

  console.log("✅ Platform fee updated successfully:", updated.platformFeePercentage.toString());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
