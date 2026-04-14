import { ethers } from "hardhat";
import * as fs from "fs";

type ProcessedAddressesByJob = Record<string, Record<string, boolean>>;

const DEFAULT_PROCESSED_FILE_PATH =
  "./scripts/interact/set-vault-deposit-allow-list.processed-batched.json";

function loadProcessedAddresses(filePath: string): ProcessedAddressesByJob {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) {
      return {};
    }
    return JSON.parse(content) as ProcessedAddressesByJob;
  } catch (error) {
    console.warn(`⚠️ Could not read processed addresses file (${filePath}). Starting fresh.`);
    console.warn(error);
    return {};
  }
}

function saveProcessedAddresses(filePath: string, data: ProcessedAddressesByJob): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function bumpByBps(value: bigint, bps: number): bigint {
  return (value * BigInt(10_000 + bps)) / 10_000n;
}

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
 * - BATCH_SIZE=number of txs to submit concurrently using local nonces (default: 10)
 */
async function main() {
  console.log("\n📝 Setting Vault Deposit Allow List Status...\n");

  const isEthVault = process.env.IS_ETH_VAULT === "true";
  const vaultKey = process.env.VAULT_KEY;
  const userAddress = process.env.USER_ADDRESS;
  const statusRaw = process.env.STATUS;
  const batchSizeRaw = process.env.BATCH_SIZE;
  const feeBumpBpsRaw = process.env.FEE_BUMP_BPS;
  const processedFilePath = process.env.PROCESSED_FILE_PATH ?? DEFAULT_PROCESSED_FILE_PATH;

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

  const normalizedStatusRaw = statusRaw.toLowerCase();
  if (normalizedStatusRaw !== "true" && normalizedStatusRaw !== "false") {
    console.error("❌ Error: STATUS must be true or false");
    process.exit(1);
  }
  const status = normalizedStatusRaw === "true";
  const batchSize = batchSizeRaw ? Number(batchSizeRaw) : 10;
  const feeBumpBps = feeBumpBpsRaw ? Number(feeBumpBpsRaw) : 2500;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    console.error("❌ Error: BATCH_SIZE must be a positive integer");
    process.exit(1);
  }
  if (!Number.isInteger(feeBumpBps) || feeBumpBps < 0) {
    console.error("❌ Error: FEE_BUMP_BPS must be a non-negative integer");
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

  // Keep per-job tracking so runs for different networks/vaults/statuses don't clash.
  const processedByJob = loadProcessedAddresses(processedFilePath);
  const jobKey = `${networkName}:${isEthVault ? "ethVault" : "vault"}:${vaultKey}:${status}`;
  const processedAddresses = processedByJob[jobKey] ?? {};
  processedByJob[jobKey] = processedAddresses;

  console.log("Processed file:", processedFilePath);
  console.log("Job key:", jobKey);
  console.log("Already processed:", Object.keys(processedAddresses).length);
  console.log("Batch size:", batchSize);
  console.log("Fee bump (bps):", feeBumpBps);

  // const userAddresses = userAddress.split(",").map((addr) => addr.trim());
  const userAddresses = [""];

  console.log("Network:", networkName);
  console.log("Signer:", signer.address);
  console.log("Vault Key:", vaultKey);
  console.log("Vault Address:", vaultInfo.proxyAddress);
  console.log("Validator:", validatorAddress);
  console.log("New Status:", status);

  let nextNonce = await ethers.provider.getTransactionCount(signer.address, "pending");

  for (let i = 0; i < userAddresses.length; i += batchSize) {
    const pendingNonce = await ethers.provider.getTransactionCount(signer.address, "pending");
    if (pendingNonce > nextNonce) {
      nextNonce = pendingNonce;
    }

    const batch = userAddresses.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    console.log(`\n🚀 Processing batch ${batchNumber} with ${batch.length} addresses`);

    const toSend: Array<{ userAddress: string; normalizedUserAddress: string }> = [];

    for (const userAddress of batch) {
      if (!ethers.isAddress(userAddress)) {
        console.error("❌ Error: Invalid USER_ADDRESS", userAddress);
        process.exit(1);
      }

      const normalizedUserAddress = userAddress.toLowerCase();
      if (processedAddresses[normalizedUserAddress]) {
        console.log(`⏭️ Skipping already processed address: ${userAddress}`);
        continue;
      }

      const currentStatus = await validator.depositAllowList(vaultInfo.proxyAddress, userAddress);
      console.log("User:", userAddress, "Current Status:", currentStatus);

      if (currentStatus === status) {
        console.log("✅ Deposit allow list status already set. No action needed.");
        processedAddresses[normalizedUserAddress] = true;
        saveProcessedAddresses(processedFilePath, processedByJob);
        continue;
      }

      toSend.push({ userAddress, normalizedUserAddress });
    }

    const txPromises = toSend.map(({ userAddress, normalizedUserAddress }, index) =>
      (async () => {
        const nonce = nextNonce + index;
        const feeData = await ethers.provider.getFeeData();
        const txOverrides: Record<string, bigint | number> = { nonce };

        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
          txOverrides.maxFeePerGas = bumpByBps(feeData.maxFeePerGas, feeBumpBps);
          txOverrides.maxPriorityFeePerGas = bumpByBps(feeData.maxPriorityFeePerGas, feeBumpBps);
        } else if (feeData.gasPrice) {
          txOverrides.gasPrice = bumpByBps(feeData.gasPrice, feeBumpBps);
        }

        await new Promise((resolve) => setTimeout(resolve, index * 100)); // Stagger transactions by 100ms
        let tx;
        try {
          tx = await protocolConfig.setVaultDepositAllowList(
            vaultInfo.proxyAddress,
            userAddress,
            status,
            txOverrides
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
          if (!message.includes("replacement transaction underpriced")) {
            throw error;
          }

          console.warn(
            `⚠️ Underpriced replacement for nonce ${nonce}. Retrying with higher fee bump...`
          );

          const retryBumpBps = feeBumpBps + 2000;
          const retryFeeData = await ethers.provider.getFeeData();
          const retryOverrides: Record<string, bigint | number> = { nonce };

          if (retryFeeData.maxFeePerGas && retryFeeData.maxPriorityFeePerGas) {
            retryOverrides.maxFeePerGas = bumpByBps(retryFeeData.maxFeePerGas, retryBumpBps);
            retryOverrides.maxPriorityFeePerGas = bumpByBps(
              retryFeeData.maxPriorityFeePerGas,
              retryBumpBps
            );
          } else if (retryFeeData.gasPrice) {
            retryOverrides.gasPrice = bumpByBps(retryFeeData.gasPrice, retryBumpBps);
          }

          tx = await protocolConfig.setVaultDepositAllowList(
            vaultInfo.proxyAddress,
            userAddress,
            status,
            retryOverrides
          );
        }

        console.log("Transaction hash:", tx.hash, "User:", userAddress, "Nonce:", nonce);

        const receipt = await tx.wait();
        console.log("Transaction confirmed in block:", receipt?.blockNumber, "User:", userAddress);

        const updatedStatus = await validator.depositAllowList(vaultInfo.proxyAddress, userAddress);
        if (updatedStatus !== status) {
          throw new Error(`Verification failed for deposit allow list update: ${userAddress}`);
        }

        processedAddresses[normalizedUserAddress] = true;
        saveProcessedAddresses(processedFilePath, processedByJob);
        console.log(
          "✅ Deposit allow list status updated successfully:",
          updatedStatus,
          "User:",
          userAddress
        );
      })()
    );

    nextNonce += toSend.length;
    await Promise.all(txPromises);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
