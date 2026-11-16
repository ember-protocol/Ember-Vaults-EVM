import { ethers } from "hardhat";
import * as fs from "fs";
import { getCcipConfig, poolKeyForVault } from "../../config/ccip.config";

/**
 * Sets the pool's dynamic config: router, rateLimitAdmin and feeAdmin.
 *
 * The reason this exists is rateLimitAdmin. `setRateLimitConfig` is onlyOwnerOrRateLimitAdmin,
 * and the pool owner is a 12h Timelock — so without a rateLimitAdmin set, tightening a limit
 * during an incident waits out the timelock. Pointing rateLimitAdmin at the ops multisig keeps
 * the owner-only powers (lanes, finality, fees, upgrades) behind the Timelock while making the
 * one knob you actually need in a hurry reachable in a hurry.
 *
 * setDynamicConfig overwrites all three fields at once, so this script reads the current config
 * first and only changes what you pass. Router is never changed implicitly: a wrong router
 * silently breaks every lane, so it has to be passed explicitly to move.
 *
 * Required ENV:
 *   VAULT_KEY         Key of the vault in the deployment file
 *
 * Optional ENV (at least one of these, or there is nothing to do):
 *   RATE_LIMIT_ADMIN  Address to set as rateLimitAdmin. "none" clears it.
 *   FEE_ADMIN         Address to set as feeAdmin. "none" clears it, leaving fee withdrawal
 *                     owner-only.
 *   ROUTER            New router. Omit to keep the current one.
 */
async function main() {
  console.log("\n⚙️  Setting pool dynamic config...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const ccip = getCcipConfig(networkName);

  const vaultKey = process.env.VAULT_KEY;
  if (!vaultKey) {
    console.error("❌ Error: VAULT_KEY is required.");
    process.exit(1);
  }

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: deployment file not found:", deploymentFileName);
    process.exit(1);
  }
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  const poolKey = poolKeyForVault(vaultKey);
  const poolInfo = deploymentInfo.contracts.ccipTokenPools?.[poolKey];
  if (!poolInfo) {
    console.error(`❌ Error: no pool '${poolKey}' in ${deploymentFileName}.`);
    process.exit(1);
  }

  const pool = await ethers.getContractAt("EmberTokenPool", poolInfo.address);
  const [currentRouter, currentRateLimitAdmin, currentFeeAdmin] = await pool.getDynamicConfig();

  console.log("Pool:   ", poolInfo.address);
  console.log("Network:", ccip.label);
  console.log("Signer: ", signer.address, "\n");
  console.log("Current:");
  console.log("  router:         ", currentRouter);
  console.log("  rateLimitAdmin: ", currentRateLimitAdmin);
  console.log("  feeAdmin:       ", currentFeeAdmin, "\n");

  const ZERO = ethers.ZeroAddress;
  const resolve = (raw: string | undefined, current: string, label: string): string => {
    if (raw === undefined) return current;
    if (raw.toLowerCase() === "none") return ZERO;
    if (!ethers.isAddress(raw)) {
      console.error(`❌ Error: ${label} must be an address or "none", got '${raw}'.`);
      process.exit(1);
    }
    return ethers.getAddress(raw);
  };

  const router = resolve(process.env.ROUTER, currentRouter, "ROUTER");
  const rateLimitAdmin = resolve(
    process.env.RATE_LIMIT_ADMIN,
    currentRateLimitAdmin,
    "RATE_LIMIT_ADMIN"
  );
  const feeAdmin = resolve(process.env.FEE_ADMIN, currentFeeAdmin, "FEE_ADMIN");

  if (
    router === currentRouter &&
    rateLimitAdmin === currentRateLimitAdmin &&
    feeAdmin === currentFeeAdmin
  ) {
    console.log("Nothing to change — set RATE_LIMIT_ADMIN, FEE_ADMIN or ROUTER.");
    process.exit(0);
  }

  // The configured router for this chain is the one every lane resolves ramps through. Changing
  // it is legitimate during a CCIP migration but is never what you want by accident.
  if (router !== currentRouter) {
    console.log("⚠️  ROUTER is changing. Every lane resolves its on/off ramps through the router,");
    console.log("    so a wrong value silently breaks the whole pool.");
    console.log("    config/ccip.config.ts router for this chain:", ccip.router);
    if (router.toLowerCase() !== ccip.router.toLowerCase()) {
      console.log("    ❗ and the value you passed does NOT match it.");
    }
    console.log();
  }

  console.log("New:");
  console.log("  router:         ", router, router === currentRouter ? "(unchanged)" : "← CHANGED");
  console.log(
    "  rateLimitAdmin: ",
    rateLimitAdmin,
    rateLimitAdmin === currentRateLimitAdmin ? "(unchanged)" : "← CHANGED"
  );
  console.log(
    "  feeAdmin:       ",
    feeAdmin,
    feeAdmin === currentFeeAdmin ? "(unchanged)" : "← CHANGED"
  );
  console.log();

  const owner = await pool.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("❌ Error: setDynamicConfig is onlyOwner.");
    console.log("   Pool owner:", owner);
    console.log("   Signer:    ", signer.address);
    console.log("   If the owner is a Timelock or Safe, generate the calldata instead of");
    console.log("   sending directly — see the ember-utils tx-bytes flow. The calldata is:");
    console.log(
      "  ",
      pool.interface.encodeFunctionData("setDynamicConfig", [router, rateLimitAdmin, feeAdmin])
    );
    process.exit(1);
  }

  const tx = await pool.setDynamicConfig(router, rateLimitAdmin, feeAdmin);
  const receipt = await tx.wait();
  console.log("✅ setDynamicConfig confirmed in block", receipt?.blockNumber);

  // Read back rather than trust the receipt — behind a load balancer the next read can land on
  // a node that has not caught up yet.
  let confirmed = false;
  for (let i = 0; i < 20; i++) {
    const [r, rl, f] = await pool.getDynamicConfig();
    if (r === router && rl === rateLimitAdmin && f === feeAdmin) {
      confirmed = true;
      break;
    }
    if (i === 0) console.log("  ⏳ waiting for the new config to be visible on the RPC...");
    await new Promise((res) => setTimeout(res, 3000));
  }
  console.log("\n📊 Verification:", confirmed ? "✅ config matches" : "❌ NOT yet visible");

  poolInfo.dynamicConfig = {
    router,
    rateLimitAdmin,
    feeAdmin,
    updatedAt: new Date().toISOString(),
    txHash: receipt?.hash,
    blockNumber: receipt?.blockNumber,
  };
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2) + "\n");
  console.log("✅ Recorded in", deploymentFileName, "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
