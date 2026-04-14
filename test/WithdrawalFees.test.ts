import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type {
  EmberVault,
  EmberProtocolConfig,
  EmberVaultValidator,
  ERC20Token,
  FixedPointMathWrapper,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmberVault - Withdrawal Fees & Deposit Allow List", function () {
  let vault: EmberVault;
  let protocolConfig: EmberProtocolConfig;
  let validator: EmberVaultValidator;
  let math: FixedPointMathWrapper;
  let collateralToken: ERC20Token;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let user3: HardhatEthersSigner;
  let receiver1: HardhatEthersSigner;
  let receiver2: HardhatEthersSigner;
  let subAccount1: HardhatEthersSigner;
  let subAccount2: HardhatEthersSigner;

  let vaultAddress: string;

  const VAULT_NAME = "Test Vault";
  const RATE_UPDATE_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
  const MAX_RATE_CHANGE_PER_UPDATE = ethers.parseUnits("0.1", 18);
  const FEE_PERCENTAGE = ethers.parseUnits("0.05", 18);
  const MIN_WITHDRAWABLE_SHARES = ethers.parseUnits("1", 18);
  const MAX_TVL = ethers.parseUnits("1000000", 18);
  const INITIAL_RATE = ethers.parseUnits("1", 18);

  beforeEach(async function () {
    [
      owner,
      admin,
      operator,
      rateManager,
      feeRecipient,
      user1,
      user2,
      user3,
      receiver1,
      receiver2,
      subAccount1,
      subAccount2,
    ] = await ethers.getSigners();

    // Deploy Protocol Config
    const configFactory = await ethers.getContractFactory("EmberProtocolConfig");
    protocolConfig = (await upgrades.deployProxy(
      configFactory,
      [owner.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as EmberProtocolConfig;
    await protocolConfig.waitForDeployment();

    // Deploy Collateral Token
    const collateralFactory = await ethers.getContractFactory("ERC20Token");
    collateralToken = (await upgrades.deployProxy(
      collateralFactory,
      [owner.address, "Collateral Token", "COLL", 18, ethers.parseUnits("10000000", 18)],
      { initializer: "initialize", kind: "uups" }
    )) as ERC20Token;
    await collateralToken.waitForDeployment();

    // Deploy FixedPointMathWrapper for testing
    const mathFactory = await ethers.getContractFactory("FixedPointMathWrapper");
    math = (await mathFactory.deploy()) as FixedPointMathWrapper;
    await math.waitForDeployment();

    // Deploy Vault
    const vaultFactory = await ethers.getContractFactory("EmberVault");
    const initParams = {
      name: VAULT_NAME,
      receiptTokenSymbol: "EVLT",
      collateralToken: await collateralToken.getAddress(),
      admin: admin.address,
      operator: operator.address,
      rateManager: rateManager.address,
      maxRateChangePerUpdate: MAX_RATE_CHANGE_PER_UPDATE,
      feePercentage: FEE_PERCENTAGE,
      minWithdrawableShares: MIN_WITHDRAWABLE_SHARES,
      rateUpdateInterval: RATE_UPDATE_INTERVAL,
      maxTVL: MAX_TVL,
    };

    vault = (await upgrades.deployProxy(
      vaultFactory,
      [
        await protocolConfig.getAddress(),
        owner.address,
        initParams,
        [subAccount1.address, subAccount2.address],
      ],
      { initializer: "initialize", kind: "uups" }
    )) as EmberVault;
    await vault.waitForDeployment();
    vaultAddress = await vault.getAddress();

    // Deploy Validator
    const validatorFactory = await ethers.getContractFactory("EmberVaultValidator");
    validator = (await upgrades.deployProxy(
      validatorFactory,
      [await protocolConfig.getAddress(), owner.address],
      { initializer: "initialize", kind: "uups" }
    )) as EmberVaultValidator;
    await validator.waitForDeployment();

    // Set validator on vault (via protocol config, caller must be admin)
    await protocolConfig
      .connect(admin)
      .setVaultValidator(vaultAddress, await validator.getAddress());

    // Distribute collateral tokens to users for testing
    const collateralAmount = ethers.parseUnits("100000", 18);
    await collateralToken.connect(owner).transfer(user1.address, collateralAmount);
    await collateralToken.connect(owner).transfer(user2.address, collateralAmount);
    await collateralToken.connect(owner).transfer(user3.address, collateralAmount);

    // Approve vault for all users
    const approveAmount = ethers.parseUnits("100000", 18);
    await collateralToken.connect(user1).approve(vaultAddress, approveAmount);
    await collateralToken.connect(user2).approve(vaultAddress, approveAmount);
    await collateralToken.connect(user3).approve(vaultAddress, approveAmount);
  });

  // ============================================
  // Deposit Allow List Tests
  // ============================================

  describe("setVaultDepositAllowList (via ProtocolConfig)", function () {
    describe("Success Cases", function () {
      it("should add a user to the deposit allow list", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultDepositAllowList(vaultAddress, user1.address, true)
        )
          .to.emit(validator, "VaultDepositAllowListUpdated")
          .withArgs(
            vaultAddress,
            user1.address,
            true,
            (ts: any) => {
              expect(ts).to.be.a("bigint");
              return true;
            },
            (seq: any) => {
              expect(seq).to.be.a("bigint");
              return true;
            }
          );

        expect(await validator.depositAllowList(vaultAddress, user1.address)).to.equal(true);
        expect(await validator.depositAllowListCount(vaultAddress)).to.equal(1n);
      });

      it("should remove a user from the deposit allow list", async function () {
        await protocolConfig
          .connect(operator)
          .setVaultDepositAllowList(vaultAddress, user1.address, true);
        expect(await validator.depositAllowListCount(vaultAddress)).to.equal(1n);

        await expect(
          protocolConfig
            .connect(operator)
            .setVaultDepositAllowList(vaultAddress, user1.address, false)
        ).to.emit(validator, "VaultDepositAllowListUpdated");

        expect(await validator.depositAllowList(vaultAddress, user1.address)).to.equal(false);
        expect(await validator.depositAllowListCount(vaultAddress)).to.equal(0n);
      });

      it("should add multiple users to the deposit allow list", async function () {
        await protocolConfig
          .connect(operator)
          .setVaultDepositAllowList(vaultAddress, user1.address, true);
        await protocolConfig
          .connect(operator)
          .setVaultDepositAllowList(vaultAddress, user2.address, true);

        expect(await validator.depositAllowListCount(vaultAddress)).to.equal(2n);
        expect(await validator.depositAllowList(vaultAddress, user1.address)).to.equal(true);
        expect(await validator.depositAllowList(vaultAddress, user2.address)).to.equal(true);
      });

      it("should update state correctly", async function () {
        await protocolConfig
          .connect(operator)
          .setVaultDepositAllowList(vaultAddress, user1.address, true);
        expect(await validator.depositAllowList(vaultAddress, user1.address)).to.equal(true);
        expect(await validator.depositAllowListCount(vaultAddress)).to.equal(1n);
      });
    });

    describe("Validation", function () {
      it("should revert when called by non-operator", async function () {
        await expect(
          protocolConfig.connect(admin).setVaultDepositAllowList(vaultAddress, user1.address, true)
        ).to.be.revertedWithCustomError(vault, "Unauthorized");
      });

      it("should revert when called by user", async function () {
        await expect(
          protocolConfig.connect(user1).setVaultDepositAllowList(vaultAddress, user1.address, true)
        ).to.be.revertedWithCustomError(vault, "Unauthorized");
      });

      it("should revert when setting same value", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultDepositAllowList(vaultAddress, user1.address, false)
        ).to.be.revertedWithCustomError(protocolConfig, "SameValue");
      });

      it("should revert when adding a blacklisted user", async function () {
        await protocolConfig.connect(owner).setBlacklistedAccount(user3.address, true);
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultDepositAllowList(vaultAddress, user3.address, true)
        ).to.be.revertedWithCustomError(protocolConfig, "Blacklisted");
      });

      it("should revert when adding the admin address", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultDepositAllowList(vaultAddress, admin.address, true)
        ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
      });

      it("should revert when adding the operator address", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultDepositAllowList(vaultAddress, operator.address, true)
        ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
      });

      it("should revert when adding the rate manager address", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultDepositAllowList(vaultAddress, rateManager.address, true)
        ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
      });

      it("should revert when adding zero address", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultDepositAllowList(vaultAddress, ethers.ZeroAddress, true)
        ).to.be.revertedWithCustomError(protocolConfig, "ZeroAddress");
      });
    });
  });

  describe("Deposit Allow List - Deposit Restrictions", function () {
    it("should block deposits from non-whitelisted users when list is active", async function () {
      await protocolConfig
        .connect(operator)
        .setVaultDepositAllowList(vaultAddress, user1.address, true);

      const depositAmount = ethers.parseUnits("1000", 18);
      await expect(
        vault.connect(user2).deposit(depositAmount, user2.address)
      ).to.be.revertedWithCustomError(validator, "DepositNotAllowed");
    });

    it("should allow deposits from whitelisted users", async function () {
      await protocolConfig
        .connect(operator)
        .setVaultDepositAllowList(vaultAddress, user1.address, true);

      const depositAmount = ethers.parseUnits("1000", 18);
      await expect(vault.connect(user1).deposit(depositAmount, user1.address)).to.emit(
        vault,
        "VaultDeposit"
      );

      expect(await vault.balanceOf(user1.address)).to.be.gt(0n);
    });

    it("should allow all deposits when list is inactive (count = 0)", async function () {
      const depositAmount = ethers.parseUnits("1000", 18);
      await vault.connect(user1).deposit(depositAmount, user1.address);
      await vault.connect(user2).deposit(depositAmount, user2.address);

      expect(await vault.balanceOf(user1.address)).to.be.gt(0n);
      expect(await vault.balanceOf(user2.address)).to.be.gt(0n);
    });

    it("should re-allow all deposits after removing all users from allow list", async function () {
      await protocolConfig
        .connect(operator)
        .setVaultDepositAllowList(vaultAddress, user1.address, true);

      const depositAmount = ethers.parseUnits("1000", 18);
      await expect(
        vault.connect(user2).deposit(depositAmount, user2.address)
      ).to.be.revertedWithCustomError(validator, "DepositNotAllowed");

      await protocolConfig
        .connect(operator)
        .setVaultDepositAllowList(vaultAddress, user1.address, false);
      expect(await validator.depositAllowListCount(vaultAddress)).to.equal(0n);

      await vault.connect(user2).deposit(depositAmount, user2.address);
      expect(await vault.balanceOf(user2.address)).to.be.gt(0n);
    });

    it("should block mint from non-whitelisted users when list is active", async function () {
      await protocolConfig
        .connect(operator)
        .setVaultDepositAllowList(vaultAddress, user1.address, true);

      const sharesToMint = ethers.parseUnits("1000", 18);
      await expect(
        vault.connect(user2).mint(sharesToMint, user2.address)
      ).to.be.revertedWithCustomError(validator, "DepositNotAllowed");
    });

    it("should allow mint from whitelisted users", async function () {
      await protocolConfig
        .connect(operator)
        .setVaultDepositAllowList(vaultAddress, user1.address, true);

      const sharesToMint = ethers.parseUnits("1000", 18);
      await vault.connect(user1).mint(sharesToMint, user1.address);
      expect(await vault.balanceOf(user1.address)).to.be.gt(0n);
    });
  });

  // ============================================
  // Fee Exemption List Tests
  // ============================================

  describe("setVaultFeeExemptionList (via ProtocolConfig)", function () {
    describe("Success Cases", function () {
      it("should add a user to the fee exemption list", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultFeeExemptionList(vaultAddress, user1.address, true)
        )
          .to.emit(validator, "VaultFeeExemptListUpdated")
          .withArgs(
            vaultAddress,
            user1.address,
            true,
            (ts: any) => {
              expect(ts).to.be.a("bigint");
              return true;
            },
            (seq: any) => {
              expect(seq).to.be.a("bigint");
              return true;
            }
          );

        expect(await validator.feeExemptAccounts(vaultAddress, user1.address)).to.equal(true);
      });

      it("should remove a user from the fee exemption list", async function () {
        await protocolConfig
          .connect(operator)
          .setVaultFeeExemptionList(vaultAddress, user1.address, true);
        await protocolConfig
          .connect(operator)
          .setVaultFeeExemptionList(vaultAddress, user1.address, false);
        expect(await validator.feeExemptAccounts(vaultAddress, user1.address)).to.equal(false);
      });

      it("should update state correctly", async function () {
        await protocolConfig
          .connect(operator)
          .setVaultFeeExemptionList(vaultAddress, user1.address, true);
        expect(await validator.feeExemptAccounts(vaultAddress, user1.address)).to.equal(true);
      });
    });

    describe("Validation", function () {
      it("should revert when called by non-operator", async function () {
        await expect(
          protocolConfig.connect(admin).setVaultFeeExemptionList(vaultAddress, user1.address, true)
        ).to.be.revertedWithCustomError(vault, "Unauthorized");
      });

      it("should revert when setting same value", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultFeeExemptionList(vaultAddress, user1.address, false)
        ).to.be.revertedWithCustomError(protocolConfig, "SameValue");
      });

      it("should revert when adding a blacklisted user", async function () {
        await protocolConfig.connect(owner).setBlacklistedAccount(user3.address, true);
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultFeeExemptionList(vaultAddress, user3.address, true)
        ).to.be.revertedWithCustomError(protocolConfig, "Blacklisted");
      });

      it("should revert when adding the admin address", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultFeeExemptionList(vaultAddress, admin.address, true)
        ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
      });

      it("should revert when adding the operator address", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultFeeExemptionList(vaultAddress, operator.address, true)
        ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
      });

      it("should revert when adding the rate manager address", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultFeeExemptionList(vaultAddress, rateManager.address, true)
        ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
      });

      it("should revert when adding zero address", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .setVaultFeeExemptionList(vaultAddress, ethers.ZeroAddress, true)
        ).to.be.revertedWithCustomError(protocolConfig, "ZeroAddress");
      });
    });
  });

  // ============================================
  // Permanent Fee Percentage Tests
  // ============================================

  describe("updateVaultPermanentFeePercentage (via ProtocolConfig)", function () {
    describe("Success Cases", function () {
      it("should set permanent fee percentage", async function () {
        const newPercentage = ethers.parseUnits("0.01", 18); // 1%
        await expect(
          protocolConfig
            .connect(admin)
            .updateVaultPermanentFeePercentage(vaultAddress, newPercentage)
        )
          .to.emit(validator, "VaultPermanentFeePercentageUpdated")
          .withArgs(
            vaultAddress,
            0n,
            newPercentage,
            (ts: any) => {
              expect(ts).to.be.a("bigint");
              return true;
            },
            (seq: any) => {
              expect(seq).to.be.a("bigint");
              return true;
            }
          );

        const fee = await validator.withdrawalFee(vaultAddress);
        expect(fee.permanentFeePercentage).to.equal(newPercentage);
      });

      it("should update permanent fee percentage from non-zero to another value", async function () {
        const firstPercentage = ethers.parseUnits("0.01", 18);
        const secondPercentage = ethers.parseUnits("0.02", 18);

        await protocolConfig
          .connect(admin)
          .updateVaultPermanentFeePercentage(vaultAddress, firstPercentage);
        await protocolConfig
          .connect(admin)
          .updateVaultPermanentFeePercentage(vaultAddress, secondPercentage);

        const fee = await validator.withdrawalFee(vaultAddress);
        expect(fee.permanentFeePercentage).to.equal(secondPercentage);
      });

      it("should allow setting percentage to zero", async function () {
        const newPercentage = ethers.parseUnits("0.01", 18);
        await protocolConfig
          .connect(admin)
          .updateVaultPermanentFeePercentage(vaultAddress, newPercentage);
        await protocolConfig.connect(admin).updateVaultPermanentFeePercentage(vaultAddress, 0n);

        const fee = await validator.withdrawalFee(vaultAddress);
        expect(fee.permanentFeePercentage).to.equal(0n);
      });
    });

    describe("Validation", function () {
      it("should revert when called by non-admin", async function () {
        await expect(
          protocolConfig
            .connect(operator)
            .updateVaultPermanentFeePercentage(vaultAddress, ethers.parseUnits("0.01", 18))
        ).to.be.revertedWithCustomError(validator, "Unauthorized");
      });

      it("should revert when percentage >= 1e18 (100%)", async function () {
        await expect(
          protocolConfig
            .connect(admin)
            .updateVaultPermanentFeePercentage(vaultAddress, ethers.parseUnits("1", 18))
        ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
      });

      it("should revert when percentage > 1e18", async function () {
        await expect(
          protocolConfig
            .connect(admin)
            .updateVaultPermanentFeePercentage(vaultAddress, ethers.parseUnits("1.5", 18))
        ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
      });

      it("should revert when setting same value", async function () {
        await expect(
          protocolConfig.connect(admin).updateVaultPermanentFeePercentage(vaultAddress, 0n)
        ).to.be.revertedWithCustomError(protocolConfig, "SameValue");
      });
    });
  });

  // ============================================
  // Time-Based Fee Percentage Tests
  // ============================================

  describe("updateVaultTimeBasedFeePercentage (via ProtocolConfig)", function () {
    describe("Success Cases", function () {
      it("should set time-based fee percentage", async function () {
        const newPercentage = ethers.parseUnits("0.05", 18); // 5%
        await expect(
          protocolConfig
            .connect(admin)
            .updateVaultTimeBasedFeePercentage(vaultAddress, newPercentage)
        )
          .to.emit(validator, "VaultTimeBasedFeePercentageUpdated")
          .withArgs(
            vaultAddress,
            0n,
            newPercentage,
            (ts: any) => {
              expect(ts).to.be.a("bigint");
              return true;
            },
            (seq: any) => {
              expect(seq).to.be.a("bigint");
              return true;
            }
          );

        const fee = await validator.withdrawalFee(vaultAddress);
        expect(fee.timeBasedFeePercentage).to.equal(newPercentage);
      });
    });

    describe("Validation", function () {
      it("should revert when called by non-admin", async function () {
        await expect(
          protocolConfig
            .connect(user1)
            .updateVaultTimeBasedFeePercentage(vaultAddress, ethers.parseUnits("0.05", 18))
        ).to.be.revertedWithCustomError(validator, "Unauthorized");
      });

      it("should revert when percentage >= 1e18", async function () {
        await expect(
          protocolConfig
            .connect(admin)
            .updateVaultTimeBasedFeePercentage(vaultAddress, ethers.parseUnits("1", 18))
        ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
      });

      it("should revert when setting same value", async function () {
        await expect(
          protocolConfig.connect(admin).updateVaultTimeBasedFeePercentage(vaultAddress, 0n)
        ).to.be.revertedWithCustomError(protocolConfig, "SameValue");
      });
    });
  });

  // ============================================
  // Time-Based Fee Threshold Tests
  // ============================================

  describe("updateVaultTimeBasedFeeThreshold (via ProtocolConfig)", function () {
    describe("Success Cases", function () {
      it("should set time-based fee threshold", async function () {
        const newThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
        await expect(
          protocolConfig.connect(admin).updateVaultTimeBasedFeeThreshold(vaultAddress, newThreshold)
        )
          .to.emit(validator, "VaultTimeBasedFeeThresholdUpdated")
          .withArgs(
            vaultAddress,
            0n,
            BigInt(newThreshold),
            (ts: any) => {
              expect(ts).to.be.a("bigint");
              return true;
            },
            (seq: any) => {
              expect(seq).to.be.a("bigint");
              return true;
            }
          );

        const fee = await validator.withdrawalFee(vaultAddress);
        expect(fee.timeBasedFeeThreshold).to.equal(BigInt(newThreshold));
      });

      it("should allow setting threshold to zero", async function () {
        const threshold = 7 * 24 * 60 * 60 * 1000;
        await protocolConfig
          .connect(admin)
          .updateVaultTimeBasedFeeThreshold(vaultAddress, threshold);
        await protocolConfig.connect(admin).updateVaultTimeBasedFeeThreshold(vaultAddress, 0);

        const fee = await validator.withdrawalFee(vaultAddress);
        expect(fee.timeBasedFeeThreshold).to.equal(0n);
      });
    });

    describe("Validation", function () {
      it("should revert when called by non-admin", async function () {
        await expect(
          protocolConfig.connect(user1).updateVaultTimeBasedFeeThreshold(vaultAddress, 1000)
        ).to.be.revertedWithCustomError(validator, "Unauthorized");
      });

      it("should revert when setting same value", async function () {
        await expect(
          protocolConfig.connect(admin).updateVaultTimeBasedFeeThreshold(vaultAddress, 0)
        ).to.be.revertedWithCustomError(protocolConfig, "SameValue");
      });
    });
  });

  // ============================================
  // Last Deposit Timestamp Tracking Tests
  // ============================================

  describe("Last Deposit Timestamp Tracking", function () {
    it("should record lastDepositTimestamp on deposit", async function () {
      const depositAmount = ethers.parseUnits("1000", 18);

      expect(await validator.lastDepositTimestamp(vaultAddress, user1.address)).to.equal(0n);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      const lastDeposit = await validator.lastDepositTimestamp(vaultAddress, user1.address);
      expect(lastDeposit).to.be.gt(0n);
    });

    it("should record lastDepositTimestamp for receiver on deposit", async function () {
      const depositAmount = ethers.parseUnits("1000", 18);

      await vault.connect(user1).deposit(depositAmount, user2.address);

      const lastDepositReceiver = await validator.lastDepositTimestamp(vaultAddress, user2.address);
      expect(lastDepositReceiver).to.be.gt(0n);
    });

    it("should update lastDepositTimestamp on subsequent deposits", async function () {
      const depositAmount = ethers.parseUnits("1000", 18);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      const firstTimestamp = await validator.lastDepositTimestamp(vaultAddress, user1.address);

      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      const secondTimestamp = await validator.lastDepositTimestamp(vaultAddress, user1.address);

      expect(secondTimestamp).to.be.gt(firstTimestamp);
    });

    it("should record lastDepositTimestamp on mint", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      await vault.connect(user1).mint(sharesToMint, user1.address);

      const lastDeposit = await validator.lastDepositTimestamp(vaultAddress, user1.address);
      expect(lastDeposit).to.be.gt(0n);
    });
  });

  // ============================================
  // Withdrawal Fee Calculation Tests
  // ============================================

  describe("Withdrawal Fee - Permanent Fee", function () {
    const depositAmount = ethers.parseUnits("10000", 18);

    beforeEach(async function () {
      await vault.connect(user1).deposit(depositAmount, user1.address);
      await vault.connect(user2).deposit(depositAmount, user2.address);
    });

    it("should deduct permanent fee from withdrawal amount", async function () {
      const permanentFee = ethers.parseUnits("0.01", 18);
      await protocolConfig
        .connect(admin)
        .updateVaultPermanentFeePercentage(vaultAddress, permanentFee);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const receiverBalanceBefore = await collateralToken.balanceOf(receiver1.address);
      const vaultBalanceBefore = await collateralToken.balanceOf(vaultAddress);

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      const grossWithdrawAmount = await math.div(sharesToRedeem, INITIAL_RATE);
      const expectedFee = await math.mul(grossWithdrawAmount, permanentFee);
      const expectedNetAmount = grossWithdrawAmount - expectedFee;

      const receiverBalanceAfter = await collateralToken.balanceOf(receiver1.address);
      const vaultBalanceAfter = await collateralToken.balanceOf(vaultAddress);

      expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + expectedNetAmount);
      expect(vaultBalanceBefore - vaultBalanceAfter).to.equal(expectedNetAmount);

      const feeEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "WithdrawalFeeCharged"
      );
      expect(feeEvent).to.not.be.undefined;
      const parsedFee = vault.interface.parseLog(feeEvent!);
      expect(parsedFee?.args.permanentFeeCharged).to.equal(expectedFee);
      expect(parsedFee?.args.timeBasedFeeCharged).to.equal(0n);

      const processedEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestProcessed"
      );
      expect(processedEvent).to.not.be.undefined;
      const parsed = vault.interface.parseLog(processedEvent!);
      expect(parsed?.args.withdrawAmount).to.equal(expectedNetAmount);
    });

    it("should not charge fee when permanent fee is zero", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const receiverBalanceBefore = await collateralToken.balanceOf(receiver1.address);

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      const grossWithdrawAmount = await math.div(sharesToRedeem, INITIAL_RATE);
      const receiverBalanceAfter = await collateralToken.balanceOf(receiver1.address);

      expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + grossWithdrawAmount);

      const feeEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "WithdrawalFeeCharged"
      );
      // When no fees are configured, WithdrawalFeeCharged may not be emitted or both fields are 0
      if (feeEvent) {
        const parsedFee = vault.interface.parseLog(feeEvent!);
        expect(parsedFee?.args.permanentFeeCharged).to.equal(0n);
        expect(parsedFee?.args.timeBasedFeeCharged).to.equal(0n);
      }
    });
  });

  describe("Withdrawal Fee - Time-Based Fee", function () {
    const depositAmount = ethers.parseUnits("10000", 18);

    beforeEach(async function () {
      await vault.connect(user1).deposit(depositAmount, user1.address);
      await vault.connect(user2).deposit(depositAmount, user2.address);
    });

    it("should charge time-based fee when withdrawal is within threshold", async function () {
      const timeBasedFee = ethers.parseUnits("0.05", 18);
      const threshold = 7 * 24 * 60 * 60 * 1000;
      await protocolConfig
        .connect(admin)
        .updateVaultTimeBasedFeePercentage(vaultAddress, timeBasedFee);
      await protocolConfig.connect(admin).updateVaultTimeBasedFeeThreshold(vaultAddress, threshold);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      const grossWithdrawAmount = await math.div(sharesToRedeem, INITIAL_RATE);
      const expectedTimeBasedFee = await math.mul(grossWithdrawAmount, timeBasedFee);
      const expectedNetAmount = grossWithdrawAmount - expectedTimeBasedFee;

      const receiverBalance = await collateralToken.balanceOf(receiver1.address);
      expect(receiverBalance).to.equal(expectedNetAmount);

      const feeEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "WithdrawalFeeCharged"
      );
      const parsedFee = vault.interface.parseLog(feeEvent!);
      expect(parsedFee?.args.permanentFeeCharged).to.equal(0n);
      expect(parsedFee?.args.timeBasedFeeCharged).to.equal(expectedTimeBasedFee);
    });

    it("should NOT charge time-based fee when withdrawal is after threshold", async function () {
      const timeBasedFee = ethers.parseUnits("0.05", 18);
      const threshold = 1 * 60 * 60 * 1000; // 1 hour in ms
      await protocolConfig
        .connect(admin)
        .updateVaultTimeBasedFeePercentage(vaultAddress, timeBasedFee);
      await protocolConfig.connect(admin).updateVaultTimeBasedFeeThreshold(vaultAddress, threshold);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      await ethers.provider.send("evm_increaseTime", [2 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      const grossWithdrawAmount = await math.div(sharesToRedeem, INITIAL_RATE);

      const receiverBalance = await collateralToken.balanceOf(receiver1.address);
      expect(receiverBalance).to.equal(grossWithdrawAmount);

      const feeEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "WithdrawalFeeCharged"
      );
      if (feeEvent) {
        const parsedFee = vault.interface.parseLog(feeEvent!);
        expect(parsedFee?.args.timeBasedFeeCharged).to.equal(0n);
      }
    });
  });

  describe("Withdrawal Fee - Combined Fees", function () {
    const depositAmount = ethers.parseUnits("10000", 18);

    beforeEach(async function () {
      await vault.connect(user1).deposit(depositAmount, user1.address);
      await vault.connect(user2).deposit(depositAmount, user2.address);
    });

    it("should charge both permanent and time-based fees when applicable", async function () {
      const permanentFee = ethers.parseUnits("0.01", 18);
      const timeBasedFee = ethers.parseUnits("0.05", 18);
      const threshold = 7 * 24 * 60 * 60 * 1000;

      await protocolConfig
        .connect(admin)
        .updateVaultPermanentFeePercentage(vaultAddress, permanentFee);
      await protocolConfig
        .connect(admin)
        .updateVaultTimeBasedFeePercentage(vaultAddress, timeBasedFee);
      await protocolConfig.connect(admin).updateVaultTimeBasedFeeThreshold(vaultAddress, threshold);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      const grossWithdrawAmount = await math.div(sharesToRedeem, INITIAL_RATE);
      const expectedPermanentFee = await math.mul(grossWithdrawAmount, permanentFee);
      const expectedTimeBasedFee = await math.mul(grossWithdrawAmount, timeBasedFee);
      const expectedNetAmount = grossWithdrawAmount - expectedPermanentFee - expectedTimeBasedFee;

      const receiverBalance = await collateralToken.balanceOf(receiver1.address);
      expect(receiverBalance).to.equal(expectedNetAmount);

      const feeEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "WithdrawalFeeCharged"
      );
      const parsedFee = vault.interface.parseLog(feeEvent!);
      expect(parsedFee?.args.permanentFeeCharged).to.equal(expectedPermanentFee);
      expect(parsedFee?.args.timeBasedFeeCharged).to.equal(expectedTimeBasedFee);

      const processedEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestProcessed"
      );
      const parsed = vault.interface.parseLog(processedEvent!);
      expect(parsed?.args.withdrawAmount).to.equal(expectedNetAmount);
    });

    it("should only charge permanent fee when past time threshold", async function () {
      const permanentFee = ethers.parseUnits("0.01", 18);
      const timeBasedFee = ethers.parseUnits("0.05", 18);
      const threshold = 1 * 60 * 60 * 1000; // 1 hour

      await protocolConfig
        .connect(admin)
        .updateVaultPermanentFeePercentage(vaultAddress, permanentFee);
      await protocolConfig
        .connect(admin)
        .updateVaultTimeBasedFeePercentage(vaultAddress, timeBasedFee);
      await protocolConfig.connect(admin).updateVaultTimeBasedFeeThreshold(vaultAddress, threshold);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      await ethers.provider.send("evm_increaseTime", [2 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      const grossWithdrawAmount = await math.div(sharesToRedeem, INITIAL_RATE);
      const expectedPermanentFee = await math.mul(grossWithdrawAmount, permanentFee);
      const expectedNetAmount = grossWithdrawAmount - expectedPermanentFee;

      const receiverBalance = await collateralToken.balanceOf(receiver1.address);
      expect(receiverBalance).to.equal(expectedNetAmount);

      const feeEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "WithdrawalFeeCharged"
      );
      const parsedFee = vault.interface.parseLog(feeEvent!);
      expect(parsedFee?.args.permanentFeeCharged).to.equal(expectedPermanentFee);
      expect(parsedFee?.args.timeBasedFeeCharged).to.equal(0n);
    });

    it("should keep fees in the vault (fees not transferred out)", async function () {
      const permanentFee = ethers.parseUnits("0.01", 18);
      await protocolConfig
        .connect(admin)
        .updateVaultPermanentFeePercentage(vaultAddress, permanentFee);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const vaultBalanceBefore = await collateralToken.balanceOf(vaultAddress);

      await vault.connect(operator).processWithdrawalRequests(1);

      const vaultBalanceAfter = await collateralToken.balanceOf(vaultAddress);

      const grossWithdrawAmount = await math.div(sharesToRedeem, INITIAL_RATE);
      const expectedFee = await math.mul(grossWithdrawAmount, permanentFee);
      const expectedNetAmount = grossWithdrawAmount - expectedFee;

      expect(vaultBalanceBefore - vaultBalanceAfter).to.equal(expectedNetAmount);
    });
  });

  // ============================================
  // Fee Exemption Tests
  // ============================================

  describe("Withdrawal Fee - Exemption", function () {
    const depositAmount = ethers.parseUnits("10000", 18);

    beforeEach(async function () {
      await vault.connect(user1).deposit(depositAmount, user1.address);
      await vault.connect(user2).deposit(depositAmount, user2.address);

      await protocolConfig
        .connect(admin)
        .updateVaultPermanentFeePercentage(vaultAddress, ethers.parseUnits("0.01", 18));
      await protocolConfig
        .connect(admin)
        .updateVaultTimeBasedFeePercentage(vaultAddress, ethers.parseUnits("0.05", 18));
      await protocolConfig
        .connect(admin)
        .updateVaultTimeBasedFeeThreshold(vaultAddress, 7 * 24 * 60 * 60 * 1000);
    });

    it("should not charge fees for exempt users", async function () {
      await protocolConfig
        .connect(operator)
        .setVaultFeeExemptionList(vaultAddress, user1.address, true);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      const grossWithdrawAmount = await math.div(sharesToRedeem, INITIAL_RATE);
      const receiverBalance = await collateralToken.balanceOf(receiver1.address);

      expect(receiverBalance).to.equal(grossWithdrawAmount);

      const feeEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "WithdrawalFeeCharged"
      );
      if (feeEvent) {
        const parsedFee = vault.interface.parseLog(feeEvent!);
        expect(parsedFee?.args.permanentFeeCharged).to.equal(0n);
        expect(parsedFee?.args.timeBasedFeeCharged).to.equal(0n);
      }
    });

    it("should charge fees for non-exempt users", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user2).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user2).redeemShares(sharesToRedeem, receiver2.address);

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      const feeEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "WithdrawalFeeCharged"
      );
      const parsedFee = vault.interface.parseLog(feeEvent!);

      expect(parsedFee?.args.permanentFeeCharged).to.be.gt(0n);
      expect(parsedFee?.args.timeBasedFeeCharged).to.be.gt(0n);
    });

    it("should resume charging fees after removing exemption", async function () {
      await protocolConfig
        .connect(operator)
        .setVaultFeeExemptionList(vaultAddress, user1.address, true);
      await protocolConfig
        .connect(operator)
        .setVaultFeeExemptionList(vaultAddress, user1.address, false);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      const feeEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "WithdrawalFeeCharged"
      );
      const parsedFee = vault.interface.parseLog(feeEvent!);

      expect(parsedFee?.args.permanentFeeCharged).to.be.gt(0n);
    });
  });

  // ============================================
  // Skipped/Cancelled Request Fee Tests
  // ============================================

  describe("Withdrawal Fee - Skipped and Cancelled Requests", function () {
    const depositAmount = ethers.parseUnits("10000", 18);

    beforeEach(async function () {
      await vault.connect(user1).deposit(depositAmount, user1.address);
      await protocolConfig
        .connect(admin)
        .updateVaultPermanentFeePercentage(vaultAddress, ethers.parseUnits("0.01", 18));
    });

    it("should not charge fees on cancelled requests", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const request = await vault.getPendingWithdrawal(0);
      await vault.connect(user1).cancelPendingWithdrawalRequest(request.sequenceNumber);

      const user1SharesBefore = await vault.balanceOf(user1.address);

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      const processedEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestProcessed"
      );
      const parsed = vault.interface.parseLog(processedEvent!);
      expect(parsed?.args.cancelled).to.equal(true);
      expect(parsed?.args.skipped).to.equal(true);
      expect(parsed?.args.withdrawAmount).to.equal(0n);

      // For cancelled requests, WithdrawalFeeCharged should not be emitted or fees should be 0
      const feeEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "WithdrawalFeeCharged"
      );
      if (feeEvent) {
        const parsedFee = vault.interface.parseLog(feeEvent!);
        expect(parsedFee?.args.permanentFeeCharged).to.equal(0n);
        expect(parsedFee?.args.timeBasedFeeCharged).to.equal(0n);
      }

      const user1SharesAfter = await vault.balanceOf(user1.address);
      expect(user1SharesAfter).to.equal(user1SharesBefore + sharesToRedeem);
    });
  });

  // ============================================
  // Multiple Users Fee Tests
  // ============================================

  describe("Withdrawal Fee - Multiple Users", function () {
    const depositAmount = ethers.parseUnits("10000", 18);

    beforeEach(async function () {
      await vault.connect(user1).deposit(depositAmount, user1.address);
      await vault.connect(user2).deposit(depositAmount, user2.address);

      await protocolConfig
        .connect(admin)
        .updateVaultPermanentFeePercentage(vaultAddress, ethers.parseUnits("0.02", 18));
    });

    it("should charge fees independently for each user in batch processing", async function () {
      await protocolConfig
        .connect(operator)
        .setVaultFeeExemptionList(vaultAddress, user1.address, true);

      const shares1 = ethers.parseUnits("1000", 18);
      const shares2 = ethers.parseUnits("2000", 18);

      await vault.connect(user1).approve(vaultAddress, shares1);
      await vault.connect(user2).approve(vaultAddress, shares2);

      await vault.connect(user1).redeemShares(shares1, receiver1.address);
      await vault.connect(user2).redeemShares(shares2, receiver2.address);

      await vault.connect(operator).processWithdrawalRequests(2);

      const grossAmount1 = await math.div(shares1, INITIAL_RATE);
      const grossAmount2 = await math.div(shares2, INITIAL_RATE);
      const expectedFee2 = await math.mul(grossAmount2, ethers.parseUnits("0.02", 18));

      expect(await collateralToken.balanceOf(receiver1.address)).to.equal(grossAmount1);
      expect(await collateralToken.balanceOf(receiver2.address)).to.equal(
        grossAmount2 - expectedFee2
      );
    });
  });

  // ============================================
  // Initial State Tests
  // ============================================

  describe("Initial State", function () {
    it("should have all withdrawal fee values initialized to zero", async function () {
      const fee = await validator.withdrawalFee(vaultAddress);
      expect(fee.permanentFeePercentage).to.equal(0n);
      expect(fee.timeBasedFeePercentage).to.equal(0n);
      expect(fee.timeBasedFeeThreshold).to.equal(0n);
    });

    it("should have deposit allow list inactive", async function () {
      expect(await validator.depositAllowListCount(vaultAddress)).to.equal(0n);
    });

    it("should have no fee exempt accounts", async function () {
      expect(await validator.feeExemptAccounts(vaultAddress, user1.address)).to.equal(false);
    });

    it("should have no last deposit timestamps", async function () {
      expect(await validator.lastDepositTimestamp(vaultAddress, user1.address)).to.equal(0n);
    });
  });
});
