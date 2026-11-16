import { ethers } from "hardhat";
import * as fs from "fs";
import { getCcipConfig, poolKeyForVault } from "../../config/ccip.config";

/**
 * Deploys an EmberTokenPool for a vault's receipt token, through EmberTokenPoolFactory.
 *
 * The pool is CREATE2-deployed with the salt namespaced by the caller, so the address is
 * predictable before the transaction lands — which is what lets both sides of a lane be wired
 * without a chicken-and-egg. The factory proposes ownership; POOL_OWNER must accept it, and
 * this script does that automatically when the deployer is also the owner.
 *
 * Nothing is live after this runs: the pool cannot mint until it is set as the vault's
 * bridgeAdapter (yarn bridge:set-adapter) and registered in the TokenAdminRegistry.
 *
 * Required ENV:
 *   VAULT_KEY   Key of the vault in the deployment file (e.g. "emberTestCcipVault")
 *
 * Optional ENV:
 *   POOL_OWNER  Address that will own the pool. Defaults to the deployer.
 *   FACTORY     Reuse an existing EmberTokenPoolFactory instead of deploying one.
 *   POOL_HOOKS  IAdvancedPoolHooks contract. Defaults to address(0), i.e. the chain's
 *               default CCV set and no pool-level allowlist.
 *   SALT        CREATE2 salt string. Defaults to "ember.ccip.pool.v1".
 *   IS_ETH_VAULT  "true" to look the vault up under ethVaults.
 */
/** Calls a view fn, returning undefined instead of throwing. */
async function tryCall<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

