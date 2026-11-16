import { ethers } from "hardhat";
import * as fs from "fs";

type VaultDeploymentRecord = {
  proxyAddress?: string;
  name?: string;
  admin?: string;
  protocolConfig?: string;
  strategyAddress?: string;
  [key: string]: unknown;
};

type DeploymentInfo = {
  contracts?: {
    protocolConfig?: { proxyAddress?: string };
    atomicLiquidityVaults?: Record<string, VaultDeploymentRecord>;
  };
};

/** Read-only surface of the ERC-4626 strategy we care about. Hand-written to dodge HH701. */
const ERC4626_METADATA_ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

/**
 * Points an Atomic Liquidity Vault at an external ERC-4626 strategy (or clears it),
 * routed through EmberProtocolConfig.setVaultStrategy.
 *
 * Usage:
 *   ALV_KEY=<key> STRATEGY_ADDRESS=<0x…> yarn interact:set-atomic-strategy --network <NETWORK>
 *
 * Nothing is sent unless EXECUTE=true: the default run simulates with staticCall, prints
 * the calldata, and reports what would be drained from the outgoing strategy.
 *
 * Both the vault being written to and the strategy being written are taken from the
 * environment and from nowhere else — no inference, no deployment-JSON fallback, no
 * default. A script that can pick a vault or a strategy on its own is a script that can
 * point the wrong vault at the wrong strategy.
 *
 * Environment Variables:
 *   ALV_KEY          - atomicLiquidityVaults key in the deployment JSON. Required unless
 *                      ALV_ADDRESS is set; never inferred, even with one atomic vault.
 *   ALV_ADDRESS      - Bypass the deployment JSON and target this address directly.
 *   STRATEGY_ADDRESS - The ERC-4626 vault to use. Required. Use the zero address to detach.
 *   EXECUTE          - "true" to actually send the transaction. Default dry run.
 *
 * Notes:
 * - `setStrategy` is `onlyProtocolConfig onlyAdmin(caller)`; the signer must BE the vault
 *   admin and the call must route through the protocolConfig the vault itself stores.
 * - The contract enforces `IERC4626(newStrategy).asset() == collateralToken`. Checked here
 *   first so a wrong strategy fails readably instead of reverting InvalidStrategy.
 * - Re-setting the same address reverts SameValue; that is checked before sending.
 * - REPLACING a funded strategy drains it inside setStrategy via a direct
 *   `prev.withdraw(...)`. That path emits NO StrategyWithdrawn event, so indexers and
 *   `netDeployedAssets` will not see the outflow — which is why the ALV's deployed-assets
 *   figures are scoped per strategy id. The script prints what will be drained so the
 *   number is at least recorded in the run log.
 */
