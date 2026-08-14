import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Deploys the shared external libraries that AtomicLiquidity and EmberETHVault link to:
 *   • VaultPlatformFeeLib  — time-based platform-fee accrual (charge-before-burn)
 *   • WithdrawalQueueLib   — per-account FIFO bookkeeping (add/remove pending requests)
 *
 * These are hoisted out of the vault implementations to keep them under EIP-170's
 * 24,576-byte runtime-code limit. Run this BEFORE deploy:atomic-liquidity / deploy:eth-vault
 * (and before any upgrade that touches those impls) on every chain.
 *
 * Behavior:
 *   • For each library, reuses the address recorded in the deployment file unless
 *     FORCE_REDEPLOY_LIBS=true is set. Re-using is the default — these libraries hold
 *     no state and their addresses are baked into the implementation bytecode, so
 *     redeploying them is only meaningful when their bytecode actually changes (and
 *     even then, the existing proxies stay on the old library until their implementations
 *     are upgraded with the new linker setting).
 *
 *   • Records each deployed library under deploymentInfo.contracts.<libKey> so the
 *     deploy/upgrade scripts can pick them up automatically.
 *
 * Optional ENV:
 *   FORCE_REDEPLOY_LIBS=true   Redeploy each library even if one is already recorded.
 *   ONLY_LIB=VaultPlatformFeeLib|WithdrawalQueueLib
 *                              Deploy only the named library (omit to deploy both).
 */

type LibSpec = {
  contractName: string;
  deploymentKey: string; // key under deploymentInfo.contracts
};

const LIBS: LibSpec[] = [
  { contractName: "VaultPlatformFeeLib", deploymentKey: "vaultPlatformFeeLib" },
  { contractName: "WithdrawalQueueLib", deploymentKey: "withdrawalQueueLib" },
];

async function main() {
  console.log("\n📚 Deploying vault libraries (VaultPlatformFeeLib + WithdrawalQueueLib)...\n");

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

  const force = process.env.FORCE_REDEPLOY_LIBS === "true";
  const onlyLib = process.env.ONLY_LIB;

  const targets = onlyLib ? LIBS.filter((l) => l.contractName === onlyLib) : LIBS;
  if (targets.length === 0) {
    console.error(
      `❌ Unknown ONLY_LIB '${onlyLib}'. Valid: ${LIBS.map((l) => l.contractName).join(", ")}`
    );
    process.exit(1);
  }

  const summary: { name: string; address: string; reused: boolean; size: number; block: number }[] =
    [];

  for (const lib of targets) {
    console.log("\n" + "-".repeat(70));
    console.log(`📦 ${lib.contractName}`);
    console.log("-".repeat(70));

    const existing = deploymentInfo.contracts[lib.deploymentKey];

    if (existing && !force) {
      console.log(`⚠️  Already deployed at: ${existing.address}`);
      console.log("    Pass FORCE_REDEPLOY_LIBS=true to redeploy.");
      summary.push({
        name: lib.contractName,
        address: existing.address,
        reused: true,
        size: existing.bytecodeSize || 0,
        block: existing.deploymentBlockNumber || 0,
      });
      continue;
    }

    console.log("Deploying...");
    const factory = await ethers.getContractFactory(lib.contractName);
    const deployed = await factory.deploy();
    await deployed.waitForDeployment();

    const address = await deployed.getAddress();
    const deploymentTx = deployed.deploymentTransaction();
    let blockNumber = 0;
    if (deploymentTx) {
      const receipt = await deploymentTx.wait();
      blockNumber = receipt?.blockNumber || 0;
    }

    const code = await ethers.provider.getCode(address);
    const codeSize = (code.length - 2) / 2;
    console.log(`✅ Deployed to: ${address}`);
    console.log(`📦 Block:       ${blockNumber}`);
    console.log(`📏 Code size:   ${codeSize} bytes`);

    if (existing) {
      console.log("\n📝 Replacing previous library record:");
      console.log("    Old address:", existing.address);
      console.log("    New address:", address);
      console.log("    ⚠️  AtomicLiquidity / EmberETHVault proxies still pointing at the old");
      console.log("        library will not pick up the new bytecode until their implementations");
      console.log("        are upgraded with the new linker setting.");
    }

    deploymentInfo.contracts[lib.deploymentKey] = {
      address,
      deployerAddress: deployer.address,
      deployedAt: new Date().toISOString(),
      deploymentBlockNumber: blockNumber,
      bytecodeSize: codeSize,
    };

    summary.push({
      name: lib.contractName,
      address,
      reused: false,
      size: codeSize,
      block: blockNumber,
    });
  }

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Vault Libraries Deployment Complete!");
  console.log("=".repeat(70));
  for (const s of summary) {
    console.log(`\n${s.name}${s.reused ? "  (reused)" : ""}`);
    console.log("  Address:", s.address);
    console.log("  Size:   ", s.size, "bytes");
    console.log("  Block:  ", s.block);
  }
  console.log("\n💡 Next step: deploy or upgrade AtomicLiquidity / EmberETHVault. The deploy");
  console.log("    and upgrade scripts read these library addresses from the deployment file");
  console.log("    automatically.");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
