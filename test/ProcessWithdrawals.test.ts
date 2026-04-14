import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type {
  EmberVault,
  EmberProtocolConfig,
  ERC20Token,
  FixedPointMathWrapper,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmberVault - Process Withdrawals", function () {
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
  let receiver3: HardhatEthersSigner;
  let blacklistedUser: HardhatEthersSigner;
  let subAccount1: HardhatEthersSigner;
  let subAccount2: HardhatEthersSigner;

  const VAULT_NAME = "Test Vault";
  const RATE_UPDATE_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
  const MAX_RATE_CHANGE_PER_UPDATE = ethers.parseUnits("0.1", 18);
  const FEE_PERCENTAGE = ethers.parseUnits("0.05", 18);
  const MIN_WITHDRAWABLE_SHARES = ethers.parseUnits("1", 18);
  const MAX_TVL = ethers.parseUnits("1000000", 18);
  const INITIAL_RATE = ethers.parseUnits("1", 18); // 1:1 rate

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
      receiver3,
      blacklistedUser,
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

    // Distribute collateral tokens to users for testing
    const collateralAmount = ethers.parseUnits("100000", 18);
    await collateralToken.connect(owner).transfer(user1.address, collateralAmount);
    await collateralToken.connect(owner).transfer(user2.address, collateralAmount);
    await collateralToken.connect(owner).transfer(user3.address, collateralAmount);
    await collateralToken.connect(owner).transfer(blacklistedUser.address, collateralAmount);

    // Users deposit to vault to create vault balance
    const depositAmount = ethers.parseUnits("10000", 18);
    await collateralToken.connect(user1).approve(await vault.getAddress(), depositAmount * 10n);
    await collateralToken.connect(user2).approve(await vault.getAddress(), depositAmount * 10n);
    await collateralToken.connect(user3).approve(await vault.getAddress(), depositAmount * 10n);
    await collateralToken
      .connect(blacklistedUser)
      .approve(await vault.getAddress(), depositAmount * 10n);

    await vault.connect(user1).deposit(depositAmount, user1.address);
    await vault.connect(user2).deposit(depositAmount, user2.address);
    await vault.connect(user3).deposit(depositAmount, user3.address);
    await vault.connect(blacklistedUser).deposit(depositAmount, blacklistedUser.address);
  });

  describe("processWithdrawalRequests - Success Cases", function () {
    it("should process a single withdrawal request successfully", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      // Get request from queue to access all fields (using helper that accounts for start index)
      const requestFromQueue = await vault.getPendingWithdrawal(0);
      const requestTimestamp = requestFromQueue.timestamp;
      const requestSequenceNumber = requestFromQueue.sequenceNumber;

      const expectedWithdrawAmount = await math.div(sharesToRedeem, INITIAL_RATE);

      const receiverBalanceBefore = await collateralToken.balanceOf(receiver1.address);
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());
      const totalSharesBefore = await vault.totalSupply();

      const tx = await vault.connect(operator).processWithdrawalRequests(1);
      const receipt = await tx.wait();

      // Verify RequestProcessed event
      const processedEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestProcessed"
      );
      expect(processedEvent).to.not.be.undefined;
      const parsedProcessedEvent = vault.interface.parseLog(processedEvent!);
      expect(parsedProcessedEvent?.args.vault).to.equal(await vault.getAddress());
      expect(parsedProcessedEvent?.args.owner).to.equal(user1.address);
      expect(parsedProcessedEvent?.args.receiver).to.equal(receiver1.address);
      expect(parsedProcessedEvent?.args.shares).to.equal(sharesToRedeem);
      expect(parsedProcessedEvent?.args.withdrawAmount).to.equal(expectedWithdrawAmount);
      expect(parsedProcessedEvent?.args.requestTimestamp).to.equal(requestTimestamp);
      expect(parsedProcessedEvent?.args.processTimestamp).to.be.a("bigint");
      expect(parsedProcessedEvent?.args.skipped).to.equal(false);
      expect(parsedProcessedEvent?.args.cancelled).to.equal(false);
      expect(parsedProcessedEvent?.args.totalShares).to.equal(totalSharesBefore - sharesToRedeem);
      expect(parsedProcessedEvent?.args.totalSharesPendingToBurn).to.equal(0n);
      expect(parsedProcessedEvent?.args.requestSequenceNumber).to.equal(requestSequenceNumber);

      // Verify ProcessRequestsSummary event was emitted
      const summaryEvent = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "ProcessRequestsSummary"
      );
      expect(summaryEvent).to.not.be.undefined;

      const receiverBalanceAfter = await collateralToken.balanceOf(receiver1.address);
      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
      const totalSharesAfter = await vault.totalSupply();

      expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + expectedWithdrawAmount);
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore - expectedWithdrawAmount);
      expect(totalSharesAfter).to.equal(totalSharesBefore - sharesToRedeem);
    });

    it("should process multiple withdrawal requests in order", async function () {
      const shares1 = ethers.parseUnits("1000", 18);
      const shares2 = ethers.parseUnits("2000", 18);
      const shares3 = ethers.parseUnits("1500", 18);

      await vault.connect(user1).approve(await vault.getAddress(), shares1);
      await vault.connect(user2).approve(await vault.getAddress(), shares2);
      await vault.connect(user3).approve(await vault.getAddress(), shares3);

      const request1 = await vault.connect(user1).redeemShares(shares1, receiver1.address);
      const request2 = await vault.connect(user2).redeemShares(shares2, receiver2.address);
      const request3 = await vault.connect(user3).redeemShares(shares3, receiver3.address);

      const expectedAmount1 = await math.div(shares1, INITIAL_RATE);
      const expectedAmount2 = await math.div(shares2, INITIAL_RATE);
      const expectedAmount3 = await math.div(shares3, INITIAL_RATE);

      const totalSharesBefore = await vault.totalSupply();
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

      await vault.connect(operator).processWithdrawalRequests(3);

      const totalSharesAfter = await vault.totalSupply();
      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());

      expect(totalSharesAfter).to.equal(totalSharesBefore - shares1 - shares2 - shares3);
      expect(vaultBalanceAfter).to.equal(
        vaultBalanceBefore - expectedAmount1 - expectedAmount2 - expectedAmount3
      );

      expect(await collateralToken.balanceOf(receiver1.address)).to.equal(expectedAmount1);
      expect(await collateralToken.balanceOf(receiver2.address)).to.equal(expectedAmount2);
      expect(await collateralToken.balanceOf(receiver3.address)).to.equal(expectedAmount3);
    });

    it("should process fewer requests than available in queue", async function () {
      const shares1 = ethers.parseUnits("1000", 18);
      const shares2 = ethers.parseUnits("2000", 18);
      const shares3 = ethers.parseUnits("1500", 18);

      await vault.connect(user1).approve(await vault.getAddress(), shares1);
      await vault.connect(user2).approve(await vault.getAddress(), shares2);
      await vault.connect(user3).approve(await vault.getAddress(), shares3);

      await vault.connect(user1).redeemShares(shares1, receiver1.address);
      await vault.connect(user2).redeemShares(shares2, receiver2.address);
      await vault.connect(user3).redeemShares(shares3, receiver3.address);

      // Get all requests from queue before processing to get their sequence numbers
      const request1FromQueue = await vault.getPendingWithdrawal(0);
      const request2FromQueue = await vault.getPendingWithdrawal(1);
      const request3FromQueue = await vault.getPendingWithdrawal(2);
      const seqNum1 = request1FromQueue.sequenceNumber;
      const seqNum2 = request2FromQueue.sequenceNumber;
      const seqNum3 = request3FromQueue.sequenceNumber;

      const totalSharesBefore = await vault.totalSupply();

      // Process only 2 requests (request1 and request2)
      await vault.connect(operator).processWithdrawalRequests(2);

      const totalSharesAfter = await vault.totalSupply();
      // Check that only 1 request remains (request3)
      const queueLength = await vault.getPendingWithdrawalsLength();
      expect(queueLength).to.equal(1n);
      const remainingRequest = await vault.getPendingWithdrawal(0);
      expect(remainingRequest.sequenceNumber).to.equal(seqNum3);

      expect(totalSharesAfter).to.equal(totalSharesBefore - shares1 - shares2);
    });

    it("should process all requests when numRequests exceeds queue length", async function () {
      const shares1 = ethers.parseUnits("1000", 18);
      const shares2 = ethers.parseUnits("2000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), shares1);
      await vault.connect(user2).approve(await vault.getAddress(), shares2);

      await vault.connect(user1).redeemShares(shares1, receiver1.address);
      await vault.connect(user2).redeemShares(shares2, receiver2.address);

      const totalSharesBefore = await vault.totalSupply();
      const queueLengthBefore = await vault.getPendingWithdrawalsLength();
      expect(queueLengthBefore).to.equal(2n);

      // Request to process more than available
      await vault.connect(operator).processWithdrawalRequests(10);

      const totalSharesAfter = await vault.totalSupply();

      // Queue should be empty
      const queueLengthAfter = await vault.getPendingWithdrawalsLength();
      expect(queueLengthAfter).to.equal(0n);
      expect(totalSharesAfter).to.equal(totalSharesBefore - shares1 - shares2);
    });

    it("should increment sequence number", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), shares);

      await vault.connect(user1).redeemShares(shares, receiver1.address);

      const sequenceNumberAfterRedeem = await vault.sequenceNumber();
      await vault.connect(operator).processWithdrawalRequests(1);
      const sequenceNumberAfter = await vault.sequenceNumber();

      // Processing increments sequence number once at the start
      // _chargeAccruedPlatformFees may or may not increment depending on fees
      // So we check that it incremented at least once
      expect(sequenceNumberAfter).to.be.gte(sequenceNumberAfterRedeem + 1n);
    });

    it("should charge platform fees after processing", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), shares);

      await vault.connect(user1).redeemShares(shares, receiver1.address);

      const platformFeeBefore = await vault.platformFee();
      const lastChargedAtBefore = platformFeeBefore.lastChargedAt;

      // Fast forward time to accrue fees
      await ethers.provider.send("evm_increaseTime", [3600]); // 1 hour
      await ethers.provider.send("evm_mine", []);

      await vault.connect(operator).processWithdrawalRequests(1);

      const platformFeeAfter = await vault.platformFee();
      expect(platformFeeAfter.lastChargedAt).to.be.gt(lastChargedAtBefore);
    });

    it("should emit ProcessRequestsSummary event with correct values", async function () {
      const shares1 = ethers.parseUnits("1000", 18);
      const shares2 = ethers.parseUnits("2000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), shares1);
      await vault.connect(user2).approve(await vault.getAddress(), shares2);

      await vault.connect(user1).redeemShares(shares1, receiver1.address);
      await vault.connect(user2).redeemShares(shares2, receiver2.address);

      const totalSharesBefore = await vault.totalSupply();
      const sequenceNumberAfterRedeem = await vault.sequenceNumber();

      const tx = await vault.connect(operator).processWithdrawalRequests(2);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "ProcessRequestsSummary"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = vault.interface.parseLog(event!);
      expect(parsedEvent?.args.vault).to.equal(await vault.getAddress());
      expect(parsedEvent?.args.totalRequestProcessed).to.equal(2n);
      expect(parsedEvent?.args.requestsSkipped).to.equal(0n);
      expect(parsedEvent?.args.requestsCancelled).to.equal(0n);
      expect(parsedEvent?.args.totalSharesBurnt).to.equal(shares1 + shares2);
      expect(parsedEvent?.args.totalShares).to.equal(totalSharesBefore - shares1 - shares2);
      // Processing increments sequence number once at the start
      // _chargeAccruedPlatformFees may or may not increment depending on fees
      expect(parsedEvent?.args.sequenceNumber).to.be.gte(sequenceNumberAfterRedeem + 1n);
    });
  });

  describe("processWithdrawalRequests - Validation - Protocol Pause", function () {
    it("should reject when protocol is paused", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), shares);

      await vault.connect(user1).redeemShares(shares, receiver1.address);

      await protocolConfig.connect(owner).pauseNonAdminOperations(true);

      await expect(
        vault.connect(operator).processWithdrawalRequests(1)
      ).to.be.revertedWithCustomError(vault, "ProtocolPaused");

      // Unpause for cleanup
      await protocolConfig.connect(owner).pauseNonAdminOperations(false);
    });
  });

  describe("processWithdrawalRequests - Validation - Privileged Operations Pause", function () {
    it("should reject when privileged operations are paused", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), shares);

      await vault.connect(user1).redeemShares(shares, receiver1.address);

      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "privilegedOperations", true);

      await expect(
        vault.connect(operator).processWithdrawalRequests(1)
      ).to.be.revertedWithCustomError(vault, "OperationPaused");

      // Unpause for cleanup
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "privilegedOperations", false);
    });
  });

  describe("processWithdrawalRequests - Validation - Permission", function () {
    it("should reject when called by non-manager", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), shares);

      await vault.connect(user1).redeemShares(shares, receiver1.address);

      await expect(vault.connect(admin).processWithdrawalRequests(1)).to.be.revertedWithCustomError(
        vault,
        "Unauthorized"
      );

      await expect(
        vault.connect(rateManager).processWithdrawalRequests(1)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");

      await expect(vault.connect(user1).processWithdrawalRequests(1)).to.be.revertedWithCustomError(
        vault,
        "Unauthorized"
      );
    });

    it("should allow when called by manager", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), shares);

      await vault.connect(user1).redeemShares(shares, receiver1.address);

      await expect(vault.connect(operator).processWithdrawalRequests(1)).to.emit(
        vault,
        "ProcessRequestsSummary"
      );
    });
  });

  describe("processWithdrawalRequests - Validation - Zero Amount", function () {
    it("should reject when numRequests is zero", async function () {
      await expect(
        vault.connect(operator).processWithdrawalRequests(0)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });
  });

  describe("processWithdrawalRequests - Skipped Requests", function () {
    it("should skip request when owner is blacklisted", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(blacklistedUser).approve(await vault.getAddress(), shares);

      await vault.connect(blacklistedUser).redeemShares(shares, receiver1.address);

      // Get request from queue
      const requestFromQueue = await vault.getPendingWithdrawal(0);
      const requestTimestamp = requestFromQueue.timestamp;
      const seqNum = requestFromQueue.sequenceNumber;

      // Blacklist the owner
      await protocolConfig.connect(owner).setBlacklistedAccount(blacklistedUser.address, true);

      const ownerSharesBefore = await vault.balanceOf(blacklistedUser.address);
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

      await expect(vault.connect(operator).processWithdrawalRequests(1))
        .to.emit(vault, "RequestProcessed")
        .withArgs(
          await vault.getAddress(),
          blacklistedUser.address,
          receiver1.address,
          shares,
          0n, // withdrawAmount should be 0
          requestTimestamp,
          (timestamp: any) => true,
          true, // skipped
          false, // cancelled
          (totalShares: any) => true,
          (pendingShares: any) => true,
          (seqNum: any) => true,
          seqNum
        );

      const ownerSharesAfter = await vault.balanceOf(blacklistedUser.address);
      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());

      // Shares should be returned to owner
      expect(ownerSharesAfter).to.equal(ownerSharesBefore + shares);
      // Vault balance should not change
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore);
    });

    it("should skip request when receiver is blacklisted", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), shares);

      const request = await vault.connect(user1).redeemShares(shares, receiver1.address);

      // Blacklist the receiver
      await protocolConfig.connect(owner).setBlacklistedAccount(receiver1.address, true);

      const ownerSharesBefore = await vault.balanceOf(user1.address);
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

      await vault.connect(operator).processWithdrawalRequests(1);

      const ownerSharesAfter = await vault.balanceOf(user1.address);
      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());

      // Shares should be returned to owner
      expect(ownerSharesAfter).to.equal(ownerSharesBefore + shares);
      // Vault balance should not change
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore);
    });

    it("should skip request when request is cancelled", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), shares);

      await vault.connect(user1).redeemShares(shares, receiver1.address);

      // Get request from queue to access sequence number
      const requestFromQueue = await vault.pendingWithdrawals(0);
      const seqNum = requestFromQueue.sequenceNumber;
      const requestTimestamp = requestFromQueue.timestamp;

      // Cancel the request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum);

      const ownerSharesBefore = await vault.balanceOf(user1.address);
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

      await expect(vault.connect(operator).processWithdrawalRequests(1))
        .to.emit(vault, "RequestProcessed")
        .withArgs(
          await vault.getAddress(),
          user1.address,
          receiver1.address,
          shares,
          0n, // withdrawAmount should be 0
          requestTimestamp,
          (timestamp: any) => true,
          true, // skipped
          true, // cancelled
          (totalShares: any) => true,
          (pendingShares: any) => true,
          (seqNum: any) => true,
          seqNum
        );

      const ownerSharesAfter = await vault.balanceOf(user1.address);
      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());

      // Shares should be returned to owner
      expect(ownerSharesAfter).to.equal(ownerSharesBefore + shares);
      // Vault balance should not change
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore);
    });

    it("should correctly count skipped and cancelled requests in summary", async function () {
      const shares1 = ethers.parseUnits("1000", 18);
      const shares2 = ethers.parseUnits("2000", 18);
      const shares3 = ethers.parseUnits("1500", 18);

      await vault.connect(user1).approve(await vault.getAddress(), shares1);
      await vault.connect(user2).approve(await vault.getAddress(), shares2);
      await vault.connect(blacklistedUser).approve(await vault.getAddress(), shares3);

      await vault.connect(user1).redeemShares(shares1, receiver1.address);
      await vault.connect(user2).redeemShares(shares2, receiver2.address);
      await vault.connect(blacklistedUser).redeemShares(shares3, receiver3.address);

      // Get sequence number from queue
      const request1FromQueue = await vault.pendingWithdrawals(0);
      const seqNum1 = request1FromQueue.sequenceNumber;

      // Cancel request1
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);

      // Blacklist owner of request3
      await protocolConfig.connect(owner).setBlacklistedAccount(blacklistedUser.address, true);

      const tx = await vault.connect(operator).processWithdrawalRequests(3);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "ProcessRequestsSummary"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.totalRequestProcessed).to.equal(3n);
      expect(parsedEvent?.args.requestsSkipped).to.equal(2n); // request1 (cancelled) and request3 (blacklisted)
      expect(parsedEvent?.args.requestsCancelled).to.equal(1n); // request1
    });
  });

  describe("Edge Cases", function () {
    it("should handle processing with rate changes", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), shares);

      const request = await vault.connect(user1).redeemShares(shares, receiver1.address);

      // Update rate (simulating rate change)
      const newRate = ethers.parseUnits("1.1", 18);
      const intervalSeconds = Number(BigInt(RATE_UPDATE_INTERVAL) / 1000n) + 1;
      await ethers.provider.send("evm_increaseTime", [intervalSeconds]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(rateManager).updateVaultRate(newRate);

      // Process request - should use new rate
      const expectedAmount = await math.div(shares, newRate);
      const receiverBalanceBefore = await collateralToken.balanceOf(receiver1.address);

      await vault.connect(operator).processWithdrawalRequests(1);

      const receiverBalanceAfter = await collateralToken.balanceOf(receiver1.address);
      expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + expectedAmount);
    });

    it("should handle processing requests in correct FIFO order", async function () {
      const shares1 = ethers.parseUnits("1000", 18);
      const shares2 = ethers.parseUnits("2000", 18);
      const shares3 = ethers.parseUnits("1500", 18);

      await vault.connect(user1).approve(await vault.getAddress(), shares1);
      await vault.connect(user2).approve(await vault.getAddress(), shares2);
      await vault.connect(user3).approve(await vault.getAddress(), shares3);

      await vault.connect(user1).redeemShares(shares1, receiver1.address);
      await vault.connect(user2).redeemShares(shares2, receiver2.address);
      await vault.connect(user3).redeemShares(shares3, receiver3.address);

      // Get sequence numbers from queue
      const request1FromQueue = await vault.getPendingWithdrawal(0);
      const request2FromQueue = await vault.getPendingWithdrawal(1);
      const request3FromQueue = await vault.getPendingWithdrawal(2);
      const seqNum1 = request1FromQueue.sequenceNumber;
      const seqNum2 = request2FromQueue.sequenceNumber;
      const seqNum3 = request3FromQueue.sequenceNumber;

      // Process one at a time and verify order
      await vault.connect(operator).processWithdrawalRequests(1);
      const queueLengthAfterFirst = await vault.getPendingWithdrawalsLength();
      expect(queueLengthAfterFirst).to.equal(2n);
      const queueAfterFirst = await vault.getPendingWithdrawal(0);
      expect(queueAfterFirst.sequenceNumber).to.equal(seqNum2);

      await vault.connect(operator).processWithdrawalRequests(1);
      const queueLengthAfterSecond = await vault.getPendingWithdrawalsLength();
      expect(queueLengthAfterSecond).to.equal(1n);
      const queueAfterSecond = await vault.getPendingWithdrawal(0);
      expect(queueAfterSecond.sequenceNumber).to.equal(seqNum3);
    });

    it("should handle account state cleanup when all requests processed", async function () {
      const shares = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), shares);

      await vault.connect(user1).redeemShares(shares, receiver1.address);

      const accountStateBefore = await vault.getAccountState(user1.address);
      expect(accountStateBefore.totalPendingWithdrawalShares).to.equal(shares);

      await vault.connect(operator).processWithdrawalRequests(1);

      const accountStateAfter = await vault.getAccountState(user1.address);
      expect(accountStateAfter.totalPendingWithdrawalShares).to.equal(0n);
      expect(accountStateAfter.pendingWithdrawalRequestSequenceNumbers.length).to.equal(0);
    });
  });

  describe("Integration Tests", function () {
    it("should work correctly with mixed scenarios", async function () {
      const shares1 = ethers.parseUnits("1000", 18);
      const shares2 = ethers.parseUnits("2000", 18);
      const shares3 = ethers.parseUnits("1500", 18);

      await vault.connect(user1).approve(await vault.getAddress(), shares1);
      await vault.connect(user2).approve(await vault.getAddress(), shares2);
      await vault.connect(blacklistedUser).approve(await vault.getAddress(), shares3);

      await vault.connect(user1).redeemShares(shares1, receiver1.address);
      await vault.connect(user2).redeemShares(shares2, receiver2.address);
      await vault.connect(blacklistedUser).redeemShares(shares3, receiver3.address);

      // Get sequence number from queue
      const request1FromQueue = await vault.pendingWithdrawals(0);
      const seqNum1 = request1FromQueue.sequenceNumber;

      // Cancel request1
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);

      // Blacklist owner of request3
      await protocolConfig.connect(owner).setBlacklistedAccount(blacklistedUser.address, true);

      const totalSharesBefore = await vault.totalSupply();
      const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

      // Process all
      await vault.connect(operator).processWithdrawalRequests(3);

      const totalSharesAfter = await vault.totalSupply();
      const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());

      // Only request2 should be processed (request1 cancelled, request3 blacklisted)
      const expectedAmount2 = await math.div(shares2, INITIAL_RATE);
      expect(totalSharesAfter).to.equal(totalSharesBefore - shares2); // Only shares2 burnt
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore - expectedAmount2);

      // Shares1 and shares3 should be returned to owners
      // Users originally had 10000 shares from deposits, then redeemed shares1/shares3
      // After processing cancelled/blacklisted requests, those shares are returned
      const user1BalanceBeforeRedeem = ethers.parseUnits("10000", 18);
      const blacklistedUserBalanceBeforeRedeem = ethers.parseUnits("10000", 18);
      expect(await vault.balanceOf(user1.address)).to.equal(user1BalanceBeforeRedeem);
      expect(await vault.balanceOf(blacklistedUser.address)).to.equal(
        blacklistedUserBalanceBeforeRedeem
      );
    });

    it("should maintain correct state after partial processing", async function () {
      const shares1 = ethers.parseUnits("1000", 18);
      const shares2 = ethers.parseUnits("2000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), shares1);
      await vault.connect(user2).approve(await vault.getAddress(), shares2);

      await vault.connect(user1).redeemShares(shares1, receiver1.address);
      await vault.connect(user2).redeemShares(shares2, receiver2.address);

      // Process only first request
      await vault.connect(operator).processWithdrawalRequests(1);

      // Verify account states
      const accountState1 = await vault.getAccountState(user1.address);
      const accountState2 = await vault.getAccountState(user2.address);

      expect(accountState1.totalPendingWithdrawalShares).to.equal(0n);
      expect(accountState2.totalPendingWithdrawalShares).to.equal(shares2);
    });
  });
});
