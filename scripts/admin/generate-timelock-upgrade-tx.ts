import { ethers, upgrades } from "hardhat";
import * as fs from "fs";

/**
 * Generates schedule + execute tx-bytes for a UUPS upgrade routed through
 * the TimelockController.
 *
 * The schedule tx must be submitted by the proposer multisig now; the
 * execute tx is submittable by anyone after `minDelay` has elapsed.
 *
 * Required ENV variables:
 *   - CONTRACT_NAME   Solidity contract name of the new implementation
 *                     (e.g. EmberProtocolConfig, EmberVault, EmberETHVault).
 *                     Used for getContractFactory + storage-layout validation.
 *   - PROXY_ADDRESS   Proxy to upgrade.
 *
 * Optional ENV variables:
 *   - NEW_IMPL        Pre-deployed implementation address. If absent, the
 *                     script deploys a fresh impl via upgrades.prepareUpgrade
 *                     (which also validates storage layout against PROXY_ADDRESS).
 *   - INIT_DATA       Calldata to forward to upgradeToAndCall (e.g. an
 *                     `initializeV2()` call). Default: "0x" (no init).
 *   - SALT            bytes32 salt for the timelock operation. Default:
 *                     keccak256("ember-upgrade:" || PROXY_ADDRESS || NEW_IMPL).
 *                     Override only if you need to schedule the same upgrade
 *                     twice (e.g. retry after cancel).
 *   - DELAY           Override the schedule's delay (must be >= timelock's
 *                     minDelay). Default: timelock.getMinDelay().
 *
 * Output: deployments/<network>-timelock-upgrade-<proxyShort>-<ts>.json
 */
async function main() {
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  const contractName = process.env.CONTRACT_NAME;
  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!contractName) {
    console.error("❌ CONTRACT_NAME is required");
    process.exit(1);
  }
  if (!proxyAddress || !ethers.isAddress(proxyAddress)) {
    console.error("❌ PROXY_ADDRESS is required and must be a valid address");
    process.exit(1);
  }

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Deployment file not found:", deploymentFileName);
    process.exit(1);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  const timelockAddress = deployment.contracts?.timelock?.address;
  if (!timelockAddress || !ethers.isAddress(timelockAddress)) {
    console.error("❌ contracts.timelock.address missing — deploy the timelock first.");
    process.exit(1);
  }

  // Confirm proxy currently owned by the timelock; if not, the upgrade tx
  // will revert when executed even if the schedule succeeds.
  const ownable = new ethers.Contract(
    proxyAddress,
    ["function owner() view returns (address)"],
    ethers.provider
  );
  let currentOwner: string;
  try {
    currentOwner = await ownable.owner();
  } catch (e: any) {
    console.error("❌ Could not read owner() on proxy:", e?.message || e);
    process.exit(1);
  }
  if (currentOwner!.toLowerCase() !== timelockAddress.toLowerCase()) {
    console.error(
      `❌ Proxy owner is ${currentOwner}, not the timelock ${timelockAddress}.\n` +
        `   Transfer ownership first (yarn admin:gen-timelock-transfers), or this upgrade will revert.`
    );
    process.exit(1);
  }

  // Resolve the new implementation address.
  let newImpl = process.env.NEW_IMPL;
  if (newImpl && !ethers.isAddress(newImpl)) {
    console.error("❌ NEW_IMPL is not a valid address");
    process.exit(1);
  }
  if (newImpl) {
    const code = await ethers.provider.getCode(newImpl);
    if (code === "0x") {
      console.error("❌ NEW_IMPL has no code on this network:", newImpl);
      process.exit(1);
    }
    console.log("Using pre-deployed implementation:", newImpl);
    console.log("⚠️  Skipped storage-layout validation (caller's responsibility).");
  } else {
    console.log("No NEW_IMPL provided — running upgrades.prepareUpgrade...");
    const Factory = await ethers.getContractFactory(contractName);
    const prepared = await upgrades.prepareUpgrade(proxyAddress, Factory, { kind: "uups" });
    newImpl = typeof prepared === "string" ? prepared : await (prepared as any).getAddress();
    console.log("✅ Implementation deployed:", newImpl);
  }

  const initData = process.env.INIT_DATA || "0x";
  if (!ethers.isHexString(initData)) {
    console.error("❌ INIT_DATA must be a 0x-prefixed hex string");
    process.exit(1);
  }

  // Build the inner upgrade call: proxy.upgradeToAndCall(newImpl, initData)
  const uupsIface = new ethers.Interface([
    "function upgradeToAndCall(address newImplementation, bytes data) payable",
  ]);
  const upgradeCalldata = uupsIface.encodeFunctionData("upgradeToAndCall", [newImpl, initData]);

  // Build timelock schedule + execute calldata.
  const timelock = await ethers.getContractAt("TimelockController", timelockAddress);
  const minDelay = await timelock.getMinDelay();
  const delay = BigInt(process.env.DELAY || minDelay.toString());
  if (delay < minDelay) {
    console.error(`❌ DELAY (${delay}) is below timelock minDelay (${minDelay})`);
    process.exit(1);
  }

  const predecessor = ethers.ZeroHash;
  const salt =
    process.env.SALT ??
    ethers.keccak256(
      ethers.solidityPacked(
        ["string", "address", "address"],
        ["ember-upgrade:", proxyAddress, newImpl]
      )
    );
  if (!ethers.isHexString(salt, 32)) {
    console.error("❌ SALT must be a 32-byte hex string (0x... 64 hex chars)");
    process.exit(1);
  }

  const target = proxyAddress;
  const value = 0n;

  const tlIface = new ethers.Interface([
    "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
    "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
    "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  ]);
  const scheduleData = tlIface.encodeFunctionData("schedule", [
    target,
    value,
    upgradeCalldata,
    predecessor,
    salt,
    delay,
  ]);
  const executeData = tlIface.encodeFunctionData("execute", [
    target,
    value,
    upgradeCalldata,
    predecessor,
    salt,
  ]);

  // operationId per OZ TimelockController.hashOperation
  const operationId = await (timelock as any).hashOperation(
    target,
    value,
    upgradeCalldata,
    predecessor,
    salt
  );

  const out = {
    network: networkName,
    chainId: network.chainId.toString(),
    timelock: timelockAddress,
    proxy: proxyAddress,
    contractName,
    newImpl,
    initData,
    delaySeconds: delay.toString(),
    predecessor,
    salt,
    operationId,
    upgradeCalldata,
    schedule: {
      to: timelockAddress,
      value: "0",
      data: scheduleData,
      submitFrom: deployment.contracts.timelock.proposers?.[0] || null,
      note: "Submit now from the proposer multisig.",
    },
    execute: {
      to: timelockAddress,
      value: "0",
      data: executeData,
      submitFrom: "anyone (executor role assigned to address(0))",
      note: `Submittable after ${delay} seconds have elapsed since the schedule tx is mined.`,
    },
    generatedAt: new Date().toISOString(),
  };

  const proxyShort = proxyAddress.slice(2, 10).toLowerCase();
  const ts = Math.floor(Date.now() / 1000);
  const outFile = `./deployments/${networkName}-timelock-upgrade-${proxyShort}-${ts}.json`;
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log("\n📝 Wrote", outFile);
  console.log("\nOperation ID:", operationId);
  console.log("Salt:        ", salt);
  console.log("Schedule tx →", timelockAddress, "(from", out.schedule.submitFrom + ")");
  console.log("Execute tx  →", timelockAddress, "(callable after", delay.toString() + "s)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
