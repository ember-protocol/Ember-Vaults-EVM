import { ethers, upgrades, network } from "hardhat";
import type {
  AtomicLiquidity,
  EmberProtocolConfig,
  ERC20Token,
  MockERC4626,
  EmberVault,
} from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

export interface DeployedSetup {
  protocolConfig: EmberProtocolConfig;
  collateralToken: ERC20Token;
  vault: AtomicLiquidity;
  /** Signer impersonating the protocol-config contract address — needed because the
   *  AtomicLiquidity admin setters added in this branch (setStrategy, setEmberShareWhitelist,
   *  setMaxInstantWithdrawShares, setInstantWithdrawFeePercentage) don't yet have dispatch
   *  wrappers in EmberProtocolConfig. Tests call those setters directly via this signer. */
  configSigner: HardhatEthersSigner;
}

export interface BasicConfig {
  vaultName: string;
  rateUpdateInterval: number;
  maxRateChangePerUpdate: bigint;
  feePercentage: bigint;
  minWithdrawableShares: bigint;
  maxTVL: bigint;
}

export const DEFAULTS: BasicConfig = {
  vaultName: "Atomic Liquidity Vault",
  rateUpdateInterval: 2 * 60 * 60 * 1000, // 2h in ms
  maxRateChangePerUpdate: ethers.parseUnits("0.1", 18),
  feePercentage: ethers.parseUnits("0.01", 18),
  minWithdrawableShares: ethers.parseUnits("1", 18),
  maxTVL: ethers.parseUnits("10000000", 18),
};

/** Deploys ProtocolConfig, ERC20 collateral, and AtomicLiquidity vault. Funds users with
 *  collateral and pre-approves the vault for them. */
export async function deployBaseSetup(args: {
  owner: HardhatEthersSigner;
  feeRecipient: HardhatEthersSigner;
  admin: HardhatEthersSigner;
  operator: HardhatEthersSigner;
  rateManager: HardhatEthersSigner;
  fundUsers?: HardhatEthersSigner[];
  subAccounts?: HardhatEthersSigner[];
  config?: Partial<BasicConfig>;
  /** Override the collateral contract (must share ERC20Token's initialize signature).
   *  Defaults to "ERC20Token"; pass "BlocklistableERC20" to test failed-transfer paths. */
  collateralFactoryName?: string;
}): Promise<DeployedSetup> {
  const { owner, feeRecipient, admin, operator, rateManager } = args;
  const config = { ...DEFAULTS, ...(args.config ?? {}) };

  const configFactory = await ethers.getContractFactory("EmberProtocolConfig");
  const protocolConfig = (await upgrades.deployProxy(
    configFactory,
    [owner.address, feeRecipient.address],
    { initializer: "initialize", kind: "uups" }
  )) as unknown as EmberProtocolConfig;
  await protocolConfig.waitForDeployment();

  const tokenFactory = await ethers.getContractFactory(args.collateralFactoryName ?? "ERC20Token");
  const collateralToken = (await upgrades.deployProxy(
    tokenFactory,
    [owner.address, "USD Coin", "USDC", 18, ethers.parseUnits("100000000", 18)],
    { initializer: "initialize", kind: "uups" }
  )) as unknown as ERC20Token;
  await collateralToken.waitForDeployment();

  // Deploy and link the external libraries AtomicLiquidity uses for its heavy code paths
  // (AtomicLiquidityLib: EmberShare swap, holdback release, instant withdraw; VaultPlatformFeeLib:
  // time-based platform fee). Without these, getContractFactory throws "missing links".
  // WithdrawalQueueLib must be deployed first: AtomicLiquidityLib links to it (processRequest
  // calls WithdrawalQueueLib.updateAccountState), and AtomicLiquidity links it directly too.
  const queueLib = await (await ethers.getContractFactory("WithdrawalQueueLib")).deploy();
  await queueLib.waitForDeployment();
  const lib = await (
    await ethers.getContractFactory("AtomicLiquidityLib", {
      libraries: { WithdrawalQueueLib: await queueLib.getAddress() },
    })
  ).deploy();
  await lib.waitForDeployment();
  const feeLib = await (await ethers.getContractFactory("VaultPlatformFeeLib")).deploy();
  await feeLib.waitForDeployment();

  const vaultFactory = await ethers.getContractFactory("AtomicLiquidity", {
    libraries: {
      AtomicLiquidityLib: await lib.getAddress(),
      VaultPlatformFeeLib: await feeLib.getAddress(),
      WithdrawalQueueLib: await queueLib.getAddress(),
    },
  });
  const initParams = {
    name: config.vaultName,
    collateralToken: await collateralToken.getAddress(),
    admin: admin.address,
    operator: operator.address,
    rateManager: rateManager.address,
    maxRateChangePerUpdate: config.maxRateChangePerUpdate,
    feePercentage: config.feePercentage,
    minWithdrawableShares: config.minWithdrawableShares,
    rateUpdateInterval: config.rateUpdateInterval,
    maxTVL: config.maxTVL,
  };
  const subAccountAddrs = (args.subAccounts ?? []).map((s) => s.address);

  const vault = (await upgrades.deployProxy(
    vaultFactory,
    [await protocolConfig.getAddress(), owner.address, initParams, subAccountAddrs],
    {
      initializer: "initialize",
      kind: "uups",
      // Library is non-upgradeable bytecode; safe to link in this implementation slot.
      unsafeAllowLinkedLibraries: true,
    }
  )) as unknown as AtomicLiquidity;
  await vault.waitForDeployment();

  // Fund users with collateral and pre-approve vault.
  if (args.fundUsers) {
    const userBalance = ethers.parseUnits("1000000", 18);
    for (const user of args.fundUsers) {
      await collateralToken.connect(owner).transfer(user.address, userBalance);
      await collateralToken.connect(user).approve(await vault.getAddress(), userBalance);
    }
  }

  const configSigner = await impersonateContract(await protocolConfig.getAddress());

  return { protocolConfig, collateralToken, vault, configSigner };
}

