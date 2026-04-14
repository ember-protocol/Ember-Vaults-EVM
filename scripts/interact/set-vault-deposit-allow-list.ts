import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Sets deposit allow list status for one user on one vault.
 *
 * Required ENV variables:
 * - VAULT_KEY: Key of the vault in deployment file
 * - USER_ADDRESS: User address to update
 * - STATUS: true or false
 *
 * Optional ENV variables:
 * - IS_ETH_VAULT=true to target ethVaults, otherwise vaults
 */
async function main() {
  console.log("\n📝 Setting Vault Deposit Allow List Status...\n");

  const isEthVault = process.env.IS_ETH_VAULT === "true";
  const vaultKey = process.env.VAULT_KEY;
  const userAddress = process.env.USER_ADDRESS;
  const statusRaw = process.env.STATUS;

  if (!vaultKey || !userAddress || statusRaw === undefined) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("Required:");
    console.log("  VAULT_KEY");
    console.log("  USER_ADDRESS");
    console.log("  STATUS (true|false)");
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
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);

  const userAddresses = userAddress.split(",").map((addr) => addr.trim());

  for (const userAddress of userAddresses) {
    if (!ethers.isAddress(userAddress)) {
      console.error("❌ Error: Invalid USER_ADDRESS");
      process.exit(1);
    }

    const currentStatus = await validator.depositAllowList(vaultInfo.proxyAddress, userAddress);

    console.log("Network:", networkName);
    console.log("Signer:", signer.address);
    console.log("Vault Key:", vaultKey);
    console.log("Vault Address:", vaultInfo.proxyAddress);
    console.log("Validator:", validatorAddress);
    console.log("User:", userAddress);
    console.log("Current Status:", currentStatus);
    console.log("New Status:", statusRaw.toLowerCase() === "true");

    if (currentStatus === (statusRaw.toLowerCase() === "true")) {
      console.log("✅ Deposit allow list status already set. No action needed.");
      continue;
    }

    const tx = await protocolConfig.setVaultDepositAllowList(
      vaultInfo.proxyAddress,
      userAddress,
      statusRaw.toLowerCase() === "true"
    );
    console.log("Transaction hash:", tx.hash);

    const receipt = await tx.wait();
    console.log("Transaction confirmed in block:", receipt?.blockNumber);

    const updatedStatus = await validator.depositAllowList(vaultInfo.proxyAddress, userAddress);
    if (updatedStatus !== (statusRaw.toLowerCase() === "true")) {
      console.error("❌ Verification failed for deposit allow list update");
      process.exit(1);
    }

    console.log("✅ Deposit allow list status updated successfully:", updatedStatus);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
