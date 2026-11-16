import { ethers } from "hardhat";
import * as fs from "fs";
import { getCcipConfig, poolKeyForVault } from "../../config/ccip.config";

/**
 * Registers the vault's receipt token with CCIP and points it at our pool.
 *
 * Three sequential calls across two Chainlink contracts:
 *
 *   1. RegistryModuleOwnerCustom.registerAdminViaOwner(token)
 *        Reverts unless msg.sender == token.owner(); installs that address as the token's
 *        PENDING administrator.
 *   2. TokenAdminRegistry.acceptAdminRole(token)      — by the pending administrator
 *   3. TokenAdminRegistry.setPool(token, pool)        — by the now-accepted administrator
 *
 * When the vault owner is an EOA this script sends all three. When it is a Timelock or Safe
 * it prints the calldata instead: the three steps are atomic-safe in sequence, so a single
 * batched proposal does all of them and costs one delay period rather than three.
 *
 * Required ENV:
 *   VAULT_KEY      Key of the vault in the deployment file
 *
 * Optional ENV:
 *   IS_ETH_VAULT   "true" to look the vault up under ethVaults
 *   DRY_RUN        "true" to print the plan and calldata without sending
 */

const REGISTRY_MODULE_ABI = ["function registerAdminViaOwner(address token) external"];
const TOKEN_ADMIN_REGISTRY_ABI = [
  "function acceptAdminRole(address localToken) external",
  "function setPool(address localToken, address pool) external",
  "function getTokenConfig(address token) view returns (tuple(address administrator, address pendingAdministrator, address tokenPool))",
];

