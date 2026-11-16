import { ethers, upgrades } from "hardhat";
import { getImplementationAddressWithRetry } from "../utils/erc1967";
import * as fs from "fs";

/**
 * Deploys an AtomicLiquidity vault behind a UUPS proxy, linked to the previously deployed
 * AtomicLiquidityLib (see scripts/deploy/atomic-liquidity-lib.ts).
 *
 * Like the EmberVault deploy script: reads config from env, validates roles, writes
 * deployment info to ./deployments/<network>-deployment.json under contracts.atomicLiquidity.
 *
 * Required ENV:
 *   ATOMIC_LIQUIDITY_NAME              Vault display name (e.g. "Atomic Liquidity USDC")
 *   ATOMIC_LIQUIDITY_COLLATERAL_TOKEN  Underlying ERC-20 (e.g. USDC) address
 *   ATOMIC_LIQUIDITY_ADMIN             Admin address
 *   ATOMIC_LIQUIDITY_OPERATOR          Operator address
 *   ATOMIC_LIQUIDITY_RATE_MANAGER      Rate manager address
 *
 * Optional ENV:
 *   ATOMIC_LIQUIDITY_OWNER             Owner (defaults to deployer)
 *   ATOMIC_LIQUIDITY_MAX_RATE_CHANGE   Max rate change per update (default 0.01e18)
 *   ATOMIC_LIQUIDITY_FEE_PERCENTAGE    Time-based platform fee (default 0.001e18)
 *   ATOMIC_LIQUIDITY_MIN_WITHDRAWABLE  Min withdrawable shares (default 1e6)
 *   ATOMIC_LIQUIDITY_RATE_INTERVAL     Rate interval ms (default 3600001 = 1h)
 *   ATOMIC_LIQUIDITY_MAX_TVL           Max TVL (default 1e30)
 *   ATOMIC_LIQUIDITY_SUB_ACCOUNTS      Comma-separated sub-account addresses
 *   ATOMIC_LIQUIDITY_LIB_ADDRESS       Override library address (defaults to the address
 *                                      recorded in the deployment file)
 */
