import { ethers } from "hardhat";
import * as fs from "fs";
import { waitForCode } from "../utils/chain";

/**
 * Deploys an OZ TimelockController that will own all upgradeable contracts.
 *
 * Roles after construction:
 *   - PROPOSER_ROLE  -> [PROPOSER]
 *   - CANCELLER_ROLE -> [CANCELLERS] (default [PROPOSER])
 *   - EXECUTOR_ROLE  -> [EXECUTORS]  (default [address(0)] = open)
 *   - DEFAULT_ADMIN  -> renounced (timelock self-administers)
 *
 * The OZ constructor only accepts `executors` and always grants each proposer
 * the CANCELLER role. To set cancellers explicitly (distinct from proposers)
 * this script deploys with the deployer as a TEMPORARY admin, grants/revokes
 * the desired cancellers, then renounces admin so the timelock self-administers.
 *
 * Required ENV variables:
 *   - PROPOSER:     multisig address authorized to schedule operations
 *   - TIMELOCK_KEY: which timelock this is — "owner" or "admin". The record is
 *                   written to `contracts.timelocks[TIMELOCK_KEY]`.
 *
 * Optional ENV variables:
 *   - MIN_DELAY:    delay in seconds (default 86400 = 24h)
 *   - EXECUTORS:    comma-separated executor addresses (default address(0) =
 *                   open execution). Use address(0) to keep execution open.
 *   - CANCELLERS:   comma-separated canceller addresses (default = [PROPOSER]).
 *
 * Reads/updates ./deployments/<network>-deployment.json.
 */

const ZERO = ethers.ZeroAddress;

/** Parse a comma-separated address list; validates each (address(0) allowed). */
function parseAddressList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || !raw.trim()) return fallback;
  const out = raw
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => (a === "0" || a.toLowerCase() === "0x0" ? ZERO : a));
  for (const a of out) {
    if (!ethers.isAddress(a)) {
      console.error(`❌ Invalid address in list: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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
  const timelockKey = process.env.TIMELOCK_KEY?.trim();
  if (!timelockKey) {
    console.error('❌ TIMELOCK_KEY env var is required (e.g. "owner" or "admin")');
    process.exit(1);
  }

  // Explicit executors (default: open) and cancellers (default: the proposer).
  const executors = parseAddressList(process.env.EXECUTORS, [ZERO]);
  const cancellers = parseAddressList(process.env.CANCELLERS, [proposer]);

  // The constructor grants CANCELLER to the proposer. Compute what must change
  // to land on exactly `cancellers`.
  const cancellersToGrant = cancellers.filter((c) => !eq(c, proposer));
  const revokeProposerCanceller = !cancellers.some((c) => eq(c, proposer));
  const needsCancellerReconfig = cancellersToGrant.length > 0 || revokeProposerCanceller;

  // Use the deployer as a temporary admin only when we must reconfigure
  // cancellers; otherwise deploy fully self-administered (admin = address(0)).
  const adminArg = needsCancellerReconfig ? deployer.address : ZERO;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Deployer:", deployer.address);
  console.log("Recording under:", `contracts.timelocks.${timelockKey}`);
  console.log("Min delay:", minDelay.toString(), "seconds");
  console.log("Proposer:", proposer);
  console.log(
    "Executors:",
    executors.map((e) => (e === ZERO ? "address(0) [open]" : e)).join(", ")
  );
  console.log("Cancellers:", cancellers.join(", "));
  console.log(
    "Admin:",
    needsCancellerReconfig
      ? `${deployer.address} (temporary — renounced after canceller setup)`
      : "address(0) (self-administered)"
  );
  console.log();

  const Factory = await ethers.getContractFactory("TimelockController");
  const timelock = await Factory.deploy(minDelay, [proposer], executors, adminArg);
  await timelock.waitForDeployment();

  const address = await timelock.getAddress();
  const deployTx = timelock.deploymentTransaction();
  const deployBlock = deployTx ? (await deployTx.wait())?.blockNumber || 0 : 0;

  console.log("✅ TimelockController deployed:", address);
  console.log("📦 Block:", deployBlock);

  // Some RPCs (base, Pharos) lag in surfacing freshly-deployed code, which makes
  // the role reads below fail with BAD_DATA ("0x"). Wait until code is visible.
  await waitForCode(address);

  const proposerRole = await timelock.PROPOSER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  const adminRole = await timelock.DEFAULT_ADMIN_ROLE();

  // Configure cancellers explicitly, then renounce the temporary admin.
  if (needsCancellerReconfig) {
    for (const c of cancellersToGrant) {
      console.log(`   Granting CANCELLER_ROLE -> ${c}`);
      await (await timelock.grantRole(cancellerRole, c)).wait();
    }
    if (revokeProposerCanceller) {
      console.log(`   Revoking CANCELLER_ROLE <- ${proposer} (proposer)`);
      await (await timelock.revokeRole(cancellerRole, proposer)).wait();
    }
    console.log(`   Renouncing DEFAULT_ADMIN_ROLE <- ${deployer.address} (deployer)`);
    await (await timelock.revokeRole(adminRole, deployer.address)).wait();
  }

  // Verify final role assignments. Some RPCs (base, Pharos) lag in reflecting
  // the role-change txs just mined above, so the reads can return stale state
  // (e.g. deployerHasAdmin=true right after renounce). Re-read until the state
  // is consistent before deciding pass/fail.
  const computeChecks = async () => {
    const cancellerChecks = await Promise.all(
      cancellers.map((c) => timelock.hasRole(cancellerRole, c))
    );
    const executorChecks = await Promise.all(
      executors.map((e) => timelock.hasRole(executorRole, e))
    );
    return {
      minDelay: (await timelock.getMinDelay()).toString(),
      proposerHasProposerRole: await timelock.hasRole(proposerRole, proposer),
      allCancellersSet: cancellerChecks.every(Boolean),
      proposerCancellerMatchesIntent:
        (await timelock.hasRole(cancellerRole, proposer)) ===
        cancellers.some((c) => eq(c, proposer)),
      allExecutorsSet: executorChecks.every(Boolean),
      timelockSelfAdmin: await timelock.hasRole(adminRole, address),
      deployerHasAdmin: await timelock.hasRole(adminRole, deployer.address),
    };
  };
  const checksPass = (c: Awaited<ReturnType<typeof computeChecks>>) =>
    c.minDelay === minDelay.toString() &&
    c.proposerHasProposerRole &&
    c.allCancellersSet &&
    c.proposerCancellerMatchesIntent &&
    c.allExecutorsSet &&
    c.timelockSelfAdmin &&
    !c.deployerHasAdmin;

  let checks = await computeChecks();
  for (let attempt = 1; attempt < 15 && !checksPass(checks); attempt++) {
    console.log(`   ⏳ post-deploy state not reflected yet, re-checking (${attempt}/15)...`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    checks = await computeChecks();
  }

  console.log("\nPost-deploy verification:");
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v}`);

  if (!checksPass(checks)) {
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
  const record = {
    address,
    minDelay: minDelay.toString(),
    proposers: [proposer],
    executors,
    cancellers,
    admin: ZERO,
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber: deployBlock,
  };
  deploymentInfo.contracts.timelocks = deploymentInfo.contracts.timelocks || {};
  deploymentInfo.contracts.timelocks[timelockKey] = record;
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Saved to", deploymentFileName);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
