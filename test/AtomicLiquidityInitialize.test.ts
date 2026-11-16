import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { AtomicLiquidity, EmberProtocolConfig, ERC20Token } from "../typechain-types";
import { DEFAULTS } from "./helpers/atomicLiquidity";

/**
 * Covers AtomicLiquidity.initialize, whose validation, sub-account writes and VaultCreated
 * emit live in AtomicLiquidityLib. The library runs under DELEGATECALL, so every assertion
 * here is also an assertion that the split is invisible from outside: the custom errors are
 * the same ones, the log is attributed to the proxy, and the storage the vault reads back is
 * the storage the library wrote.
 */
describe("AtomicLiquidity - Initialization", function () {
  let owner: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let subAccount: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  let protocolConfig: EmberProtocolConfig;
  let collateralToken: ERC20Token;
  let vaultFactory: Awaited<ReturnType<typeof ethers.getContractFactory>>;

  type InitParams = {
    name: string;
    collateralToken: string;
    admin: string;
    operator: string;
    rateManager: string;
    maxRateChangePerUpdate: bigint;
    feePercentage: bigint;
    minWithdrawableShares: bigint;
    rateUpdateInterval: number;
    maxTVL: bigint;
  };

  let baseParams: InitParams;

  beforeEach(async function () {
    [owner, feeRecipient, admin, operator, rateManager, subAccount, outsider] =
      await ethers.getSigners();

    protocolConfig = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberProtocolConfig"),
      [owner.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberProtocolConfig;
    await protocolConfig.waitForDeployment();

    collateralToken = (await upgrades.deployProxy(
      await ethers.getContractFactory("ERC20Token"),
      [owner.address, "USD Coin", "USDC", 18, ethers.parseUnits("100000000", 18)],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as ERC20Token;
    await collateralToken.waitForDeployment();

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

    vaultFactory = await ethers.getContractFactory("AtomicLiquidity", {
      libraries: {
        AtomicLiquidityLib: await lib.getAddress(),
        VaultPlatformFeeLib: await feeLib.getAddress(),
        WithdrawalQueueLib: await queueLib.getAddress(),
      },
    });

    baseParams = {
      name: DEFAULTS.vaultName,
      collateralToken: await collateralToken.getAddress(),
      admin: admin.address,
      operator: operator.address,
      rateManager: rateManager.address,
      maxRateChangePerUpdate: DEFAULTS.maxRateChangePerUpdate,
      feePercentage: DEFAULTS.feePercentage,
      minWithdrawableShares: DEFAULTS.minWithdrawableShares,
      rateUpdateInterval: DEFAULTS.rateUpdateInterval,
      maxTVL: DEFAULTS.maxTVL,
    };
  });

  async function deploy(
    overrides: Partial<InitParams> = {},
    subAccounts: string[] = [],
    configAddress?: string
  ): Promise<AtomicLiquidity> {
    return (await upgrades.deployProxy(
      vaultFactory,
      [
        configAddress ?? (await protocolConfig.getAddress()),
        owner.address,
        { ...baseParams, ...overrides },
        subAccounts,
      ],
      { initializer: "initialize", kind: "uups", unsafeAllowLinkedLibraries: true }
    )) as unknown as AtomicLiquidity;
  }

  describe("Success Cases", function () {
    it("should record every initializer argument in storage", async function () {
      const vault = await deploy({}, [subAccount.address]);

      expect(await vault.owner()).to.equal(owner.address);
      expect(await vault.protocolConfig()).to.equal(await protocolConfig.getAddress());
      expect(await vault.vaultName()).to.equal(baseParams.name);
      expect(await vault.collateralToken()).to.equal(baseParams.collateralToken);
      expect(await vault.maxTVL()).to.equal(baseParams.maxTVL);
      expect(await vault.minWithdrawableShares()).to.equal(baseParams.minWithdrawableShares);
      expect(await vault.sequenceNumber()).to.equal(0);

      const roles = await vault.roles();
      expect(roles.admin).to.equal(admin.address);
      expect(roles.operator).to.equal(operator.address);
      expect(roles.rateManager).to.equal(rateManager.address);

      const rate = await vault.rate();
      expect(rate.value).to.equal(await protocolConfig.getDefaultRate());
      expect(rate.maxRateChangePerUpdate).to.equal(baseParams.maxRateChangePerUpdate);
      expect(rate.rateUpdateInterval).to.equal(baseParams.rateUpdateInterval);

      const fee = await vault.platformFee();
      expect(fee.accrued).to.equal(0);
      expect(fee.platformFeePercentage).to.equal(baseParams.feePercentage);
    });

    it("should whitelist the sub accounts written by the library", async function () {
      const vault = await deploy({}, [subAccount.address]);

      expect(await vault.subAccounts(subAccount.address)).to.be.true;
      expect(await vault.subAccounts(outsider.address)).to.be.false;
    });

    it("should emit VaultCreated from the proxy, not the library", async function () {
      const vault = await deploy({}, [subAccount.address]);
      const vaultAddress = await vault.getAddress();

      const logs = await vault.queryFilter(vault.filters.VaultCreated());
      expect(logs.length).to.equal(1);

      const event = logs[0];
      expect(event.address).to.equal(vaultAddress);
      expect(event.args.vault).to.equal(vaultAddress);
      expect(event.args.name).to.equal(baseParams.name);
      expect(event.args.collateralToken).to.equal(baseParams.collateralToken);
      expect(event.args.admin).to.equal(admin.address);
      expect(event.args.operator).to.equal(operator.address);
      expect(event.args.rateProvider).to.equal(rateManager.address);
      expect(event.args.subAccounts).to.deep.equal([subAccount.address]);
      expect(event.args.minWithdrawableShares).to.equal(baseParams.minWithdrawableShares);
      expect(event.args.feePercentage).to.equal(baseParams.feePercentage);
      expect(event.args.maxRateChangePerUpdate).to.equal(baseParams.maxRateChangePerUpdate);
      expect(event.args.rateUpdateInterval).to.equal(baseParams.rateUpdateInterval);
      expect(event.args.rate).to.equal(await protocolConfig.getDefaultRate());
      expect(event.args.maxTVL).to.equal(baseParams.maxTVL);
      expect(event.args.sequenceNumber).to.equal(0);
      expect(event.args.timestamp).to.be.greaterThan(0);
    });
  });

  describe("Validation", function () {
    it("should revert when the protocol config is the zero address", async function () {
      await expect(deploy({}, [], ethers.ZeroAddress)).to.be.revertedWithCustomError(
        vaultFactory,
        "ZeroAddress"
      );
    });

    it("should revert when a role is the zero address", async function () {
      for (const role of ["admin", "operator", "rateManager"] as const) {
        await expect(deploy({ [role]: ethers.ZeroAddress })).to.be.revertedWithCustomError(
          vaultFactory,
          "ZeroAddress"
        );
      }
    });

    it("should revert when two roles are the same account", async function () {
      await expect(deploy({ operator: admin.address })).to.be.revertedWithCustomError(
        vaultFactory,
        "InvalidValue"
      );
      await expect(deploy({ rateManager: admin.address })).to.be.revertedWithCustomError(
        vaultFactory,
        "InvalidValue"
      );
      await expect(deploy({ rateManager: operator.address })).to.be.revertedWithCustomError(
        vaultFactory,
        "InvalidValue"
      );
    });

    it("should revert when the collateral token is the zero address", async function () {
      await expect(deploy({ collateralToken: ethers.ZeroAddress })).to.be.revertedWithCustomError(
        vaultFactory,
        "ZeroAddress"
      );
    });

    it("should revert when the rate interval is outside the protocol bounds", async function () {
      const min = await protocolConfig.getMinRateInterval();
      const max = await protocolConfig.getMaxRateInterval();

      await expect(deploy({ rateUpdateInterval: Number(min) - 1 })).to.be.revertedWithCustomError(
        vaultFactory,
        "InvalidInterval"
      );
      await expect(deploy({ rateUpdateInterval: Number(max) + 1 })).to.be.revertedWithCustomError(
        vaultFactory,
        "InvalidInterval"
      );
    });

    it("should revert when maxRateChangePerUpdate is zero", async function () {
      await expect(deploy({ maxRateChangePerUpdate: 0n })).to.be.revertedWithCustomError(
        vaultFactory,
        "InvalidRate"
      );
    });

    it("should revert when the fee exceeds the protocol maximum", async function () {
      const max = await protocolConfig.getMaxAllowedFeePercentage();
      await expect(deploy({ feePercentage: max + 1n })).to.be.revertedWithCustomError(
        vaultFactory,
        "InvalidValue"
      );
    });

    it("should revert when the name is empty", async function () {
      await expect(deploy({ name: "" })).to.be.revertedWithCustomError(
        vaultFactory,
        "InvalidValue"
      );
    });

    it("should revert when minWithdrawableShares or maxTVL is zero", async function () {
      await expect(deploy({ minWithdrawableShares: 0n })).to.be.revertedWithCustomError(
        vaultFactory,
        "ZeroAmount"
      );
      await expect(deploy({ maxTVL: 0n })).to.be.revertedWithCustomError(
        vaultFactory,
        "ZeroAmount"
      );
    });

    it("should revert when a role is blacklisted", async function () {
      await protocolConfig.connect(owner).setBlacklistedAccount(admin.address, true);
      await expect(deploy()).to.be.revertedWithCustomError(vaultFactory, "Blacklisted");
    });

    it("should revert when a sub account is the zero address", async function () {
      await expect(deploy({}, [ethers.ZeroAddress])).to.be.revertedWithCustomError(
        vaultFactory,
        "ZeroAddress"
      );
    });

    it("should revert when a sub account duplicates a role", async function () {
      await expect(deploy({}, [operator.address])).to.be.revertedWithCustomError(
        vaultFactory,
        "InvalidValue"
      );
    });

    it("should revert on a second initialize call", async function () {
      const vault = await deploy();
      await expect(
        vault.initialize(await protocolConfig.getAddress(), owner.address, baseParams, [])
      ).to.be.revertedWithCustomError(vault, "InvalidInitialization");
    });
  });
});
