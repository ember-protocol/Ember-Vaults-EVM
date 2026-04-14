/**
 * Verify a specific vault (both implementation and proxy)
 *
 * This script verifies both the implementation and proxy contracts
 * for a specific vault from the deployment file.
 *
 * Usage:
 *   ETHERSCAN_API_KEY=your_api_key yarn hardhat run scripts/verify/verify-vault.ts --network mainnet
 *
 *   When prompted, enter the vault name (e.g., "emberUdl", "emberYn", etc.)
 */

import { run } from "hardhat";
import * as fs from "fs";
import readline from "readline";

interface VaultDeployment {
  proxyAddress: string;
  implementationAddress: string;
  name: string;
  receiptTokenSymbol: string;
  version: string;
}

interface Deployment {
  network: string;
  chainId: string;
  contracts: {
    vaults: {
      [key: string]: VaultDeployment;
    };
  };
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

async function verifyContract(
  address: string,
  contractName: string,
  constructorArguments: any[] = []
): Promise<void> {
  console.log(`\n🔍 Verifying ${contractName} at ${address}...`);

  try {
    await run("verify:verify", {
      address: address,
      constructorArguments: constructorArguments,
    });

    console.log(`✅ ${contractName} verified successfully!`);
  } catch (error: any) {
    if (error.message.includes("Already Verified")) {
      console.log(`✓ ${contractName} already verified`);
    } else {
      console.error(`❌ Error verifying ${contractName}:`, error.message);
      throw error;
    }
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Vault Verification Tool");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Load deployment data
  const deploymentPath =
    "/Users/mac/Desktop/firefly-repos/ember-vaults-evm-smart-contracts/deployments/mainnet-deployment.json";

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Deployment file not found at ${deploymentPath}`);
  }

  const deployment: Deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  // List available vaults
  console.log("Available vaults:");
  Object.entries(deployment.contracts.vaults).forEach(([key, vault]) => {
    console.log(`  - ${key}: ${vault.name} (${vault.receiptTokenSymbol})`);
  });

  const vaultKey = await question("\nEnter vault key to verify: ");
  rl.close();

  const vault = deployment.contracts.vaults[vaultKey];

  if (!vault) {
    throw new Error(`Vault "${vaultKey}" not found in deployment file`);
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Verifying: ${vault.name} (${vault.receiptTokenSymbol})`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`\nVersion: ${vault.version}`);
  console.log(`Implementation: ${vault.implementationAddress}`);
  console.log(`Proxy: ${vault.proxyAddress}\n`);

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Verify implementation
  await verifyContract(vault.implementationAddress, `${vault.name} Implementation`);

  // Wait to avoid rate limiting
  await delay(2000);

  // Verify proxy
  await verifyContract(vault.proxyAddress, `${vault.name} Proxy`, [
    vault.implementationAddress,
    "0x",
  ]);

  console.log("\n✅ Vault verification complete!\n");
  console.log(`View on Etherscan:`);
  console.log(`  Implementation: https://etherscan.io/address/${vault.implementationAddress}#code`);
  console.log(`  Proxy: https://etherscan.io/address/${vault.proxyAddress}#code`);
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
