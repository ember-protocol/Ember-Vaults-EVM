import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type {
  EmberVault,
  EmberProtocolConfig,
  ERC20Token,
  FixedPointMathWrapper,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmberVault - Withdraw From Vault Without Redeeming Shares", function () {
  let vault: EmberVault;
  let protocolConfig: EmberProtocolConfig;
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
  let subAccount1: HardhatEthersSigner;
  let subAccount2: HardhatEthersSigner;
  let nonSubAccount: HardhatEthersSigner;

  const VAULT_NAME = "Test Vault";
  const RATE_UPDATE_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
  const MAX_RATE_CHANGE_PER_UPDATE = ethers.parseUnits("0.1", 18);
  const FEE_PERCENTAGE = ethers.parseUnits("0.05", 18);
  const MIN_WITHDRAWABLE_SHARES = ethers.parseUnits("1", 18);
  const MAX_TVL = ethers.parseUnits("1000000", 18);

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
      subAccount1,
      subAccount2,
      nonSubAccount,
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

    // Deploy Math contract
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

    // Distribute collateral tokens to users for testing
    const collateralAmount = ethers.parseUnits("100000", 18);
    await collateralToken.connect(owner).transfer(user1.address, collateralAmount);
    await collateralToken.connect(owner).transfer(user2.address, collateralAmount);
    await collateralToken.connect(owner).transfer(user3.address, collateralAmount);

    // Users deposit to vault to create vault balance
    const depositAmount = ethers.parseUnits("10000", 18);
    await collateralToken.connect(user1).approve(await vault.getAddress(), depositAmount * 10n);
    await collateralToken.connect(user2).approve(await vault.getAddress(), depositAmount * 10n);
    await collateralToken.connect(user3).approve(await vault.getAddress(), depositAmount * 10n);

    await vault.connect(user1).deposit(depositAmount, user1.address);
    await vault.connect(user2).deposit(depositAmount, user2.address);
    await vault.connect(user3).deposit(depositAmount, user3.address);
  });

  describe("Success Cases", function () {
    it("should allow manager to withdraw to whitelisted sub account", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());
      const subAccountBalanceBefore = await collateralToken.balanceOf(subAccount1.address);

      const sequenceNumberBefore = await vault.sequenceNumber();

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      )
        .to.emit(vault, "VaultWithdrawalWithoutRedeemingShares")
        .withArgs(
          await vault.getAddress(),
          subAccount1.address,
          vaultBalanceBefore,
          vaultBalanceBefore - withdrawAmount,
          withdrawAmount,
          (timestamp: any) => {
            expect(timestamp).to.be.a("bigint");
            return true;
          },
          sequenceNumberBefore + 1n
        );

      // Verify balances
      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
      const subAccountBalanceAfter = await collateralToken.balanceOf(subAccount1.address);

      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore - withdrawAmount);
      expect(subAccountBalanceAfter).to.equal(subAccountBalanceBefore + withdrawAmount);
    });

    it("should transfer correct amount to sub account", async function () {
      const withdrawAmount = ethers.parseUnits("5000", 18);
      const subAccountBalanceBefore = await collateralToken.balanceOf(subAccount1.address);

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);

      const subAccountBalanceAfter = await collateralToken.balanceOf(subAccount1.address);
      expect(subAccountBalanceAfter).to.equal(subAccountBalanceBefore + withdrawAmount);
    });

    it("should update vault balance correctly", async function () {
      const withdrawAmount = ethers.parseUnits("2000", 18);
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);

      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore - withdrawAmount);
    });

    it("should allow multiple withdrawals to same sub account", async function () {
      const withdrawAmount1 = ethers.parseUnits("1000", 18);
      const withdrawAmount2 = ethers.parseUnits("2000", 18);

      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount1);
      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount2);

      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore - withdrawAmount1 - withdrawAmount2);
    });

    it("should allow withdrawals to different sub accounts", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      const subAccount1BalanceBefore = await collateralToken.balanceOf(subAccount1.address);
      const subAccount2BalanceBefore = await collateralToken.balanceOf(subAccount2.address);

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount2.address, withdrawAmount);

      const subAccount1BalanceAfter = await collateralToken.balanceOf(subAccount1.address);
      const subAccount2BalanceAfter = await collateralToken.balanceOf(subAccount2.address);

      expect(subAccount1BalanceAfter).to.equal(subAccount1BalanceBefore + withdrawAmount);
      expect(subAccount2BalanceAfter).to.equal(subAccount2BalanceBefore + withdrawAmount);
    });

    it("should increment sequence number", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      const sequenceNumberBefore = await vault.sequenceNumber();
      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
      const sequenceNumberAfter = await vault.sequenceNumber();

      expect(sequenceNumberAfter).to.equal(sequenceNumberBefore + 1n);
    });

    it("should emit VaultWithdrawalWithoutRedeemingShares event with correct parameters", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());
      const sequenceNumberBefore = await vault.sequenceNumber();

      const tx = await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) =>
          vault.interface.parseLog(log)?.name === "VaultWithdrawalWithoutRedeemingShares"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = vault.interface.parseLog(event!);
      expect(parsedEvent?.args.vault).to.equal(await vault.getAddress());
      expect(parsedEvent?.args.subAccount).to.equal(subAccount1.address);
      expect(parsedEvent?.args.previousBalance).to.equal(vaultBalanceBefore);
      expect(parsedEvent?.args.newBalance).to.equal(vaultBalanceBefore - withdrawAmount);
      expect(parsedEvent?.args.amount).to.equal(withdrawAmount);
      expect(parsedEvent?.args.timestamp).to.be.a("bigint");
      expect(parsedEvent?.args.sequenceNumber).to.equal(sequenceNumberBefore + 1n);
    });

    it("should allow withdrawal of entire vault balance", async function () {
      const vaultBalance = await collateralToken.balanceOf(await vault.getAddress());
      const subAccountBalanceBefore = await collateralToken.balanceOf(subAccount1.address);

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, vaultBalance);

      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
      const subAccountBalanceAfter = await collateralToken.balanceOf(subAccount1.address);

      expect(vaultBalanceAfter).to.equal(0n);
      expect(subAccountBalanceAfter).to.equal(subAccountBalanceBefore + vaultBalance);
    });
  });

  describe("Validation - Protocol Pause", function () {
    it("should reject withdraw when protocol is paused", async function () {
      await protocolConfig.connect(owner).pauseNonAdminOperations(true);

      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "ProtocolPaused");

      // Unpause for cleanup
      await protocolConfig.connect(owner).pauseNonAdminOperations(false);
    });

    it("should allow withdraw when protocol is unpaused", async function () {
      // Ensure protocol is not paused
      const isPaused = await protocolConfig.getProtocolPauseStatus();
      if (isPaused) {
        await protocolConfig.connect(owner).pauseNonAdminOperations(false);
      }

      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.emit(vault, "VaultWithdrawalWithoutRedeemingShares");
    });
  });

  describe("Validation - Vault Pause", function () {
    it("should reject withdraw when privileged operations are paused", async function () {
      // Pause privileged operations
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "privilegedOperations", true);

      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "OperationPaused");

      // Unpause for cleanup
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "privilegedOperations", false);
    });

    it("should allow withdraw when privileged operations are unpaused", async function () {
      // Ensure privileged operations are not paused
      const pauseStatus = await vault.pauseStatus();
      if (pauseStatus.privilegedOperations) {
        await protocolConfig
          .connect(admin)
          .setVaultPausedStatus(await vault.getAddress(), "privilegedOperations", false);
      }

      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.emit(vault, "VaultWithdrawalWithoutRedeemingShares");
    });
  });

  describe("Validation - Permission", function () {
    it("should reject withdraw when called by non-manager", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(admin)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");

      await expect(
        vault
          .connect(rateManager)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");

      await expect(
        vault
          .connect(user1)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("should allow withdraw when called by manager", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.emit(vault, "VaultWithdrawalWithoutRedeemingShares");
    });
  });

  describe("Validation - Sub Account", function () {
    it("should reject withdraw to non-whitelisted account", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(nonSubAccount.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(user1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");
    });

    it("should allow withdraw to whitelisted sub account", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.emit(vault, "VaultWithdrawalWithoutRedeemingShares");

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount2.address, withdrawAmount)
      ).to.emit(vault, "VaultWithdrawalWithoutRedeemingShares");
    });

    it("should reject withdraw to account that was removed from sub accounts", async function () {
      // Remove sub account
      await protocolConfig
        .connect(admin)
        .setVaultSubAccount(await vault.getAddress(), subAccount1.address, false);

      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");

      // Re-add for cleanup
      await protocolConfig
        .connect(admin)
        .setVaultSubAccount(await vault.getAddress(), subAccount1.address, true);
    });

    it("should allow withdraw to account that was added as sub account", async function () {
      // Add new sub account
      await protocolConfig
        .connect(admin)
        .setVaultSubAccount(await vault.getAddress(), nonSubAccount.address, true);

      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(nonSubAccount.address, withdrawAmount)
      ).to.emit(vault, "VaultWithdrawalWithoutRedeemingShares");

      // Remove for cleanup
      await protocolConfig
        .connect(admin)
        .setVaultSubAccount(await vault.getAddress(), nonSubAccount.address, false);
    });
  });

  describe("Validation - Amount", function () {
    it("should reject zero amount withdrawal", async function () {
      const withdrawAmount = 0n;

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should reject withdrawal amount greater than vault balance", async function () {
      const vaultBalance = await collateralToken.balanceOf(await vault.getAddress());
      const withdrawAmount = vaultBalance + ethers.parseUnits("1", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "InsufficientBalance");
    });

    it("should allow withdrawal amount equal to vault balance", async function () {
      const vaultBalance = await collateralToken.balanceOf(await vault.getAddress());

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, vaultBalance)
      ).to.emit(vault, "VaultWithdrawalWithoutRedeemingShares");
    });

    it("should allow withdrawal amount less than vault balance", async function () {
      const vaultBalance = await collateralToken.balanceOf(await vault.getAddress());
      const withdrawAmount = vaultBalance / 2n;

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.emit(vault, "VaultWithdrawalWithoutRedeemingShares");
    });
  });

  describe("Validation - Zero Address", function () {
    it("should reject withdraw to zero address", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(ethers.ZeroAddress, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");
    });
  });

  describe("Edge Cases", function () {
    it("should handle very small withdrawal amounts", async function () {
      const withdrawAmount = 1n; // 1 wei

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);

      const vaultBalance = await collateralToken.balanceOf(await vault.getAddress());
      expect(vaultBalance).to.be.gt(0n);
    });

    it("should handle large withdrawal amounts", async function () {
      const vaultBalance = await collateralToken.balanceOf(await vault.getAddress());
      const withdrawAmount = vaultBalance / 2n; // Half of vault balance

      if (withdrawAmount > 0n) {
        await vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);

        const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
        expect(vaultBalanceAfter).to.equal(vaultBalance - withdrawAmount);
      }
    });

    it("should handle rapid successive withdrawals", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

      if (vaultBalanceBefore >= withdrawAmount * 5n) {
        for (let i = 0; i < 5; i++) {
          await vault
            .connect(operator)
            .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
        }

        const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
        expect(vaultBalanceAfter).to.equal(vaultBalanceBefore - withdrawAmount * 5n);
      }
    });

    it("should preserve state after failed withdrawal attempt", async function () {
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());
      const withdrawAmount = vaultBalanceBefore + ethers.parseUnits("1", 18);

      // Try withdrawal with insufficient balance
      await expect(
        vault
          .connect(operator)
          .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount)
      ).to.be.revertedWithCustomError(vault, "InsufficientBalance");

      // Verify vault balance unchanged
      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore);
    });

    it("should handle withdrawals when vault balance is exactly the withdrawal amount", async function () {
      const vaultBalance = await collateralToken.balanceOf(await vault.getAddress());

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, vaultBalance);

      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
      expect(vaultBalanceAfter).to.equal(0n);
    });
  });

  describe("Multiple Sub Accounts", function () {
    it("should allow withdrawals to multiple sub accounts in sequence", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      const subAccount1BalanceBefore = await collateralToken.balanceOf(subAccount1.address);
      const subAccount2BalanceBefore = await collateralToken.balanceOf(subAccount2.address);

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount2.address, withdrawAmount);

      const subAccount1BalanceAfter = await collateralToken.balanceOf(subAccount1.address);
      const subAccount2BalanceAfter = await collateralToken.balanceOf(subAccount2.address);

      expect(subAccount1BalanceAfter).to.equal(subAccount1BalanceBefore + withdrawAmount);
      expect(subAccount2BalanceAfter).to.equal(subAccount2BalanceBefore + withdrawAmount);
    });

    it("should allow different withdrawal amounts to different sub accounts", async function () {
      const withdrawAmount1 = ethers.parseUnits("1000", 18);
      const withdrawAmount2 = ethers.parseUnits("2000", 18);

      const subAccount1BalanceBefore = await collateralToken.balanceOf(subAccount1.address);
      const subAccount2BalanceBefore = await collateralToken.balanceOf(subAccount2.address);

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount1);
      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount2.address, withdrawAmount2);

      const subAccount1BalanceAfter = await collateralToken.balanceOf(subAccount1.address);
      const subAccount2BalanceAfter = await collateralToken.balanceOf(subAccount2.address);

      expect(subAccount1BalanceAfter).to.equal(subAccount1BalanceBefore + withdrawAmount1);
      expect(subAccount2BalanceAfter).to.equal(subAccount2BalanceBefore + withdrawAmount2);
    });
  });

  describe("Event Verification", function () {
    it("should emit event with correct vault address", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      const tx = await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) =>
          vault.interface.parseLog(log)?.name === "VaultWithdrawalWithoutRedeemingShares"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = vault.interface.parseLog(event!);
      expect(parsedEvent?.args.vault).to.equal(await vault.getAddress());
    });

    it("should emit event with correct sub account address", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      const tx = await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) =>
          vault.interface.parseLog(log)?.name === "VaultWithdrawalWithoutRedeemingShares"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.subAccount).to.equal(subAccount1.address);
    });

    it("should emit event with correct previous and new balance", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

      const tx = await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) =>
          vault.interface.parseLog(log)?.name === "VaultWithdrawalWithoutRedeemingShares"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.previousBalance).to.equal(vaultBalanceBefore);
      expect(parsedEvent?.args.newBalance).to.equal(vaultBalanceBefore - withdrawAmount);
    });

    it("should emit event with correct withdrawal amount", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      const tx = await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) =>
          vault.interface.parseLog(log)?.name === "VaultWithdrawalWithoutRedeemingShares"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.amount).to.equal(withdrawAmount);
    });

    it("should emit event with valid timestamp", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      const tx = await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const event = receipt?.logs.find(
        (log: any) =>
          vault.interface.parseLog(log)?.name === "VaultWithdrawalWithoutRedeemingShares"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.timestamp).to.be.a("bigint");
      expect(parsedEvent?.args.timestamp).to.be.gt(0n);
      expect(parsedEvent?.args.timestamp).to.be.gte(BigInt(block!.timestamp) * 1000n);
    });

    it("should emit event with correct sequence number", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);
      const sequenceNumberBefore = await vault.sequenceNumber();

      const tx = await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) =>
          vault.interface.parseLog(log)?.name === "VaultWithdrawalWithoutRedeemingShares"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.sequenceNumber).to.equal(sequenceNumberBefore + 1n);
    });
  });

  describe("Integration Tests", function () {
    it("should work correctly with deposits and withdrawals", async function () {
      const depositAmount = ethers.parseUnits("5000", 18);
      const withdrawAmount = ethers.parseUnits("2000", 18);

      // User deposits
      await collateralToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

      // Manager withdraws
      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);

      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore - withdrawAmount);
    });

    it("should maintain correct balances after multiple operations", async function () {
      const depositAmount = ethers.parseUnits("5000", 18);
      const withdrawAmount1 = ethers.parseUnits("1000", 18);
      const withdrawAmount2 = ethers.parseUnits("2000", 18);

      // User deposits
      await collateralToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const initialVaultBalance = await collateralToken.balanceOf(await vault.getAddress());

      // Manager withdraws twice
      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount1);
      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount2.address, withdrawAmount2);

      const finalVaultBalance = await collateralToken.balanceOf(await vault.getAddress());
      expect(finalVaultBalance).to.equal(initialVaultBalance - withdrawAmount1 - withdrawAmount2);
    });

    it("should not affect receipt token supply", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);
      const vaultSupplyBefore = await vault.totalSupply();

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);

      const vaultSupplyAfter = await vault.totalSupply();
      expect(vaultSupplyAfter).to.equal(vaultSupplyBefore);
    });

    it("should not affect user shares", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);
      const user1SharesBefore = await vault.balanceOf(user1.address);

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);

      const user1SharesAfter = await vault.balanceOf(user1.address);
      expect(user1SharesAfter).to.equal(user1SharesBefore);
    });

    it("should work independently of other vault properties", async function () {
      const withdrawAmount = ethers.parseUnits("1000", 18);

      const rolesBefore = await vault.roles();
      const maxTVLBefore = await vault.maxTVL();

      await vault
        .connect(operator)
        .withdrawFromVaultWithoutRedeemingShares(subAccount1.address, withdrawAmount);

      const rolesAfter = await vault.roles();
      expect(rolesAfter.admin).to.equal(rolesBefore.admin);
      expect(rolesAfter.operator).to.equal(rolesBefore.operator);
      expect(rolesAfter.rateManager).to.equal(rolesBefore.rateManager);
      expect(await vault.maxTVL()).to.equal(maxTVLBefore);
    });
  });
});
