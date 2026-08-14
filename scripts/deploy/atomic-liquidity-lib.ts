import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Deploys AtomicLiquidityLib — the external library that AtomicLiquidity links to for the
 * heavy code paths (EmberShare swap, holdback release, redeem-collected forwarder).
 *
 * Run this BEFORE deploy:atomic-liquidity. The deployed library address is recorded in the
 * network deployment JSON so the AtomicLiquidity deploy/upgrade scripts can find and link
 * against it without redeployment.
 *
 * Behavior:
 *   • If the deployment file already records a library address, prints it and exits with
 *     a non-zero status — re-use is the default. Pass FORCE_REDEPLOY_LIB=true to redeploy.
 *   • Otherwise deploys, records, and prints the new address.
 *
 * Optional ENV:
 *   FORCE_REDEPLOY_LIB=true   Deploy a new library even if one is already recorded.
 */
async function main() {
  console.log("\n📚 Deploying AtomicLiquidityLib...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  const deploymentFileName = `./deployments/${network.name}-deployment.json`;
  let deploymentInfo: any = {
    network: network.name,
    chainId: network.chainId.toString(),
    contracts: {},
  };

  if (fs.existsSync(deploymentFileName)) {
    console.log("📂 Loading existing deployment file:", deploymentFileName);
    deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  } else {
    console.log("📂 Creating new deployment file:", deploymentFileName);
    if (!fs.existsSync("./deployments")) {
      fs.mkdirSync("./deployments");
    }
  }

  const force = process.env.FORCE_REDEPLOY_LIB === "true";
  const existing = deploymentInfo.contracts.atomicLiquidityLib;

  if (existing && !force) {
    console.log("\n⚠️  AtomicLiquidityLib already deployed at:", existing.address);
    console.log("    Pass FORCE_REDEPLOY_LIB=true to redeploy.");
    console.log("    Re-using the existing library address is the recommended path.");
    process.exit(0);
  }

  console.log("\n📦 Deploying AtomicLiquidityLib bytecode...");
  // AtomicLiquidityLib itself links to WithdrawalQueueLib; resolve its address from the
  // deployment file (deploy:vault-libraries must have run first) and pass the link.
  const withdrawalQueueLibAddress =
    process.env.WITHDRAWAL_QUEUE_LIB_ADDRESS ||
    deploymentInfo.contracts.withdrawalQueueLib?.address;
  if (!withdrawalQueueLibAddress) {
    console.error(
      "❌ WithdrawalQueueLib address not found. Run yarn deploy:vault-libraries first."
    );
    process.exit(1);
  }
  const factory = await ethers.getContractFactory("AtomicLiquidityLib", {
    libraries: {
      "contracts/libraries/WithdrawalQueueLib.sol:WithdrawalQueueLib": withdrawalQueueLibAddress,
    },
  });
  const lib = await factory.deploy();
  await lib.waitForDeployment();

  const libAddress = await lib.getAddress();
  console.log("✅ AtomicLiquidityLib deployed to:", libAddress);

  const deploymentTx = lib.deploymentTransaction();
  let deploymentBlockNumber = 0;
  if (deploymentTx) {
    const receipt = await deploymentTx.wait();
    deploymentBlockNumber = receipt?.blockNumber || 0;
    console.log("📦 Deployed in block:", deploymentBlockNumber);
  }

  // The deployed bytecode size is informative: it's the slice the linked AtomicLiquidity
  // implementation does NOT have to carry under the EIP-170 24,576-byte limit.
  const code = await ethers.provider.getCode(libAddress);
  const codeSize = (code.length - 2) / 2;
  console.log("📏 Library deployed bytecode size:", codeSize, "bytes");

  if (existing) {
    console.log("\n📝 Replacing previous library record:");
    console.log("    Old address:", existing.address);
    console.log("    New address:", libAddress);
    console.log("    ⚠️  AtomicLiquidity proxies still pointing at the old library will not");
    console.log("        pick up the new bytecode until they are upgraded with");
    console.log(
      "        ATOMIC_LIQUIDITY_LIB_ADDRESS=" + libAddress + " yarn upgrade:atomic-liquidity"
    );
  }

  deploymentInfo.contracts.atomicLiquidityLib = {
    address: libAddress,
    deployerAddress: deployer.address,
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber: deploymentBlockNumber,
    bytecodeSize: codeSize,
  };

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 AtomicLiquidityLib Deployment Complete!");
  console.log("=".repeat(70));
  console.log("\nLibrary Address:", libAddress);
  console.log("Bytecode Size:", codeSize, "bytes");
  console.log("Deployment Block:", deploymentBlockNumber);
  console.log("\n💡 Next step: deploy or upgrade an AtomicLiquidity proxy. The deploy/upgrade");
  console.log("    scripts will pick up this library address from the deployment file");
  console.log("    automatically, or accept ATOMIC_LIQUIDITY_LIB_ADDRESS to override.");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