async function main() {
  console.log("\n🌉 Deploying EmberTokenPool...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const ccip = getCcipConfig(networkName);

  console.log("Network:", ccip.label, `(${networkName}, chainId ${network.chainId})`);
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "\n"
  );

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  const isEthVault = process.env.IS_ETH_VAULT === "true";
  const vaults = isEthVault ? deploymentInfo.contracts.ethVaults : deploymentInfo.contracts.vaults;

  const vaultKey = process.env.VAULT_KEY;
  if (!vaultKey || !vaults?.[vaultKey]) {
    console.error("❌ Error: VAULT_KEY is required and must exist in the deployment file.");
    console.log("\nAvailable vaults:");
    Object.keys(vaults ?? {}).forEach((k) => console.log(`  - ${k}: ${vaults[k].proxyAddress}`));
    process.exit(1);
  }
  const vaultInfo = vaults[vaultKey];
  const tokenAddress: string = vaultInfo.proxyAddress;

  // The vault IS the receipt ERC-20; the pool validates decimals against it at construction.
  const token = await ethers.getContractAt("IEmberVaultToken", tokenAddress);
  const decimals = await token.decimals();
  const currentAdapter = await token.bridgeAdapter();

  const poolOwner = process.env.POOL_OWNER || deployer.address;
  const poolHooks = process.env.POOL_HOOKS || ethers.ZeroAddress;
  const saltString = process.env.SALT || "ember.ccip.pool.v1";
  const salt = ethers.id(saltString);

  console.log("Pool configuration:");
  console.log("  Vault key:        ", vaultKey);
  console.log("  Token (vault):    ", tokenAddress);
  console.log("  Token decimals:   ", decimals.toString());
  console.log("  Router:           ", ccip.router);
  console.log("  RMN proxy:        ", ccip.rmnProxy);
  console.log("  Pool owner:       ", poolOwner);
  console.log("  Advanced hooks:   ", poolHooks, poolHooks === ethers.ZeroAddress ? "(none)" : "");
  console.log("  Salt:             ", saltString);
  console.log("  Current adapter:  ", currentAdapter);
  console.log();

  if (currentAdapter !== ethers.ZeroAddress) {
    console.log("⚠️  The vault already has a bridge adapter set. Deploying the pool is still");
    console.log("    safe — it stays inert until setVaultBridgeAdapter points at it — but the");
    console.log("    cutover will revoke", currentAdapter, "\n");
  }

  // ---- preflight: the immutables ---------------------------------------------------
  // i_token, i_tokenDecimals and i_rmnProxy are constructor immutables. A wrong RMN address
  // cannot be corrected later — and because Solidity's high-level calls check extcodesize, a
  // codeless RMN makes every lockOrBurn and releaseOrMint revert, so the pool is inert and must
  // be redeployed. Prove both the Router and the RMN are live contracts before spending gas.
  for (const [label, addr] of [
    ["Router", ccip.router],
    ["RMN proxy", ccip.rmnProxy],
  ] as [string, string][]) {
    if ((await ethers.provider.getCode(addr)) === "0x") {
      console.error(`❌ Error: no contract at ${label} ${addr} on ${networkName}.`);
      console.log("   These are constructor immutables — a pool deployed against a wrong address");
      console.log("   cannot be fixed and would have to be redeployed. Correct");
      console.log("   config/ccip.config.ts and re-run. `yarn ccip:verify-config` cross-checks");
      console.log("   every address against the chain.");
      process.exit(1);
    }
  }

  // The RMN must also answer the call the pool actually makes on every transfer.
  const rmnSubject = ethers.zeroPadValue(ethers.toBeHex(ccip.chainSelector), 16);
  const rmnOk = await tryCall(() =>
    new ethers.Contract(
      ccip.rmnProxy,
      ["function isCursed(bytes16) view returns (bool)"],
      ethers.provider
    )["isCursed(bytes16)"](rmnSubject)
  );
  if (rmnOk === undefined) {
    console.error(`❌ Error: RMN proxy ${ccip.rmnProxy} did not answer isCursed(bytes16).`);
    console.log("   The pool calls this on every lockOrBurn and releaseOrMint, so it would");
    console.log("   revert on every transfer. Check the address in config/ccip.config.ts.");
    process.exit(1);
  }

  // ---- factory -------------------------------------------------------------------
  // Factory addresses are per-chain. A recorded or env-supplied address from a different chain
  // has no code here, and every later call then returns "0x" and fails to decode — so assert
  // code exists rather than letting it surface as BAD_DATA several calls downstream.
  let factoryAddress = process.env.FACTORY || deploymentInfo.contracts.ccipPoolFactory?.address;
  if (factoryAddress) {
    if ((await ethers.provider.getCode(factoryAddress)) === "0x") {
      const source = process.env.FACTORY ? "the FACTORY env var" : deploymentFileName;
      console.error(`❌ Error: no contract at factory ${factoryAddress} on ${networkName}.`);
      console.log(`   The address came from ${source}.`);
      console.log("   Factory addresses are chain-specific — an address from another chain will");
      console.log("   not exist here. Unset FACTORY (or remove contracts.ccipPoolFactory from the");
      console.log("   deployment file) to deploy a fresh factory on this chain.");
      process.exit(1);
    }
    console.log("📦 Reusing EmberTokenPoolFactory at", factoryAddress);
  } else {
    console.log("Deploying EmberTokenPoolFactory...");
    const factoryContract = await (
      await ethers.getContractFactory("EmberTokenPoolFactory")
    ).deploy();
    await factoryContract.waitForDeployment();
    factoryAddress = await factoryContract.getAddress();

    // Some L2 RPCs sit behind a load balancer and can serve a read from a node that has not yet
    // seen the deployment block, so confirm the code is visible before relying on it.
    if ((await ethers.provider.getCode(factoryAddress)) === "0x") {
      console.error(`❌ Error: deployed the factory to ${factoryAddress} but the RPC reports no`);
      console.log("   code there. This is usually RPC lag rather than a failed deployment.");
      console.log("   Re-run with FACTORY set to that address once it is visible:");
      console.log(
        `     FACTORY=${factoryAddress} VAULT_KEY=${vaultKey} yarn ccip:deploy-pool --network ${networkName}`
      );
      process.exit(1);
    }
    console.log("✅ EmberTokenPoolFactory deployed to:", factoryAddress);
  }
  const factory = await ethers.getContractAt("EmberTokenPoolFactory", factoryAddress);

  // ---- predict + deploy ----------------------------------------------------------
  const predicted = await factory.predictPoolAddress(
    tokenAddress,
    decimals,
    poolHooks,
    ccip.rmnProxy,
    ccip.router,
    deployer.address,
    salt
  );
  console.log("\n🔮 Predicted pool address:", predicted);

  // Resume rather than refuse when the pool is already there. A deploy that lands but whose
  // follow-up step fails — an under-estimated gas limit, a dropped RPC response — would otherwise
  // strand the run with no way forward except a new salt and a wasted deployment.
  let deploymentBlockNumber = 0;
  const existingCode = await ethers.provider.getCode(predicted);
  const pool = await ethers.getContractAt("EmberTokenPool", predicted);

  if (existingCode !== "0x") {
    const existingToken = await tryCall(() => pool.getToken());
    if (!existingToken || existingToken.toLowerCase() !== tokenAddress.toLowerCase()) {
      console.error("\n❌ Error: a contract already exists at the predicted address, and it is");
      console.log("   not a pool for this token. Use a different SALT.");
      console.log("   found token:", existingToken ?? "(not a pool)");
      process.exit(1);
    }
    console.log("\n♻️  Pool already deployed at this address for this token — resuming.");
    console.log("   Skipping deployment and continuing with ownership and recording.");
  } else {
    console.log("Deploying EmberTokenPool through the factory...");
    const tx = await factory.deployPool(
      tokenAddress,
      decimals,
      poolHooks,
      ccip.rmnProxy,
      ccip.router,
      poolOwner,
      salt
    );
    const receipt = await tx.wait();
    deploymentBlockNumber = receipt?.blockNumber ?? 0;
    console.log("✅ EmberTokenPool deployed to:", predicted);
    console.log("📦 Deployed in block:", deploymentBlockNumber);
  }

  // ---- ownership -----------------------------------------------------------------
  const currentOwner = await pool.owner();
  if (currentOwner.toLowerCase() === poolOwner.toLowerCase()) {
    console.log("\n✅ Ownership already accepted by", poolOwner);
  } else if (poolOwner.toLowerCase() === deployer.address.toLowerCase()) {
    console.log("\nAccepting ownership (deployer is the pool owner)...");
    await (await pool.acceptOwnership()).wait();
    console.log("✅ Ownership accepted");
  } else {
    console.log("\n⚠️  Ownership has been PROPOSED to", poolOwner);
    console.log("    That account must call acceptOwnership() on the pool before it can");
    console.log("    configure lanes. Until then the pool cannot be wired.");
  }

  // ---- report --------------------------------------------------------------------
  const [owner, typeAndVersion, poolToken, rmn] = await Promise.all([
    pool.owner(),
    pool.typeAndVersion(),
    pool.getToken(),
    pool.getRmnProxy(),
  ]);
  console.log("\n📊 Pool details:");
  console.log("  typeAndVersion:", typeAndVersion);
  console.log("  owner:         ", owner);
  console.log("  token:         ", poolToken);
  console.log("  rmnProxy:      ", rmn);

  if (!deploymentInfo.contracts.ccipPoolFactory) {
    deploymentInfo.contracts.ccipPoolFactory = {
      address: factoryAddress,
      deployedAt: new Date().toISOString(),
    };
  }
  if (!deploymentInfo.contracts.ccipTokenPools) deploymentInfo.contracts.ccipTokenPools = {};

  const poolKey = poolKeyForVault(vaultKey);
  deploymentInfo.contracts.ccipTokenPools[poolKey] = {
    address: predicted,
    contractName: "EmberTokenPool",
    typeAndVersion,
    vaultKey,
    vaultAddress: tokenAddress,
    receiptTokenSymbol: vaultInfo.receiptTokenSymbol,
    decimals: Number(decimals),
    router: ccip.router,
    rmnProxy: ccip.rmnProxy,
    tokenAdminRegistry: ccip.tokenAdminRegistry,
    registryModule: ccip.registryModule,
    chainSelector: ccip.chainSelector.toString(),
    advancedPoolHooks: poolHooks,
    owner,
    factory: factoryAddress,
    salt: saltString,
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber,
    lanes: {},
  };

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2) + "\n");
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 EmberTokenPool deployment complete");
  console.log("=".repeat(70));
  console.log("Pool key:    ", poolKey);
  console.log("Pool address:", predicted);
  console.log("\n💡 Next steps (the pool is inert until all of these are done):");
  console.log("1. Deploy the pool on the remote chain, then wire both directions:");
  console.log(`   VAULT_KEY=${vaultKey} yarn ccip:apply-chain-updates --network ${networkName}`);
  console.log("2. Register the token with CCIP (admin flow, needs the vault owner):");
  console.log(`   VAULT_KEY=${vaultKey} yarn ccip:register-admin --network ${networkName}`);
  console.log("3. Cut over — point the vault's bridgeAdapter at the pool:");
  console.log(
    `   VAULT_KEY=${vaultKey} ADAPTER_ADDRESS=${predicted} yarn bridge:set-adapter --network ${networkName}`
  );
  console.log("4. Verify the whole lane (checks both chains):");
  console.log(`   yarn ccip:verify-config`);
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