/** Deploys a real EmberVault using the same protocol config + collateral token, so tests can
 *  swap genuine EmberVault shares against the AtomicLiquidity vault. */
export async function deployEmberVault(args: {
  owner: HardhatEthersSigner;
  protocolConfig: EmberProtocolConfig;
  collateralToken: ERC20Token;
  admin: HardhatEthersSigner;
  operator: HardhatEthersSigner;
  rateManager: HardhatEthersSigner;
  subAccounts?: HardhatEthersSigner[];
  config?: Partial<BasicConfig & { receiptTokenSymbol: string }>;
}): Promise<EmberVault> {
  const cfg = { ...DEFAULTS, ...(args.config ?? {}) };
  const factory = await ethers.getContractFactory("EmberVault");
  const initParams = {
    name: "Source Ember Vault",
    receiptTokenSymbol: "EMBR",
    collateralToken: await args.collateralToken.getAddress(),
    admin: args.admin.address,
    operator: args.operator.address,
    rateManager: args.rateManager.address,
    maxRateChangePerUpdate: cfg.maxRateChangePerUpdate,
    feePercentage: cfg.feePercentage,
    minWithdrawableShares: cfg.minWithdrawableShares,
    rateUpdateInterval: cfg.rateUpdateInterval,
    maxTVL: cfg.maxTVL,
  };
  const subAccountAddrs = (args.subAccounts ?? []).map((s) => s.address);

  const ember = (await upgrades.deployProxy(
    factory,
    [await args.protocolConfig.getAddress(), args.owner.address, initParams, subAccountAddrs],
    { initializer: "initialize", kind: "uups" }
  )) as unknown as EmberVault;
  await ember.waitForDeployment();
  return ember;
}

/** Deploys a Mock ERC-4626 strategy backed by `asset`. */
export async function deployMockStrategy(
  asset: ERC20Token,
  name = "Strategy Vault",
  symbol = "sUSDC"
): Promise<MockERC4626> {
  const factory = await ethers.getContractFactory("MockERC4626");
  const strat = (await factory.deploy(
    await asset.getAddress(),
    name,
    symbol
  )) as unknown as MockERC4626;
  await strat.waitForDeployment();
  return strat;
}

/** Impersonates a contract address as a signer with a generous ETH balance for gas. */
export async function impersonateContract(address: string): Promise<HardhatEthersSigner> {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  await network.provider.send("hardhat_setBalance", [
    address,
    "0x" + ethers.parseEther("100").toString(16),
  ]);
  return ethers.getSigner(address) as unknown as HardhatEthersSigner;
}