async function main() {
  console.log("\n💧 Deploying AtomicLiquidity...\n");

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

  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found!");
    console.log("Please deploy the protocol config first using: yarn deploy:protocol-config");
    console.log("And then deploy the library:                    yarn deploy:atomic-liquidity-lib");
    process.exit(1);
  }

  console.log("📂 Loading deployment file:", deploymentFileName);
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  const protocolConfigAddress = deploymentInfo.contracts.protocolConfig?.proxyAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: protocolConfig not found in deployment file!");
    console.log("Run: yarn deploy:protocol-config");
    process.exit(1);
  }

  const libAddress =
    process.env.ATOMIC_LIQUIDITY_LIB_ADDRESS ||
    deploymentInfo.contracts.atomicLiquidityLib?.address;
  if (!libAddress) {
    console.error("❌ Error: AtomicLiquidityLib address not found!");
    console.log("Run: yarn deploy:atomic-liquidity-lib");
    console.log("Or pass ATOMIC_LIQUIDITY_LIB_ADDRESS=<address> for an out-of-band library.");
    process.exit(1);
  }

  // AtomicLiquidity links to three external libraries (see linkReferences in its artifact):
  // AtomicLiquidityLib, VaultPlatformFeeLib, WithdrawalQueueLib. All three must be deployed
  // and resolvable via deploymentInfo (or env overrides) before linking the implementation.
  const platformFeeLibAddress =
    process.env.VAULT_PLATFORM_FEE_LIB_ADDRESS ||
    deploymentInfo.contracts.vaultPlatformFeeLib?.address;
  const withdrawalQueueLibAddress =
    process.env.WITHDRAWAL_QUEUE_LIB_ADDRESS ||
    deploymentInfo.contracts.withdrawalQueueLib?.address;
  if (!platformFeeLibAddress || !withdrawalQueueLibAddress) {
    console.error("❌ Error: VaultPlatformFeeLib / WithdrawalQueueLib address not found!");
    console.log("Run: yarn deploy:vault-libraries");
    console.log(
      "Or pass VAULT_PLATFORM_FEE_LIB_ADDRESS / WITHDRAWAL_QUEUE_LIB_ADDRESS for out-of-band libraries."
    );
    process.exit(1);
  }

  // Required params
  const vaultName = process.env.ATOMIC_LIQUIDITY_NAME;
  const collateralToken = process.env.ATOMIC_LIQUIDITY_COLLATERAL_TOKEN;
  const admin = process.env.ATOMIC_LIQUIDITY_ADMIN;
  const operator = process.env.ATOMIC_LIQUIDITY_OPERATOR;
  const rateManager = process.env.ATOMIC_LIQUIDITY_RATE_MANAGER;

  if (!vaultName || !collateralToken || !admin || !operator || !rateManager) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired:");
    console.log("  ATOMIC_LIQUIDITY_NAME");
    console.log("  ATOMIC_LIQUIDITY_COLLATERAL_TOKEN");
    console.log("  ATOMIC_LIQUIDITY_ADMIN");
    console.log("  ATOMIC_LIQUIDITY_OPERATOR");
    console.log("  ATOMIC_LIQUIDITY_RATE_MANAGER");
    process.exit(1);
  }

  if (admin === operator || admin === rateManager || operator === rateManager) {
    console.error(
      "❌ Error: ATOMIC_LIQUIDITY_ADMIN, _OPERATOR, _RATE_MANAGER must be distinct addresses."
    );
    console.log("  ADMIN:        ", admin);
    console.log("  OPERATOR:     ", operator);
    console.log("  RATE_MANAGER: ", rateManager);
    process.exit(1);
  }

  // Optional params with defaults — same defaults as ember-vault.ts for consistency.
  const owner = process.env.ATOMIC_LIQUIDITY_OWNER || deployer.address;
  const maxRateChangePerUpdate =
    process.env.ATOMIC_LIQUIDITY_MAX_RATE_CHANGE || "10000000000000000"; // 1%
  const feePercentage = process.env.ATOMIC_LIQUIDITY_FEE_PERCENTAGE || "1000000000000000"; // 0.1%
  const minWithdrawableShares = process.env.ATOMIC_LIQUIDITY_MIN_WITHDRAWABLE || "1000000";
  const rateUpdateInterval = process.env.ATOMIC_LIQUIDITY_RATE_INTERVAL || "3600001";
  const maxTVL = process.env.ATOMIC_LIQUIDITY_MAX_TVL || "1000000000000000000000000000000";
  const subAccountsStr = process.env.ATOMIC_LIQUIDITY_SUB_ACCOUNTS || "";
  const subAccounts = subAccountsStr ? subAccountsStr.split(",").map((a) => a.trim()) : [];

  console.log("Vault Configuration:");
  console.log("  Name:                 ", vaultName);
  console.log("  Collateral Token:     ", collateralToken);
  console.log("  Admin:                ", admin);
  console.log("  Operator:             ", operator);
  console.log("  Rate Manager:         ", rateManager);
  console.log("  Owner:                ", owner);
  console.log("  Protocol Config:      ", protocolConfigAddress);
  console.log("  AtomicLiquidityLib:   ", libAddress);
  console.log("  VaultPlatformFeeLib:  ", platformFeeLibAddress);
  console.log("  WithdrawalQueueLib:   ", withdrawalQueueLibAddress);
  console.log("  Max Rate Change:      ", maxRateChangePerUpdate);
  console.log("  Fee Percentage:       ", feePercentage);
  console.log("  Min Withdrawable:     ", minWithdrawableShares);
  console.log("  Rate Update Interval: ", rateUpdateInterval, "ms");
  console.log("  Max TVL:              ", maxTVL);
  console.log("  Sub Accounts:         ", subAccounts.length > 0 ? subAccounts.join(", ") : "None");
  console.log();

  const initParams = {
    name: vaultName,
    collateralToken,
    admin,
    operator,
    rateManager,
    maxRateChangePerUpdate,
    feePercentage,
    minWithdrawableShares,
    rateUpdateInterval,
    maxTVL,
  };

  // Link all three libraries at compile-time. Missing ANY of them fails at factory creation
  // with "missing links" — there is no risk of accidentally deploying an unlinked impl.
  const factory = await ethers.getContractFactory("AtomicLiquidity", {
    libraries: {
      AtomicLiquidityLib: libAddress,
      VaultPlatformFeeLib: platformFeeLibAddress,
      WithdrawalQueueLib: withdrawalQueueLibAddress,
    },
  });

  console.log("Deploying AtomicLiquidity proxy...");
  const vault = (await upgrades.deployProxy(
    factory,
    [protocolConfigAddress, owner, initParams, subAccounts],
    {
      initializer: "initialize",
      kind: "uups",
      // The library is non-upgradeable bytecode. Re-linking on upgrade is supported by the
      // upgrade script but requires the operator to acknowledge that the library address may
      // change. We have manually verified the library is upgrade-safe.
      unsafeAllowLinkedLibraries: true,
    }
  )) as any;

  await vault.waitForDeployment();

  const proxyAddress = await vault.getAddress();
  console.log("✅ AtomicLiquidity proxy deployed to:", proxyAddress);

  const deploymentTx = vault.deploymentTransaction();
  let deploymentBlockNumber = 0;
  if (deploymentTx) {
    const receipt = await deploymentTx.wait();
    deploymentBlockNumber = receipt?.blockNumber || 0;
    console.log("📦 Deployed in block:", deploymentBlockNumber);
  }

  const implementationAddress = await getImplementationAddressWithRetry(proxyAddress);
  console.log("📝 Implementation address:", implementationAddress);

  const version = await vault.version();
  console.log("📌 Contract version:", version);

  const vaultNameOnChain = await vault.vaultName();
  const maxTVLOnChain = await vault.maxTVL();
  const totalSharesOnChain = await vault.totalShares();

  console.log("\n📊 Vault Details:");
  console.log("  Name:        ", vaultNameOnChain);
  console.log("  Max TVL:     ", maxTVLOnChain.toString());
  console.log("  Total Shares:", totalSharesOnChain.toString());
  console.log("  Owner:       ", await vault.owner());

  if (!deploymentInfo.contracts.atomicLiquidityVaults) {
    deploymentInfo.contracts.atomicLiquidityVaults = {};
  }

  // Vault key derived from the configured name (e.g. "Atomic Liquidity USDC" → "atomicLiquidityUsdc").
  const vaultKey = vaultName
    .split(/\s+/)
    .map((word: string, i: number) => {
      const lower = word.toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");

  if (deploymentInfo.contracts.atomicLiquidityVaults[vaultKey]) {
    console.warn(`\n⚠️  Vault key '${vaultKey}' already exists — overwriting.`);
    console.log(
      "   Old proxy:",
      deploymentInfo.contracts.atomicLiquidityVaults[vaultKey].proxyAddress
    );
    console.log("   New proxy:", proxyAddress);
  }

  deploymentInfo.contracts.atomicLiquidityVaults[vaultKey] = {
    proxyAddress,
    implementationAddress,
    libraryAddress: libAddress,
    vaultPlatformFeeLibAddress: platformFeeLibAddress,
    withdrawalQueueLibAddress,
    ownerAddress: owner,
    name: vaultName,
    collateralToken,
    admin,
    operator,
    rateManager,
    protocolConfig: protocolConfigAddress,
    maxTVL,
    version,
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber,
  };

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 AtomicLiquidity Deployment Complete!");
  console.log("=".repeat(70));
  console.log("\nVault Key:               ", vaultKey);
  console.log("Proxy Address:           ", proxyAddress);
  console.log("Implementation Address:  ", implementationAddress);
  console.log("AtomicLiquidityLib:      ", libAddress);
  console.log("VaultPlatformFeeLib:     ", platformFeeLibAddress);
  console.log("WithdrawalQueueLib:      ", withdrawalQueueLibAddress);
  console.log("Version:                 ", version);
  console.log("Deployment Block:        ", deploymentBlockNumber);
  console.log("\n💡 Next steps:");
  console.log(" 1. Have admin call protocolConfig.<setter>(vault, ...) for any non-init config.");
  console.log(" 2. setStrategy(...) when ready to point the vault at an ERC-4626 strategy.");
  console.log(" 3. setMaxInstantWithdrawShares + setInstantWithdrawFeePercentage to enable");
  console.log("    instant withdrawals (default off).");
  console.log(" 4. setEmberShareWhitelist(...) to onboard EmberVault shares for swap.");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
