import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Deploys an OZ TimelockController that will own all upgradeable contracts.
 *
 * Roles after construction:
 *   - PROPOSER_ROLE  -> [PROPOSER]                 (multisig that can schedule)
 *   - CANCELLER_ROLE -> [PROPOSER]                 (granted alongside proposer)
 *   - EXECUTOR_ROLE  -> [address(0)]               (open: anyone can execute)
 *   - DEFAULT_ADMIN  -> renounced (timelock self-administers)
 *
 * Required ENV variables:
 *   - PROPOSER:  multisig address authorized to schedule operations
 *
 * Optional ENV variables:
 *   - MIN_DELAY: delay in seconds (default 86400 = 24h)
 *
 * Reads/updates ./deployments/<network>-deployment.json (adds `timelock`
 * under `contracts`).
 */
async function main() {
  console.log("\n🕒 Deploying TimelockController...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  const proposer = process.env.PROPOSER;
  if (!proposer || !ethers.isAddress(proposer)) {
    console.error("❌ PROPOSER env var is required (must be a valid address)");
    process.exit(1);
  }
  const minDelay = BigInt(process.env.MIN_DELAY || "86400");

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Deployer:", deployer.address);
  console.log("Proposer (multisig):", proposer);
  console.log("Min delay:", minDelay.toString(), "seconds");
  console.log("Executors: [address(0)] (open execution)");
  console.log("Admin: address(0) (renounced — self-administered)\n");

  const Factory = await ethers.getContractFactory("TimelockController");
  const timelock = await Factory.deploy(
    minDelay,
    [proposer],
    [ethers.ZeroAddress],
    ethers.ZeroAddress
  );
  await timelock.waitForDeployment();

  const address = await timelock.getAddress();
  const deployTx = timelock.deploymentTransaction();
  const deployBlock = deployTx ? (await deployTx.wait())?.blockNumber || 0 : 0;

  console.log("✅ TimelockController deployed:", address);
  console.log("📦 Block:", deployBlock);

  const proposerRole = await timelock.PROPOSER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  const adminRole = await timelock.DEFAULT_ADMIN_ROLE();

  const checks = {
    minDelay: (await timelock.getMinDelay()).toString(),
    proposerHasProposerRole: await timelock.hasRole(proposerRole, proposer),
    proposerHasCancellerRole: await timelock.hasRole(cancellerRole, proposer),
    zeroAddrHasExecutorRole: await timelock.hasRole(executorRole, ethers.ZeroAddress),
    timelockSelfAdmin: await timelock.hasRole(adminRole, address),
    deployerHasAdmin: await timelock.hasRole(adminRole, deployer.address),
  };
  console.log("\nPost-deploy verification:");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v}`);

  if (
    checks.minDelay !== minDelay.toString() ||
    !checks.proposerHasProposerRole ||
    !checks.zeroAddrHasExecutorRole ||
    !checks.timelockSelfAdmin ||
    checks.deployerHasAdmin
  ) {
    console.error("❌ Post-deploy state did not match expectations.");
    process.exit(1);
  }

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  let deploymentInfo: any = {
    network: networkName,
    chainId: network.chainId.toString(),
    contracts: {},
  };
  if (fs.existsSync(deploymentFileName)) {
    deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
    deploymentInfo.contracts = deploymentInfo.contracts || {};
  }
  deploymentInfo.contracts.timelock = {
    address,
    minDelay: minDelay.toString(),
    proposers: [proposer],
    executors: [ethers.ZeroAddress],
    admin: ethers.ZeroAddress,
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber: deployBlock,
  };
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Saved to", deploymentFileName);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