async function main() {
  console.log("\n📋 Registering token with the CCIP TokenAdminRegistry...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const ccip = getCcipConfig(networkName);
  const dryRun = process.env.DRY_RUN === "true";

  console.log("Network:", ccip.label);
  console.log("Signer: ", signer.address, "\n");

  const vaultKey = process.env.VAULT_KEY;
  if (!vaultKey) {
    console.error("❌ Error: VAULT_KEY is required.");
    process.exit(1);
  }

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  const poolKey = poolKeyForVault(vaultKey);
  const poolInfo = deploymentInfo.contracts.ccipTokenPools?.[poolKey];
  if (!poolInfo) {
    console.error(`❌ Error: no pool '${poolKey}' in ${deploymentFileName}. Deploy it first.`);
    process.exit(1);
  }

  const tokenAddress: string = poolInfo.vaultAddress;
  const poolAddress: string = poolInfo.address;

  const vault = await ethers.getContractAt("IEmberVaultToken", tokenAddress);
  const tokenOwner = await (
    await ethers.getContractAt(["function owner() view returns (address)"], tokenAddress)
  ).owner();

  const registry = new ethers.Contract(ccip.tokenAdminRegistry, TOKEN_ADMIN_REGISTRY_ABI, signer);
  const registryModule = new ethers.Contract(ccip.registryModule, REGISTRY_MODULE_ABI, signer);

  console.log("Registration plan:");
  console.log("  Token (vault):      ", tokenAddress);
  console.log("  Pool:               ", poolAddress);
  console.log("  Token owner:        ", tokenOwner);
  console.log("  TokenAdminRegistry: ", ccip.tokenAdminRegistry);
  console.log("  RegistryModule:     ", ccip.registryModule);
  console.log();

  const before = await registry.getTokenConfig(tokenAddress);
  console.log("Current registry state:");
  console.log("  administrator:       ", before.administrator);
  console.log("  pendingAdministrator:", before.pendingAdministrator);
  console.log("  tokenPool:           ", before.tokenPool);
  console.log();

  if (before.tokenPool.toLowerCase() === poolAddress.toLowerCase()) {
    console.log("✅ Already registered and pointed at this pool. Nothing to do.\n");
    return;
  }

  // Sanity-check the pool actually supports this token — setPool reverts otherwise.
  const pool = await ethers.getContractAt("EmberTokenPool", poolAddress);
  if (!(await pool.isSupportedToken(tokenAddress))) {
    console.error("❌ Error: the pool does not report this token as supported.");
    console.log("   setPool would revert. Check that the pool was deployed for this vault.");
    process.exit(1);
  }

  const steps = [
    {
      label: "registerAdminViaOwner",
      to: ccip.registryModule,
      caller: tokenOwner,
      data: registryModule.interface.encodeFunctionData("registerAdminViaOwner", [tokenAddress]),
      // Already proposed (or already accepted) — re-proposing is wasted gas.
      skip:
        before.administrator !== ethers.ZeroAddress ||
        before.pendingAdministrator.toLowerCase() === tokenOwner.toLowerCase(),
      /** State that must hold before this step is worth sending, and after it lands. */
      done: (c: any) =>
        c.administrator !== ethers.ZeroAddress ||
        c.pendingAdministrator.toLowerCase() === tokenOwner.toLowerCase(),
    },
    {
      label: "acceptAdminRole",
      to: ccip.tokenAdminRegistry,
      caller: tokenOwner,
      data: registry.interface.encodeFunctionData("acceptAdminRole", [tokenAddress]),
      skip: before.administrator.toLowerCase() === tokenOwner.toLowerCase(),
      done: (c: any) => c.administrator.toLowerCase() === tokenOwner.toLowerCase(),
    },
    {
      label: "setPool",
      to: ccip.tokenAdminRegistry,
      caller: before.administrator !== ethers.ZeroAddress ? before.administrator : tokenOwner,
      data: registry.interface.encodeFunctionData("setPool", [tokenAddress, poolAddress]),
      skip: before.tokenPool.toLowerCase() === poolAddress.toLowerCase(),
      done: (c: any) => c.tokenPool.toLowerCase() === poolAddress.toLowerCase(),
    },
  ].filter((s) => !s.skip);

  const signerIsOwner = tokenOwner.toLowerCase() === signer.address.toLowerCase();
  const canSend =
    signerIsOwner && steps.every((s) => s.caller.toLowerCase() === signer.address.toLowerCase());

  if (!canSend || dryRun) {
    console.log("=".repeat(70));
    console.log(dryRun ? "DRY RUN — calldata only" : "⚠️  Signer is not the required caller");
    console.log("=".repeat(70));
    if (!signerIsOwner) {
      console.log("registerAdminViaOwner must come from the token owner:", tokenOwner);
      console.log("If that is a Timelock, batch all steps into ONE proposal — they are");
      console.log("atomic-safe in sequence, so batching costs one delay instead of three.\n");
    }
    steps.forEach((s, i) => {
      console.log(`\nStep ${i + 1}: ${s.label}`);
      console.log("  caller: ", s.caller);
      console.log("  to:     ", s.to);
      console.log("  value:  0");
      console.log("  data:   ", s.data);
    });
    console.log("\nAs arrays for TimelockController.scheduleBatch / executeBatch:");
    console.log("  targets:", JSON.stringify(steps.map((s) => s.to)));
    console.log("  values: ", JSON.stringify(steps.map(() => "0")));
    console.log("  payloads:", JSON.stringify(steps.map((s) => s.data)));
    console.log("\n" + "=".repeat(70) + "\n");
    return;
  }

  /**
   * Waits until a state predicate holds against a fresh read.
   *
   * `tx.wait()` only proves the transaction was mined on the node that answered. Behind a load
   * balancer the next call can land on a node that has not caught up, so the following step
   * estimates gas against stale state and reverts — which is exactly how this script previously
   * failed on Mantle, with acceptAdminRole reverting while pendingAdministrator was in fact set.
   */
  async function waitForState(
    predicate: (cfg: any) => boolean,
    label: string,
    attempts = 20
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (predicate(await registry.getTokenConfig(tokenAddress))) return true;
      if (i === 0) console.log(`  ⏳ waiting for ${label} to be visible on the RPC...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  }

  for (const [i, step] of steps.entries()) {
    // Re-read rather than trusting the pre-flight snapshot: an earlier step in this same run
    // may have satisfied this one, and re-sending would revert.
    if (step.done(await registry.getTokenConfig(tokenAddress))) {
      console.log(`Step ${i + 1}/${steps.length}: ${step.label} — already satisfied, skipping`);
      continue;
    }

    console.log(`Step ${i + 1}/${steps.length}: ${step.label}...`);
    const tx = await signer.sendTransaction({ to: step.to, data: step.data });
    const receipt = await tx.wait();
    console.log(`  ✅ confirmed in block ${receipt?.blockNumber} (${receipt?.hash})`);

    if (!(await waitForState(step.done, step.label))) {
      console.error(`  ❌ ${step.label} was mined but the registry still does not reflect it.`);
      console.log("     Re-run this command — it resumes from wherever the on-chain state is.");
      process.exit(1);
    }
  }

  const after = await registry.getTokenConfig(tokenAddress);
  console.log("\n📊 Registry state now:");
  console.log("  administrator:", after.administrator);
  console.log("  tokenPool:    ", after.tokenPool);
  console.log(
    after.tokenPool.toLowerCase() === poolAddress.toLowerCase()
      ? "\n✅ Token registered and pointed at the pool"
      : "\n❌ setPool did not take effect"
  );

  poolInfo.tokenAdminRegistration = {
    administrator: after.administrator,
    tokenPool: after.tokenPool,
    registeredAt: new Date().toISOString(),
  };
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2) + "\n");

  console.log("\n💡 Next: cut over the vault's bridge adapter to the pool, then verify:");
  console.log(
    `   VAULT_KEY=${vaultKey} ADAPTER_ADDRESS=${poolAddress} yarn bridge:set-adapter --network ${networkName}`
  );
  console.log(`   yarn ccip:verify-config\n`);

  // Referenced so the unused-var linter does not flag the typed handle we kept for clarity.
  void vault;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