async function main() {
  console.log("\n🎯 Setting Atomic Liquidity strategy...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);

  const newStrategy = process.env.STRATEGY_ADDRESS?.trim();
  if (!newStrategy) {
    console.error("❌ Error: STRATEGY_ADDRESS is required (use the zero address to detach).");
    process.exit(1);
  }
  if (!ethers.isAddress(newStrategy)) {
    console.error(`❌ Error: STRATEGY_ADDRESS='${newStrategy}' is not an address.`);
    process.exit(1);
  }

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8")) as DeploymentInfo;

  const atomicVaults = deploymentInfo.contracts?.atomicLiquidityVaults ?? {};
  let alvAddress = process.env.ALV_ADDRESS?.trim();
  let alvRecord: VaultDeploymentRecord | undefined;
  let alvKey: string | undefined;

  if (!alvAddress) {
    const alvKeys = Object.keys(atomicVaults);
    // Never inferred, not even when the network has exactly one atomic vault: the target
    // of a strategy write is stated explicitly or the script refuses to run.
    alvKey = process.env.ALV_KEY?.trim();
    if (!alvKey) {
      console.error("❌ Error: set ALV_KEY (or ALV_ADDRESS) — the target vault is never inferred.");
      console.log("Atomic vaults in this deployment:", alvKeys.join(", ") || "(none)");
      process.exit(1);
    }
    alvRecord = atomicVaults[alvKey];
    if (!alvRecord?.proxyAddress) {
      console.error(`❌ Error: atomic vault '${alvKey}' not found (or has no proxyAddress).`);
      console.log("Available:", alvKeys.join(", ") || "(none)");
      process.exit(1);
    }
    alvAddress = alvRecord.proxyAddress;
    console.log(`Atomic Vault: ${alvKey} -> ${alvAddress}`);
  } else {
    console.log("Atomic Vault:", alvAddress, "(from ALV_ADDRESS)");
  }

  const execute = process.env.EXECUTE?.toLowerCase() === "true";
  const detaching = newStrategy === ethers.ZeroAddress;

  const alv = await ethers.getContractAt("AtomicLiquidity", alvAddress);
  const collateralToken: string = await alv.collateralToken();
  const onChainProtocolConfig: string = await alv.protocolConfig();
  const onChainAdmin: string = (await alv.roles()).admin;
  const currentStrategy: string = await alv.strategy();

  const collateral = new ethers.Contract(collateralToken, ERC4626_METADATA_ABI, signer);
  const collateralDecimals = Number(await collateral.decimals());
  const collateralSymbol: string = await collateral.symbol();
  const fmt = (value: bigint) =>
    `${ethers.formatUnits(value, collateralDecimals)} ${collateralSymbol}`;

  console.log("\n" + "=".repeat(70));
  console.log("📋 Resolved configuration");
  console.log("=".repeat(70));
  console.log("Atomic Vault      :", alvAddress);
  console.log(
    "  collateralToken :",
    collateralToken,
    `(${collateralSymbol}, ${collateralDecimals}dp)`
  );
  console.log("  protocolConfig  :", onChainProtocolConfig);
  console.log("  admin           :", onChainAdmin);
  console.log("  totalAssets     :", fmt(await alv.totalAssets()));
  console.log(
    "Current strategy  :",
    currentStrategy === ethers.ZeroAddress ? "(none)" : currentStrategy
  );
  console.log("New strategy      :", detaching ? "(none — detaching)" : newStrategy);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (signer.address.toLowerCase() !== onChainAdmin.toLowerCase()) {
    errors.push(
      `Signer ${signer.address} is not the vault admin ${onChainAdmin}. Only the admin can set the strategy.`
    );
  }
  if (currentStrategy.toLowerCase() === newStrategy.toLowerCase()) {
    errors.push(`Strategy is already ${currentStrategy}. setStrategy reverts SameValue.`);
  }

  const declaredProtocolConfig =
    alvRecord?.protocolConfig || deploymentInfo.contracts?.protocolConfig?.proxyAddress;
  if (
    declaredProtocolConfig &&
    declaredProtocolConfig.toLowerCase() !== onChainProtocolConfig.toLowerCase()
  ) {
    warnings.push(
      `Deployment JSON says protocolConfig ${declaredProtocolConfig} but the vault reports ${onChainProtocolConfig}. Routing through the vault's own — onlyProtocolConfig checks that one.`
    );
  }

  if (!detaching) {
    const strategy = new ethers.Contract(newStrategy, ERC4626_METADATA_ABI, signer);
    try {
      const strategyAsset: string = await strategy.asset();
      console.log("  name            :", await strategy.name());
      console.log("  symbol          :", await strategy.symbol());
      console.log("  decimals        :", Number(await strategy.decimals()));
      console.log("  asset()         :", strategyAsset);
      console.log("  totalAssets     :", fmt(await strategy.totalAssets()));
      if (strategyAsset.toLowerCase() !== collateralToken.toLowerCase()) {
        errors.push(
          `Strategy asset() ${strategyAsset} != vault collateralToken ${collateralToken}. setStrategy reverts InvalidStrategy.`
        );
      }
    } catch (error: any) {
      errors.push(`Could not read ${newStrategy} as an ERC-4626: ${error.message}`);
    }
  }

  // Surface the silent drain of the outgoing strategy before it happens.
  if (currentStrategy !== ethers.ZeroAddress) {
    try {
      const previous = new ethers.Contract(currentStrategy, ERC4626_METADATA_ABI, signer);
      const heldShares: bigint = await previous.balanceOf(alvAddress);
      const heldAssets: bigint = heldShares > 0n ? await previous.convertToAssets(heldShares) : 0n;
      console.log("\n📤 Outgoing strategy position (will be drained inside setStrategy):");
      console.log("  shares          :", heldShares.toString());
      console.log("  assets          :", fmt(heldAssets));
      if (heldAssets > 0n) {
        warnings.push(
          `${fmt(heldAssets)} will be withdrawn from ${currentStrategy} via a direct prev.withdraw() — this emits NO StrategyWithdrawn event, so indexers will not see the outflow.`
        );
      }
    } catch (error: any) {
      warnings.push(`Could not read the outgoing strategy position: ${error.message}`);
    }
  }

  for (const warning of warnings) console.log("⚠️ ", warning);
  if (errors.length > 0) {
    console.error("\n❌ Pre-flight failed:");
    for (const error of errors) console.error("  -", error);
    process.exit(1);
  }

  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", onChainProtocolConfig);

  console.log("\n" + "=".repeat(70));
  console.log("🧮 Calldata");
  console.log("=".repeat(70));
  console.log("to  :", onChainProtocolConfig);
  console.log(
    "data:",
    protocolConfig.interface.encodeFunctionData("setVaultStrategy", [alvAddress, newStrategy])
  );

  console.log("\n🧪 Simulating (staticCall)...");
  await protocolConfig.setVaultStrategy.staticCall(alvAddress, newStrategy);
  console.log("✅ Simulation passed.");

  if (!execute) {
    console.log("\nℹ️ Dry run only. Re-run with EXECUTE=true to send the transaction.");
    return;
  }

  console.log("\n🚀 Sending transaction...");
  const tx = await protocolConfig.setVaultStrategy(alvAddress, newStrategy);
  console.log("Transaction hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block:", receipt?.blockNumber);

  const updated: string = await alv.strategy();
  console.log("Strategy now      :", updated);
  if (updated.toLowerCase() !== newStrategy.toLowerCase()) {
    console.error(`❌ Verification failed. Expected ${newStrategy} but got ${updated}.`);
    process.exit(1);
  }

  if (alvKey && alvRecord && alvRecord.strategyAddress !== newStrategy) {
    alvRecord.strategyAddress = newStrategy;
    fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
    console.log("📝 Deployment JSON strategyAddress synchronized:", deploymentFileName);
  }

  console.log("\n✅ Strategy set.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
