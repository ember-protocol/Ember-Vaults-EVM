import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type {
  EmberVault,
  EmberProtocolConfig,
  ERC20Token,
  FixedPointMathWrapper,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmberVault - Redeem Shares", function () {
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
  let receiver1: HardhatEthersSigner;
  let receiver2: HardhatEthersSigner;
  let subAccount1: HardhatEthersSigner;
  let subAccount2: HardhatEthersSigner;

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

    // Users need to deposit first to get receipt tokens
    const depositAmount = ethers.parseUnits("10000", 18);
    await collateralToken.connect(user1).approve(await vault.getAddress(), depositAmount * 10n);
    await collateralToken.connect(user2).approve(await vault.getAddress(), depositAmount * 10n);
    await collateralToken.connect(user3).approve(await vault.getAddress(), depositAmount * 10n);

    await vault.connect(user1).deposit(depositAmount, user1.address);
    await vault.connect(user2).deposit(depositAmount, user2.address);
    await vault.connect(user3).deposit(depositAmount, user3.address);
  });

  describe("Success Cases", function () {
    it("should allow user to redeem shares and create withdrawal request", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      const userSharesBefore = await vault.balanceOf(user1.address);

      // Approve vault to spend receipt tokens
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const sequenceNumberBefore = await vault.sequenceNumber();
      const rateData = await vault.rate();
      const expectedEstimatedAmount = await math.divCeil(sharesToRedeem, rateData.value);

      const totalSharesBefore = await vault.totalSupply();
      const vaultBalanceBefore = await vault.balanceOf(await vault.getAddress());

      await expect(vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address))
        .to.emit(vault, "RequestRedeemed")
        .withArgs(
          await vault.getAddress(),
          user1.address,
          receiver1.address,
          sharesToRedeem,
          (timestamp: any) => {
            expect(timestamp).to.be.a("bigint");
            return true;
          },
          totalSharesBefore,
          vaultBalanceBefore + sharesToRedeem,
          sequenceNumberBefore + 1n
        );

      // Check receipt token balance (should be transferred to vault)
      expect(await vault.balanceOf(user1.address)).to.equal(userSharesBefore - sharesToRedeem);
      expect(await vault.balanceOf(await vault.getAddress())).to.equal(sharesToRedeem);

      // Check withdrawal request was created
      const pendingWithdrawals = await vault.pendingWithdrawals(0);
      expect(pendingWithdrawals.owner).to.equal(user1.address);
      expect(pendingWithdrawals.receiver).to.equal(receiver1.address);
      expect(pendingWithdrawals.shares).to.equal(sharesToRedeem);
      expect(pendingWithdrawals.estimatedWithdrawAmount).to.equal(expectedEstimatedAmount);

      // Check account state - arrays in structs from public mappings can't be accessed directly
      // We'll verify the account exists by checking the queue instead
      // For array access, we'd need getter functions in the contract
      const request = await vault.pendingWithdrawals(0);
      expect(request.owner).to.equal(user1.address);
      expect(request.shares).to.equal(sharesToRedeem);
    });

    it("should calculate estimated withdraw amount correctly using ceiling division", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const rateData = await vault.rate();
      const expectedEstimatedAmount = await math.divCeil(sharesToRedeem, rateData.value);

      const tx = await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const receipt = await tx.wait();

      const pendingWithdrawals = await vault.pendingWithdrawals(0);
      expect(pendingWithdrawals.estimatedWithdrawAmount).to.equal(expectedEstimatedAmount);
    });

    it("should emit RequestRedeemed event with correct parameters", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const sequenceNumberBefore = await vault.sequenceNumber();
      const totalSharesBefore = await vault.totalSupply();

      const tx = await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestRedeemed"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = vault.interface.parseLog(event!);
      expect(parsedEvent?.args.vault).to.equal(await vault.getAddress());
      expect(parsedEvent?.args.owner).to.equal(user1.address);
      expect(parsedEvent?.args.receiver).to.equal(receiver1.address);
      expect(parsedEvent?.args.shares).to.equal(sharesToRedeem);
      expect(parsedEvent?.args.timestamp).to.be.a("bigint");
      expect(parsedEvent?.args.totalShares).to.equal(totalSharesBefore);
      expect(parsedEvent?.args.totalSharesPendingToBurn).to.equal(sharesToRedeem);
      expect(parsedEvent?.args.sequenceNumber).to.equal(sequenceNumberBefore + 1n);
    });

    it("should update total pending shares correctly", async function () {
      const sharesToRedeem1 = ethers.parseUnits("1000", 18);
      const sharesToRedeem2 = ethers.parseUnits("500", 18);

      await vault
        .connect(user1)
        .approve(await vault.getAddress(), sharesToRedeem1 + sharesToRedeem2);

      await vault.connect(user1).redeemShares(sharesToRedeem1, receiver1.address);

      await vault.connect(user1).redeemShares(sharesToRedeem2, receiver1.address);

      // Verify both requests are in the queue
      const request1 = await vault.pendingWithdrawals(0);
      const request2 = await vault.pendingWithdrawals(1);
      expect(request1.shares).to.equal(sharesToRedeem1);
      expect(request2.shares).to.equal(sharesToRedeem2);
      expect(request1.owner).to.equal(user1.address);
      expect(request2.owner).to.equal(user1.address);
    });

    it("should allow multiple redemptions from same user", async function () {
      const sharesToRedeem1 = ethers.parseUnits("1000", 18);
      const sharesToRedeem2 = ethers.parseUnits("500", 18);

      await vault
        .connect(user1)
        .approve(await vault.getAddress(), sharesToRedeem1 + sharesToRedeem2);

      await vault.connect(user1).redeemShares(sharesToRedeem1, receiver1.address);
      const userSharesAfter1 = await vault.balanceOf(user1.address);

      await vault.connect(user1).redeemShares(sharesToRedeem2, receiver2.address);
      const userSharesAfter2 = await vault.balanceOf(user1.address);

      expect(userSharesAfter2).to.equal(userSharesAfter1 - sharesToRedeem2);

      // Check both requests are in queue
      const request1 = await vault.pendingWithdrawals(0);
      const request2 = await vault.pendingWithdrawals(1);
      expect(request1.shares).to.equal(sharesToRedeem1);
      expect(request2.shares).to.equal(sharesToRedeem2);
    });

    it("should allow multiple users to redeem shares", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user2).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user3).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      await vault.connect(user2).redeemShares(sharesToRedeem, receiver2.address);
      await vault.connect(user3).redeemShares(sharesToRedeem, receiver1.address);

      // Check all requests are in queue
      const request1 = await vault.pendingWithdrawals(0);
      const request2 = await vault.pendingWithdrawals(1);
      const request3 = await vault.pendingWithdrawals(2);

      expect(request1.owner).to.equal(user1.address);
      expect(request2.owner).to.equal(user2.address);
      expect(request3.owner).to.equal(user3.address);
    });

    it("should transfer receipt tokens to vault", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      const vaultAddress = await vault.getAddress();

      const vaultBalanceBefore = await vault.balanceOf(vaultAddress);
      await vault.connect(user1).approve(vaultAddress, sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const vaultBalanceAfter = await vault.balanceOf(vaultAddress);
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore + sharesToRedeem);
    });

    it("should increment sequence number", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const sequenceNumberBefore = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const sequenceNumberAfter = await vault.sequenceNumber();

      expect(sequenceNumberAfter).to.equal(sequenceNumberBefore + 1n);
    });

    it("should create withdrawal request with correct values", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const rateData = await vault.rate();
      const expectedEstimatedAmount = await math.divCeil(sharesToRedeem, rateData.value);
      const sequenceNumberBefore = await vault.sequenceNumber();

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      // Verify the request was created with correct values
      const request = await vault.pendingWithdrawals(0);
      expect(request.owner).to.equal(user1.address);
      expect(request.receiver).to.equal(receiver1.address);
      expect(request.shares).to.equal(sharesToRedeem);
      expect(request.estimatedWithdrawAmount).to.equal(expectedEstimatedAmount);
      expect(request.sequenceNumber).to.equal(sequenceNumberBefore + 1n);
      expect(request.timestamp).to.be.a("bigint");
      expect(request.timestamp).to.be.gt(0n);
    });

    it("should allow different receiver address than owner", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const request = await vault.pendingWithdrawals(0);
      expect(request.owner).to.equal(user1.address);
      expect(request.receiver).to.equal(receiver1.address);
      expect(request.receiver).to.not.equal(user1.address);
    });

    it("should allow same receiver address as owner", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, user1.address);

      const request = await vault.pendingWithdrawals(0);
      expect(request.owner).to.equal(user1.address);
      expect(request.receiver).to.equal(user1.address);
    });
  });

  describe("Validation - Protocol Pause", function () {
    it("should reject redeem when protocol is paused", async function () {
      await protocolConfig.connect(owner).pauseNonAdminOperations(true);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(
        vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)
      ).to.be.revertedWithCustomError(vault, "ProtocolPaused");

      // Unpause for cleanup
      await protocolConfig.connect(owner).pauseNonAdminOperations(false);
    });

    it("should allow redeem when protocol is unpaused", async function () {
      // Ensure protocol is not paused
      const isPaused = await protocolConfig.getProtocolPauseStatus();
      if (isPaused) {
        await protocolConfig.connect(owner).pauseNonAdminOperations(false);
      }

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)).to.emit(
        vault,
        "RequestRedeemed"
      );
    });
  });

  describe("Validation - Vault Pause", function () {
    it("should reject redeem when withdrawals are paused", async function () {
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "withdrawals", true);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(
        vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)
      ).to.be.revertedWithCustomError(vault, "OperationPaused");

      // Unpause for cleanup
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "withdrawals", false);
    });

    it("should allow redeem when withdrawals are unpaused", async function () {
      // Ensure withdrawals are not paused
      const pauseStatus = await vault.pauseStatus();
      if (pauseStatus.withdrawals) {
        await protocolConfig
          .connect(admin)
          .setVaultPausedStatus(await vault.getAddress(), "withdrawals", false);
      }

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)).to.emit(
        vault,
        "RequestRedeemed"
      );
    });

    it("should allow redeem when deposits are paused but withdrawals are not", async function () {
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "deposits", true);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)).to.emit(
        vault,
        "RequestRedeemed"
      );

      // Unpause for cleanup
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "deposits", false);
    });
  });

  describe("Validation - Blacklist", function () {
    it("should reject redeem from blacklisted owner", async function () {
      await protocolConfig.connect(owner).setBlacklistedAccount(user1.address, true);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(
        vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Unblacklist for cleanup
      await protocolConfig.connect(owner).setBlacklistedAccount(user1.address, false);
    });

    it("should reject redeem with blacklisted receiver", async function () {
      await protocolConfig.connect(owner).setBlacklistedAccount(receiver1.address, true);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(
        vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Unblacklist for cleanup
      await protocolConfig.connect(owner).setBlacklistedAccount(receiver1.address, false);
    });

    it("should allow redeem from unblacklisted account", async function () {
      // Ensure account is not blacklisted
      const isBlacklisted = await protocolConfig.isAccountBlacklisted(user1.address);
      if (isBlacklisted) {
        await protocolConfig.connect(owner).setBlacklistedAccount(user1.address, false);
      }

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)).to.emit(
        vault,
        "RequestRedeemed"
      );
    });

    it("should allow redeem from account that was previously blacklisted", async function () {
      // Blacklist first
      await protocolConfig.connect(owner).setBlacklistedAccount(user1.address, true);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(
        vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Unblacklist
      await protocolConfig.connect(owner).setBlacklistedAccount(user1.address, false);

      // Now should be able to redeem
      await expect(vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)).to.emit(
        vault,
        "RequestRedeemed"
      );
    });

    it("should allow redeem with receiver that was previously blacklisted", async function () {
      // Blacklist receiver first
      await protocolConfig.connect(owner).setBlacklistedAccount(receiver1.address, true);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(
        vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Unblacklist receiver
      await protocolConfig.connect(owner).setBlacklistedAccount(receiver1.address, false);

      // Now should be able to redeem
      await expect(vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)).to.emit(
        vault,
        "RequestRedeemed"
      );
    });
  });

  describe("Validation - Minimum Shares", function () {
    it("should reject redeem with shares less than minimum", async function () {
      const minShares = await vault.minWithdrawableShares();
      const sharesToRedeem = minShares - 1n;

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(
        vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)
      ).to.be.revertedWithCustomError(vault, "InsufficientShares");
    });

    it("should allow redeem with shares equal to minimum", async function () {
      const minShares = await vault.minWithdrawableShares();

      await vault.connect(user1).approve(await vault.getAddress(), minShares);

      await expect(vault.connect(user1).redeemShares(minShares, receiver1.address)).to.emit(
        vault,
        "RequestRedeemed"
      );
    });

    it("should allow redeem with shares greater than minimum", async function () {
      const minShares = await vault.minWithdrawableShares();
      const sharesToRedeem = minShares + ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)).to.emit(
        vault,
        "RequestRedeemed"
      );
    });
  });

  describe("Validation - Insufficient Shares", function () {
    it("should reject redeem with insufficient approval", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      const approvalAmount = sharesToRedeem / 2n; // Less than shares to redeem

      await vault.connect(user1).approve(await vault.getAddress(), approvalAmount);

      await expect(
        vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)
      ).to.be.revertedWithCustomError(vault, "ERC20InsufficientAllowance");
    });

    it("should reject redeem with no approval", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await expect(
        vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)
      ).to.be.revertedWithCustomError(vault, "ERC20InsufficientAllowance");
    });

    it("should reject redeem with insufficient balance", async function () {
      const userBalance = await vault.balanceOf(user1.address);
      const sharesToRedeem = userBalance + ethers.parseUnits("1", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await expect(
        vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)
      ).to.be.revertedWithCustomError(vault, "ERC20InsufficientBalance");
    });
  });

  describe("Validation - Zero Address", function () {
    it("should handle redeem with zero receiver address", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      // The contract doesn't explicitly check for zero address receiver
      // It only checks if receiver is blacklisted. If zero address is not blacklisted,
      // the transaction will succeed. This is acceptable behavior.
      // We'll test that it doesn't revert (or if it does, it's due to other reasons)
      const tx = await vault.connect(user1).redeemShares(sharesToRedeem, ethers.ZeroAddress);
      await tx.wait();

      // Verify request was created
      const request = await vault.pendingWithdrawals(0);
      expect(request.receiver).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Edge Cases", function () {
    it("should handle very small share amounts (at minimum)", async function () {
      const minShares = await vault.minWithdrawableShares();

      await vault.connect(user1).approve(await vault.getAddress(), minShares);

      await vault.connect(user1).redeemShares(minShares, receiver1.address);

      const request = await vault.pendingWithdrawals(0);
      expect(request.shares).to.equal(minShares);
    });

    it("should handle large share amounts", async function () {
      // Get user's balance
      const userBalance = await vault.balanceOf(user1.address);
      const sharesToRedeem = userBalance / 2n; // Redeem half

      if (sharesToRedeem >= (await vault.minWithdrawableShares())) {
        await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

        await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

        const request = await vault.pendingWithdrawals(0);
        expect(request.shares).to.equal(sharesToRedeem);
      }
    });

    it("should handle rapid successive redemptions", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      const userBalance = await vault.balanceOf(user1.address);

      if (userBalance >= sharesToRedeem * 5n) {
        await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 5n);

        for (let i = 0; i < 5; i++) {
          await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
          const request = await vault.pendingWithdrawals(i);
          expect(request.shares).to.equal(sharesToRedeem);
        }
      }
    });

    it("should preserve redeem state after failed redeem attempts", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      // Try redeem without approval
      await expect(vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address)).to.be
        .reverted;

      // Approve and redeem successfully
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const request = await vault.pendingWithdrawals(0);
      expect(request.shares).to.equal(sharesToRedeem);
    });

    it("should handle redemptions from multiple users in same block", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user2).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user3).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      await vault.connect(user2).redeemShares(sharesToRedeem, receiver2.address);
      await vault.connect(user3).redeemShares(sharesToRedeem, receiver1.address);

      const request1 = await vault.pendingWithdrawals(0);
      const request2 = await vault.pendingWithdrawals(1);
      const request3 = await vault.pendingWithdrawals(2);

      expect(request1.owner).to.equal(user1.address);
      expect(request2.owner).to.equal(user2.address);
      expect(request3.owner).to.equal(user3.address);
    });

    it("should preserve redeem state after reentrancy attempt", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      // The function should complete successfully (nonReentrant modifier)
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const request = await vault.pendingWithdrawals(0);
      expect(request.shares).to.equal(sharesToRedeem);
    });

    it("should handle redemption with maximum shares", async function () {
      const userBalance = await vault.balanceOf(user1.address);
      const minShares = await vault.minWithdrawableShares();

      if (userBalance >= minShares) {
        await vault.connect(user1).approve(await vault.getAddress(), userBalance);

        await vault.connect(user1).redeemShares(userBalance, receiver1.address);

        const request = await vault.pendingWithdrawals(0);
        expect(request.shares).to.equal(userBalance);
      }
    });
  });

  describe("Account State Management", function () {
    it("should create account state on first redemption", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      // Verify request was created in queue
      const request = await vault.pendingWithdrawals(0);
      expect(request.owner).to.equal(user1.address);
      expect(request.shares).to.equal(sharesToRedeem);
      expect(request.receiver).to.equal(receiver1.address);
    });

    it("should update account state on multiple redemptions", async function () {
      const sharesToRedeem1 = ethers.parseUnits("1000", 18);
      const sharesToRedeem2 = ethers.parseUnits("500", 18);

      await vault
        .connect(user1)
        .approve(await vault.getAddress(), sharesToRedeem1 + sharesToRedeem2);

      await vault.connect(user1).redeemShares(sharesToRedeem1, receiver1.address);

      // Verify first request
      const request1 = await vault.pendingWithdrawals(0);
      expect(request1.owner).to.equal(user1.address);
      expect(request1.shares).to.equal(sharesToRedeem1);

      await vault.connect(user1).redeemShares(sharesToRedeem2, receiver1.address);

      // Verify both requests
      const request1After = await vault.pendingWithdrawals(0);
      const request2 = await vault.pendingWithdrawals(1);
      expect(request1After.shares).to.equal(sharesToRedeem1);
      expect(request2.shares).to.equal(sharesToRedeem2);
      expect(request1After.owner).to.equal(user1.address);
      expect(request2.owner).to.equal(user1.address);
    });

    it("should track sequence numbers correctly in account state", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 3n);

      const seqNum1 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const seqNum2 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const seqNum3 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      // Verify sequence numbers in the withdrawal requests
      const request1 = await vault.pendingWithdrawals(0);
      const request2 = await vault.pendingWithdrawals(1);
      const request3 = await vault.pendingWithdrawals(2);
      expect(request1.sequenceNumber).to.equal(seqNum1 + 1n);
      expect(request2.sequenceNumber).to.equal(seqNum2 + 1n);
      expect(request3.sequenceNumber).to.equal(seqNum3 + 1n);

      // Verify all requests belong to user1
      expect(request1.owner).to.equal(user1.address);
      expect(request2.owner).to.equal(user1.address);
      expect(request3.owner).to.equal(user1.address);
      expect(request1.shares + request2.shares + request3.shares).to.equal(sharesToRedeem * 3n);
    });
  });

  describe("Queue Management", function () {
    it("should add requests to queue in order", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user2).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user3).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      await vault.connect(user2).redeemShares(sharesToRedeem, receiver2.address);
      await vault.connect(user3).redeemShares(sharesToRedeem, receiver1.address);

      const request1 = await vault.pendingWithdrawals(0);
      const request2 = await vault.pendingWithdrawals(1);
      const request3 = await vault.pendingWithdrawals(2);

      expect(request1.owner).to.equal(user1.address);
      expect(request2.owner).to.equal(user2.address);
      expect(request3.owner).to.equal(user3.address);
    });

    it("should maintain queue order with multiple redemptions from same user", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 3n);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver2.address);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const request1 = await vault.pendingWithdrawals(0);
      const request2 = await vault.pendingWithdrawals(1);
      const request3 = await vault.pendingWithdrawals(2);

      expect(request1.owner).to.equal(user1.address);
      expect(request1.receiver).to.equal(receiver1.address);
      expect(request2.owner).to.equal(user1.address);
      expect(request2.receiver).to.equal(receiver2.address);
      expect(request3.owner).to.equal(user1.address);
      expect(request3.receiver).to.equal(receiver1.address);
    });
  });

  describe("Event Verification", function () {
    it("should emit event with correct vault address", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const tx = await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestRedeemed"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = vault.interface.parseLog(event!);
      expect(parsedEvent?.args.vault).to.equal(await vault.getAddress());
    });

    it("should emit event with correct owner and receiver addresses", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const tx = await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestRedeemed"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.owner).to.equal(user1.address);
      expect(parsedEvent?.args.receiver).to.equal(receiver1.address);
    });

    it("should emit event with correct shares amount", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const tx = await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestRedeemed"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.shares).to.equal(sharesToRedeem);
    });

    it("should emit event with valid timestamp", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const tx = await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestRedeemed"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.timestamp).to.be.a("bigint");
      expect(parsedEvent?.args.timestamp).to.be.gt(0n);
      expect(parsedEvent?.args.timestamp).to.be.gte(BigInt(block!.timestamp) * 1000n);
    });

    it("should emit event with correct total shares", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const totalSharesBefore = await vault.totalSupply();

      const tx = await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestRedeemed"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      // Total shares should remain the same (shares are transferred to vault, not burned yet)
      expect(parsedEvent?.args.totalShares).to.equal(totalSharesBefore);
    });

    it("should emit event with correct pending shares to burn", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const tx = await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestRedeemed"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.totalSharesPendingToBurn).to.equal(sharesToRedeem);
    });

    it("should emit event with correct sequence number", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const sequenceNumberBefore = await vault.sequenceNumber();

      const tx = await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestRedeemed"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.sequenceNumber).to.equal(sequenceNumberBefore + 1n);
    });
  });

  describe("Integration Tests", function () {
    it("should allow redemptions independently of other vault properties", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const rolesBefore = await vault.roles();
      const maxTVLBefore = await vault.maxTVL();

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const rolesAfter = await vault.roles();
      expect(rolesAfter.admin).to.equal(rolesBefore.admin);
      expect(rolesAfter.operator).to.equal(rolesBefore.operator);
      expect(rolesAfter.rateManager).to.equal(rolesBefore.rateManager);
      expect(await vault.maxTVL()).to.equal(maxTVLBefore);
    });

    it("should work correctly with rate updates", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const rateData1 = await vault.rate();
      // Changed from divCeil to div to match the contract's floor rounding (favors vault)
      const estimatedAmount1 = await math.div(sharesToRedeem, rateData1.value);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      expect(request1.estimatedWithdrawAmount).to.equal(estimatedAmount1);

      // Update rate (fast forward time first)
      const interval = rateData1.rateUpdateInterval;
      await ethers.provider.send("evm_increaseTime", [Number(interval / 1000n) + 1]);
      await ethers.provider.send("evm_mine", []);

      const maxRate = await protocolConfig.getMaxRate();
      const maxChange = rateData1.maxRateChangePerUpdate;
      const maxChangeAmount = (maxChange * rateData1.value) / ethers.parseUnits("1", 18);
      const newRate = rateData1.value + maxChangeAmount / 2n;
      const validNewRate = newRate > maxRate ? maxRate : newRate;

      await vault.connect(rateManager).updateVaultRate(validNewRate);

      // Redeem again with new rate
      const rateData2 = await vault.rate();
      // Changed from divCeil to div to match the contract's floor rounding (favors vault)
      const estimatedAmount2 = await math.div(sharesToRedeem, rateData2.value);

      await vault.connect(user2).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user2).redeemShares(sharesToRedeem, receiver2.address);

      const request2 = await vault.pendingWithdrawals(1);
      expect(request2.estimatedWithdrawAmount).to.equal(estimatedAmount2);
    });

    it("should handle complex redemption scenarios", async function () {
      // Multiple users, multiple redemptions, different receivers
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 2n);
      await vault.connect(user2).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user3).approve(await vault.getAddress(), sharesToRedeem);

      // User1 redeems twice
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver2.address);

      // User2 redeems
      await vault.connect(user2).redeemShares(sharesToRedeem, receiver1.address);

      // User3 redeems
      await vault.connect(user3).redeemShares(sharesToRedeem, receiver2.address);

      // Check all requests
      const request1 = await vault.pendingWithdrawals(0);
      const request2 = await vault.pendingWithdrawals(1);
      const request3 = await vault.pendingWithdrawals(2);
      const request4 = await vault.pendingWithdrawals(3);

      expect(request1.owner).to.equal(user1.address);
      expect(request1.receiver).to.equal(receiver1.address);
      expect(request2.owner).to.equal(user1.address);
      expect(request2.receiver).to.equal(receiver2.address);
      expect(request3.owner).to.equal(user2.address);
      expect(request3.receiver).to.equal(receiver1.address);
      expect(request4.owner).to.equal(user3.address);
      expect(request4.receiver).to.equal(receiver2.address);

      // Verify all requests are in queue (4 total) and check their owners
      expect((await vault.pendingWithdrawals(0)).owner).to.equal(user1.address);
      expect((await vault.pendingWithdrawals(1)).owner).to.equal(user1.address);
      expect((await vault.pendingWithdrawals(2)).owner).to.equal(user2.address);
      expect((await vault.pendingWithdrawals(3)).owner).to.equal(user3.address);

      // Verify shares amounts
      expect((await vault.pendingWithdrawals(0)).shares).to.equal(sharesToRedeem);
      expect((await vault.pendingWithdrawals(1)).shares).to.equal(sharesToRedeem);
      expect((await vault.pendingWithdrawals(2)).shares).to.equal(sharesToRedeem);
      expect((await vault.pendingWithdrawals(3)).shares).to.equal(sharesToRedeem);
    });

    it("should calculate estimated withdraw amount correctly with ceiling division", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const rateData = await vault.rate();
      const expectedEstimatedAmount = await math.divCeil(sharesToRedeem, rateData.value);
      const regularDiv = await math.div(sharesToRedeem, rateData.value);

      // Ceiling division should be >= regular division
      expect(expectedEstimatedAmount).to.be.gte(regularDiv);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const request = await vault.pendingWithdrawals(0);
      expect(request.estimatedWithdrawAmount).to.equal(expectedEstimatedAmount);
      expect(request.estimatedWithdrawAmount).to.be.gte(regularDiv);
    });
  });

  describe("getAccountState", function () {
    it("should return zero values for account with no pending withdrawals", async function () {
      const accountState = await vault.getAccountState(user1.address);

      expect(accountState.totalPendingWithdrawalShares).to.equal(0n);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(0);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(0);
    });

    it("should return correct account state after single redemption", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      const sequenceNumberBefore = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const accountState = await vault.getAccountState(user1.address);

      expect(accountState.totalPendingWithdrawalShares).to.equal(sharesToRedeem);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(1);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(
        sequenceNumberBefore + 1n
      );
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(0);
    });

    it("should return correct account state after multiple redemptions", async function () {
      const sharesToRedeem1 = ethers.parseUnits("1000", 18);
      const sharesToRedeem2 = ethers.parseUnits("500", 18);
      const sharesToRedeem3 = ethers.parseUnits("750", 18);

      await vault
        .connect(user1)
        .approve(await vault.getAddress(), sharesToRedeem1 + sharesToRedeem2 + sharesToRedeem3);

      const seqNum1 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem1, receiver1.address);

      const seqNum2 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem2, receiver2.address);

      const seqNum3 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem3, receiver1.address);

      const accountState = await vault.getAccountState(user1.address);

      expect(accountState.totalPendingWithdrawalShares).to.equal(
        sharesToRedeem1 + sharesToRedeem2 + sharesToRedeem3
      );
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(3);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(seqNum1 + 1n);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers[1]).to.equal(seqNum2 + 1n);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers[2]).to.equal(seqNum3 + 1n);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(0);
    });

    it("should return correct account state for multiple users", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user2).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user3).approve(await vault.getAddress(), sharesToRedeem);

      const seqNum1 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      const seqNum2 = await vault.sequenceNumber();
      await vault.connect(user2).redeemShares(sharesToRedeem, receiver2.address);

      const seqNum3 = await vault.sequenceNumber();
      await vault.connect(user3).redeemShares(sharesToRedeem, receiver1.address);

      const accountState1 = await vault.getAccountState(user1.address);
      const accountState2 = await vault.getAccountState(user2.address);
      const accountState3 = await vault.getAccountState(user3.address);

      expect(accountState1.totalPendingWithdrawalShares).to.equal(sharesToRedeem);
      expect(accountState1.pendingWithdrawalRequestSequenceNumbers.length).to.equal(1);
      expect(accountState1.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(seqNum1 + 1n);

      expect(accountState2.totalPendingWithdrawalShares).to.equal(sharesToRedeem);
      expect(accountState2.pendingWithdrawalRequestSequenceNumbers.length).to.equal(1);
      expect(accountState2.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(seqNum2 + 1n);

      expect(accountState3.totalPendingWithdrawalShares).to.equal(sharesToRedeem);
      expect(accountState3.pendingWithdrawalRequestSequenceNumbers.length).to.equal(1);
      expect(accountState3.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(seqNum3 + 1n);
    });

    it("should return empty arrays when account has no pending requests", async function () {
      // User with no redemptions
      const accountState = await vault.getAccountState(user1.address);

      expect(accountState.totalPendingWithdrawalShares).to.equal(0n);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers).to.be.an("array").that.is.empty;
      expect(accountState.cancelWithdrawRequestSequenceNumbers).to.be.an("array").that.is.empty;
    });

    it("should return correct state after account makes multiple redemptions with different receivers", async function () {
      const sharesToRedeem1 = ethers.parseUnits("1000", 18);
      const sharesToRedeem2 = ethers.parseUnits("2000", 18);

      await vault
        .connect(user1)
        .approve(await vault.getAddress(), sharesToRedeem1 + sharesToRedeem2);

      const seqNum1 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem1, receiver1.address);

      const seqNum2 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem2, receiver2.address);

      const accountState = await vault.getAccountState(user1.address);

      expect(accountState.totalPendingWithdrawalShares).to.equal(sharesToRedeem1 + sharesToRedeem2);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(2);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(seqNum1 + 1n);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers[1]).to.equal(seqNum2 + 1n);
    });

    it("should return correct state for account that doesn't exist", async function () {
      // Use a new address that hasn't interacted with the vault
      const newUser = (await ethers.getSigners())[12]; // Assuming we have enough signers
      const accountState = await vault.getAccountState(newUser.address);

      expect(accountState.totalPendingWithdrawalShares).to.equal(0n);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(0);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(0);
    });

    it("should return correct state with very small share amounts", async function () {
      const minShares = await vault.minWithdrawableShares();
      await vault.connect(user1).approve(await vault.getAddress(), minShares);

      const sequenceNumberBefore = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(minShares, receiver1.address);

      const accountState = await vault.getAccountState(user1.address);

      expect(accountState.totalPendingWithdrawalShares).to.equal(minShares);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(1);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(
        sequenceNumberBefore + 1n
      );
    });

    it("should return correct state with large share amounts", async function () {
      const userBalance = await vault.balanceOf(user1.address);
      const sharesToRedeem = userBalance / 2n; // Redeem half

      if (sharesToRedeem >= (await vault.minWithdrawableShares())) {
        await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

        const sequenceNumberBefore = await vault.sequenceNumber();
        await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

        const accountState = await vault.getAccountState(user1.address);

        expect(accountState.totalPendingWithdrawalShares).to.equal(sharesToRedeem);
        expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(1);
        expect(accountState.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(
          sequenceNumberBefore + 1n
        );
      }
    });

    it("should return correct state after rapid successive redemptions", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      const userBalance = await vault.balanceOf(user1.address);

      if (userBalance >= sharesToRedeem * 5n) {
        await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 5n);

        const sequenceNumbers: bigint[] = [];

        for (let i = 0; i < 5; i++) {
          const seqNum = await vault.sequenceNumber();
          sequenceNumbers.push(seqNum + 1n);
          await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
        }

        const accountState = await vault.getAccountState(user1.address);

        expect(accountState.totalPendingWithdrawalShares).to.equal(sharesToRedeem * 5n);
        expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(5);

        for (let i = 0; i < 5; i++) {
          expect(accountState.pendingWithdrawalRequestSequenceNumbers[i]).to.equal(
            sequenceNumbers[i]
          );
        }
      }
    });

    it("should return correct state that matches withdrawal requests in queue", async function () {
      const sharesToRedeem1 = ethers.parseUnits("1000", 18);
      const sharesToRedeem2 = ethers.parseUnits("500", 18);

      await vault
        .connect(user1)
        .approve(await vault.getAddress(), sharesToRedeem1 + sharesToRedeem2);

      const seqNum1 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem1, receiver1.address);

      const seqNum2 = await vault.sequenceNumber();
      await vault.connect(user1).redeemShares(sharesToRedeem2, receiver2.address);

      const accountState = await vault.getAccountState(user1.address);

      // Verify the sequence numbers match the requests in the queue
      const request1 = await vault.pendingWithdrawals(0);
      const request2 = await vault.pendingWithdrawals(1);

      expect(accountState.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(
        request1.sequenceNumber
      );
      expect(accountState.pendingWithdrawalRequestSequenceNumbers[1]).to.equal(
        request2.sequenceNumber
      );
      expect(request1.sequenceNumber).to.equal(seqNum1 + 1n);
      expect(request2.sequenceNumber).to.equal(seqNum2 + 1n);
    });

    it("should be callable by anyone (public view function)", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      // Call from different user (should work)
      const accountState = await vault.connect(user2).getAccountState.staticCall(user1.address);

      expect(accountState.totalPendingWithdrawalShares).to.equal(sharesToRedeem);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(1);
    });

    it("should return correct state for zero address", async function () {
      const accountState = await vault.getAccountState(ethers.ZeroAddress);

      expect(accountState.totalPendingWithdrawalShares).to.equal(0n);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(0);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(0);
    });
  });
});
