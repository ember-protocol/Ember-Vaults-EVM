import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type {
  EmberVault,
  EmberProtocolConfig,
  ERC20Token,
  FixedPointMathWrapper,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmberVault - Cancel Pending Withdrawal Request", function () {
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
    it("should allow user to cancel their pending withdrawal request", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      await expect(vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber))
        .to.emit(vault, "RequestCancelled")
        .withArgs(
          await vault.getAddress(),
          user1.address,
          sequenceNumber,
          (cancelList: any) => {
            expect(cancelList).to.be.an("array");
            expect(cancelList.length).to.equal(1);
            expect(cancelList[0]).to.equal(sequenceNumber);
            return true;
          },
          (timestamp: any) => {
            expect(timestamp).to.be.a("bigint");
            return true;
          }
        );

      // Verify the sequence number is in the cancel list
      const accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(sequenceNumber);
    });

    it("should allow user to cancel multiple withdrawal requests", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 3n);

      // Create 3 withdrawal requests
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      const seqNum1 = request1.sequenceNumber;

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver2.address);
      const request2 = await vault.pendingWithdrawals(1);
      const seqNum2 = request2.sequenceNumber;

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request3 = await vault.pendingWithdrawals(2);
      const seqNum3 = request3.sequenceNumber;

      // Cancel first request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);
      let accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum1);

      // Cancel second request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum2);
      accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(2);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum1);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[1]).to.equal(seqNum2);

      // Cancel third request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum3);
      accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(3);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum1);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[1]).to.equal(seqNum2);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[2]).to.equal(seqNum3);
    });

    it("should allow user to cancel requests in any order", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 3n);

      // Create 3 withdrawal requests
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      const seqNum1 = request1.sequenceNumber;

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver2.address);
      const request2 = await vault.pendingWithdrawals(1);
      const seqNum2 = request2.sequenceNumber;

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request3 = await vault.pendingWithdrawals(2);
      const seqNum3 = request3.sequenceNumber;

      // Cancel in reverse order (3, 1, 2)
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum3);
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum2);

      const accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(3);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum3);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[1]).to.equal(seqNum1);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[2]).to.equal(seqNum2);
    });

    it("should emit RequestCancelled event with correct parameters", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      const tx = await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestCancelled"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = vault.interface.parseLog(event!);
      expect(parsedEvent?.args.vault).to.equal(await vault.getAddress());
      expect(parsedEvent?.args.owner).to.equal(user1.address);
      expect(parsedEvent?.args.requestSequenceNumber).to.equal(sequenceNumber);
      expect(parsedEvent?.args.cancelWithdrawRequestSequenceNumbers).to.be.an("array");
      expect(parsedEvent?.args.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
      expect(parsedEvent?.args.cancelWithdrawRequestSequenceNumbers[0]).to.equal(sequenceNumber);
      expect(parsedEvent?.args.timestamp).to.be.a("bigint");
      expect(parsedEvent?.args.timestamp).to.be.gt(0n);
    });

    it("should update cancel list correctly in account state", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 2n);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      const seqNum1 = request1.sequenceNumber;

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver2.address);
      const request2 = await vault.pendingWithdrawals(1);
      const seqNum2 = request2.sequenceNumber;

      // Initial state - no cancellations
      let accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(0);

      // Cancel first request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);
      accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum1);

      // Cancel second request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum2);
      accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(2);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum1);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[1]).to.equal(seqNum2);
    });

    it("should not affect pending withdrawal shares when cancelling", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      const accountStateBefore = await vault.getAccountState(user1.address);
      const pendingSharesBefore = accountStateBefore.totalPendingWithdrawalShares;

      await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber);

      const accountStateAfter = await vault.getAccountState(user1.address);
      expect(accountStateAfter.totalPendingWithdrawalShares).to.equal(pendingSharesBefore);
      expect(accountStateAfter.totalPendingWithdrawalShares).to.equal(sharesToRedeem);
    });

    it("should not remove request from pending list when cancelling", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      const accountStateBefore = await vault.getAccountState(user1.address);
      const pendingListLengthBefore =
        accountStateBefore.pendingWithdrawalRequestSequenceNumbers.length;

      await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber);

      const accountStateAfter = await vault.getAccountState(user1.address);
      expect(accountStateAfter.pendingWithdrawalRequestSequenceNumbers.length).to.equal(
        pendingListLengthBefore
      );
      expect(accountStateAfter.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(sequenceNumber);
    });
  });

  describe("Validation - Protocol Pause", function () {
    it("should reject cancel when protocol is paused", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      await protocolConfig.connect(owner).pauseNonAdminOperations(true);

      await expect(
        vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber)
      ).to.be.revertedWithCustomError(vault, "ProtocolPaused");

      // Unpause for cleanup
      await protocolConfig.connect(owner).pauseNonAdminOperations(false);
    });

    it("should allow cancel when protocol is unpaused", async function () {
      // Ensure protocol is not paused
      const isPaused = await protocolConfig.getProtocolPauseStatus();
      if (isPaused) {
        await protocolConfig.connect(owner).pauseNonAdminOperations(false);
      }

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      await expect(vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber)).to.emit(
        vault,
        "RequestCancelled"
      );
    });
  });

  describe("Validation - Vault Pause", function () {
    it("should reject cancel when withdrawals are paused", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "withdrawals", true);

      await expect(
        vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber)
      ).to.be.revertedWithCustomError(vault, "OperationPaused");

      // Unpause for cleanup
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "withdrawals", false);
    });

    it("should allow cancel when withdrawals are unpaused", async function () {
      // Ensure withdrawals are not paused
      const pauseStatus = await vault.pauseStatus();
      if (pauseStatus.withdrawals) {
        await protocolConfig
          .connect(admin)
          .setVaultPausedStatus(await vault.getAddress(), "withdrawals", false);
      }

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      await expect(vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber)).to.emit(
        vault,
        "RequestCancelled"
      );
    });

    it("should allow cancel when deposits are paused but withdrawals are not", async function () {
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "deposits", true);

      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      await expect(vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber)).to.emit(
        vault,
        "RequestCancelled"
      );

      // Unpause for cleanup
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "deposits", false);
    });
  });

  describe("Validation - User Does Not Have Account", function () {
    it("should reject cancel when user has no pending withdrawals", async function () {
      // User with no redemptions
      const fakeSequenceNumber = 12345n;

      await expect(
        vault.connect(user1).cancelPendingWithdrawalRequest(fakeSequenceNumber)
      ).to.be.revertedWithCustomError(vault, "InvalidRequest");
    });

    it("should reject cancel when user has no account after all withdrawals processed", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      // Note: In a real scenario, the withdrawal would be processed and account removed
      // But for testing, we can verify the error message when account has no pending shares
      // Actually, the account still exists if there are pending requests, so this test
      // should check when totalPendingWithdrawalShares is 0 but account might still exist
      // Let's test with a user that has no account at all
      const fakeSequenceNumber = 99999n;
      await expect(
        vault.connect(user2).cancelPendingWithdrawalRequest(fakeSequenceNumber)
      ).to.be.revertedWithCustomError(vault, "InvalidRequest");
    });
  });

  describe("Validation - Request Already Cancelled", function () {
    it("should reject cancel when request is already cancelled", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      // Cancel once
      await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber);

      // Try to cancel again
      await expect(
        vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber)
      ).to.be.revertedWithCustomError(vault, "InvalidRequest");
    });

    it("should reject cancel when request is already in cancel list", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 2n);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      const seqNum1 = request1.sequenceNumber;

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver2.address);
      const request2 = await vault.pendingWithdrawals(1);
      const seqNum2 = request2.sequenceNumber;

      // Cancel first request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);

      // Try to cancel first request again
      await expect(
        vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1)
      ).to.be.revertedWithCustomError(vault, "InvalidRequest");

      // Cancel second request (should work)
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum2);

      // Verify both are in cancel list
      const accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(2);
    });
  });

  describe("Validation - Invalid Request", function () {
    it("should reject cancel when sequence number does not exist in pending requests", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const actualSequenceNumber = request.sequenceNumber;

      // Try to cancel with a non-existent sequence number
      const fakeSequenceNumber = actualSequenceNumber + 1000n;

      await expect(
        vault.connect(user1).cancelPendingWithdrawalRequest(fakeSequenceNumber)
      ).to.be.revertedWithCustomError(vault, "InvalidRequest");
    });

    it("should reject cancel when sequence number belongs to different user", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      const seqNum1 = request1.sequenceNumber;

      await vault.connect(user2).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user2).redeemShares(sharesToRedeem, receiver2.address);
      const request2 = await vault.pendingWithdrawals(1);
      const seqNum2 = request2.sequenceNumber;

      // User1 tries to cancel User2's request
      await expect(
        vault.connect(user1).cancelPendingWithdrawalRequest(seqNum2)
      ).to.be.revertedWithCustomError(vault, "InvalidRequest");

      // User2 tries to cancel User1's request
      await expect(
        vault.connect(user2).cancelPendingWithdrawalRequest(seqNum1)
      ).to.be.revertedWithCustomError(vault, "InvalidRequest");

      // Each user should be able to cancel their own request
      await expect(vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1)).to.emit(
        vault,
        "RequestCancelled"
      );

      await expect(vault.connect(user2).cancelPendingWithdrawalRequest(seqNum2)).to.emit(
        vault,
        "RequestCancelled"
      );
    });

    it("should reject cancel with zero sequence number when no such request exists", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);

      // Try to cancel with sequence number 0 (unlikely to exist)
      await expect(
        vault.connect(user1).cancelPendingWithdrawalRequest(0n)
      ).to.be.revertedWithCustomError(vault, "InvalidRequest");
    });
  });

  describe("Edge Cases", function () {
    it("should handle cancelling request with minimum shares", async function () {
      const minShares = await vault.minWithdrawableShares();
      await vault.connect(user1).approve(await vault.getAddress(), minShares);

      await vault.connect(user1).redeemShares(minShares, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      await expect(vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber)).to.emit(
        vault,
        "RequestCancelled"
      );

      const accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(sequenceNumber);
    });

    it("should handle cancelling request with large share amounts", async function () {
      const userBalance = await vault.balanceOf(user1.address);
      const sharesToRedeem = userBalance / 2n; // Redeem half

      if (sharesToRedeem >= (await vault.minWithdrawableShares())) {
        await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

        await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
        const request = await vault.pendingWithdrawals(0);
        const sequenceNumber = request.sequenceNumber;

        await expect(vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber)).to.emit(
          vault,
          "RequestCancelled"
        );
      }
    });

    it("should handle cancelling multiple requests rapidly", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      const userBalance = await vault.balanceOf(user1.address);

      if (userBalance >= sharesToRedeem * 5n) {
        await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 5n);

        const sequenceNumbers: bigint[] = [];

        // Create 5 requests
        for (let i = 0; i < 5; i++) {
          await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
          const request = await vault.pendingWithdrawals(i);
          sequenceNumbers.push(request.sequenceNumber);
        }

        // Cancel all 5 rapidly
        for (let i = 0; i < 5; i++) {
          await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumbers[i]);
        }

        const accountState = await vault.getAccountState(user1.address);
        expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(5);
        for (let i = 0; i < 5; i++) {
          expect(accountState.cancelWithdrawRequestSequenceNumbers[i]).to.equal(sequenceNumbers[i]);
        }
      }
    });

    it("should handle cancelling requests in mixed order", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 5n);

      const sequenceNumbers: bigint[] = [];

      // Create 5 requests
      for (let i = 0; i < 5; i++) {
        await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
        const request = await vault.pendingWithdrawals(i);
        sequenceNumbers.push(request.sequenceNumber);
      }

      // Cancel in mixed order: 2, 4, 0, 3, 1
      const cancelOrder = [2, 4, 0, 3, 1];
      for (const index of cancelOrder) {
        await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumbers[index]);
      }

      const accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(5);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(sequenceNumbers[2]);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[1]).to.equal(sequenceNumbers[4]);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[2]).to.equal(sequenceNumbers[0]);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[3]).to.equal(sequenceNumbers[3]);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[4]).to.equal(sequenceNumbers[1]);
    });

    it("should preserve state after failed cancel attempt", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      // Try to cancel with wrong sequence number (should fail)
      await expect(
        vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber + 1000n)
      ).to.be.revertedWithCustomError(vault, "InvalidRequest");

      // State should be unchanged
      const accountState = await vault.getAccountState(user1.address);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(0);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(1);

      // Now cancel correctly (should work)
      await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber);
      const accountStateAfter = await vault.getAccountState(user1.address);
      expect(accountStateAfter.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
    });

    it("should handle cancelling when user has many pending requests", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      const userBalance = await vault.balanceOf(user1.address);

      if (userBalance >= sharesToRedeem * 10n) {
        await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 10n);

        const sequenceNumbers: bigint[] = [];

        // Create 10 requests
        for (let i = 0; i < 10; i++) {
          await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
          const request = await vault.pendingWithdrawals(i);
          sequenceNumbers.push(request.sequenceNumber);
        }

        // Cancel every other request (0, 2, 4, 6, 8)
        for (let i = 0; i < 10; i += 2) {
          await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumbers[i]);
        }

        const accountState = await vault.getAccountState(user1.address);
        expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(5);
        expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(10);
      }
    });
  });

  describe("Multiple Users", function () {
    it("should allow multiple users to cancel their own requests independently", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user2).approve(await vault.getAddress(), sharesToRedeem);
      await vault.connect(user3).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      const seqNum1 = request1.sequenceNumber;

      await vault.connect(user2).redeemShares(sharesToRedeem, receiver2.address);
      const request2 = await vault.pendingWithdrawals(1);
      const seqNum2 = request2.sequenceNumber;

      await vault.connect(user3).redeemShares(sharesToRedeem, receiver1.address);
      const request3 = await vault.pendingWithdrawals(2);
      const seqNum3 = request3.sequenceNumber;

      // Each user cancels their own request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);
      await vault.connect(user2).cancelPendingWithdrawalRequest(seqNum2);
      await vault.connect(user3).cancelPendingWithdrawalRequest(seqNum3);

      const accountState1 = await vault.getAccountState(user1.address);
      const accountState2 = await vault.getAccountState(user2.address);
      const accountState3 = await vault.getAccountState(user3.address);

      expect(accountState1.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
      expect(accountState1.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum1);

      expect(accountState2.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
      expect(accountState2.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum2);

      expect(accountState3.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
      expect(accountState3.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum3);
    });

    it("should maintain separate cancel lists for different users", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);

      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 2n);
      await vault.connect(user2).approve(await vault.getAddress(), sharesToRedeem * 2n);

      // User1 creates 2 requests
      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      const seqNum1 = request1.sequenceNumber;

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver2.address);
      const request2 = await vault.pendingWithdrawals(1);
      const seqNum2 = request2.sequenceNumber;

      // User2 creates 2 requests
      await vault.connect(user2).redeemShares(sharesToRedeem, receiver1.address);
      const request3 = await vault.pendingWithdrawals(2);
      const seqNum3 = request3.sequenceNumber;

      await vault.connect(user2).redeemShares(sharesToRedeem, receiver2.address);
      const request4 = await vault.pendingWithdrawals(3);
      const seqNum4 = request4.sequenceNumber;

      // User1 cancels their requests
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum2);

      // User2 cancels their requests
      await vault.connect(user2).cancelPendingWithdrawalRequest(seqNum3);
      await vault.connect(user2).cancelPendingWithdrawalRequest(seqNum4);

      const accountState1 = await vault.getAccountState(user1.address);
      const accountState2 = await vault.getAccountState(user2.address);

      expect(accountState1.cancelWithdrawRequestSequenceNumbers.length).to.equal(2);
      expect(accountState1.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum1);
      expect(accountState1.cancelWithdrawRequestSequenceNumbers[1]).to.equal(seqNum2);

      expect(accountState2.cancelWithdrawRequestSequenceNumbers.length).to.equal(2);
      expect(accountState2.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum3);
      expect(accountState2.cancelWithdrawRequestSequenceNumbers[1]).to.equal(seqNum4);
    });
  });

  describe("Event Verification", function () {
    it("should emit event with correct vault address", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      const tx = await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestCancelled"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = vault.interface.parseLog(event!);
      expect(parsedEvent?.args.vault).to.equal(await vault.getAddress());
    });

    it("should emit event with correct owner address", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      const tx = await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestCancelled"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.owner).to.equal(user1.address);
    });

    it("should emit event with correct sequence number", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      const tx = await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestCancelled"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.requestSequenceNumber).to.equal(sequenceNumber);
      expect(parsedEvent?.args.timestamp).to.be.a("bigint");
      expect(parsedEvent?.args.timestamp).to.be.gt(0n);
    });

    it("should emit event with correct cancel list", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 3n);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      const seqNum1 = request1.sequenceNumber;

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver2.address);
      const request2 = await vault.pendingWithdrawals(1);
      const seqNum2 = request2.sequenceNumber;

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request3 = await vault.pendingWithdrawals(2);
      const seqNum3 = request3.sequenceNumber;

      // Cancel first request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);

      // Cancel second request and check event
      const tx = await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum2);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestCancelled"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.cancelWithdrawRequestSequenceNumbers).to.be.an("array");
      expect(parsedEvent?.args.cancelWithdrawRequestSequenceNumbers.length).to.equal(2);
      expect(parsedEvent?.args.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum1);
      expect(parsedEvent?.args.cancelWithdrawRequestSequenceNumbers[1]).to.equal(seqNum2);
      expect(parsedEvent?.args.timestamp).to.be.a("bigint");
      expect(parsedEvent?.args.timestamp).to.be.gt(0n);
    });

    it("should emit event with valid timestamp", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request = await vault.pendingWithdrawals(0);
      const sequenceNumber = request.sequenceNumber;

      const tx = await vault.connect(user1).cancelPendingWithdrawalRequest(sequenceNumber);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "RequestCancelled"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.timestamp).to.be.a("bigint");
      expect(parsedEvent?.args.timestamp).to.be.gt(0n);
      expect(parsedEvent?.args.timestamp).to.be.gte(BigInt(block!.timestamp) * 1000n);
    });
  });

  describe("Integration Tests", function () {
    it("should work correctly with redeem and cancel operations", async function () {
      const sharesToRedeem1 = ethers.parseUnits("1000", 18);
      const sharesToRedeem2 = ethers.parseUnits("500", 18);

      await vault
        .connect(user1)
        .approve(await vault.getAddress(), sharesToRedeem1 + sharesToRedeem2);

      // Redeem first request
      await vault.connect(user1).redeemShares(sharesToRedeem1, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      const seqNum1 = request1.sequenceNumber;

      // Cancel first request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);

      // Redeem second request
      await vault.connect(user1).redeemShares(sharesToRedeem2, receiver2.address);
      const request2 = await vault.pendingWithdrawals(1);
      const seqNum2 = request2.sequenceNumber;

      // Verify state
      const accountState = await vault.getAccountState(user1.address);
      expect(accountState.totalPendingWithdrawalShares).to.equal(sharesToRedeem1 + sharesToRedeem2);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(2);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum1);
    });

    it("should maintain correct state after multiple redeem and cancel operations", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 5n);

      const cancelledSequenceNumbers: bigint[] = [];
      const activeSequenceNumbers: bigint[] = [];

      // Create 5 requests
      for (let i = 0; i < 5; i++) {
        await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
        const request = await vault.pendingWithdrawals(i);
        if (i % 2 === 0) {
          // Cancel even-indexed requests
          await vault.connect(user1).cancelPendingWithdrawalRequest(request.sequenceNumber);
          cancelledSequenceNumbers.push(request.sequenceNumber);
        } else {
          activeSequenceNumbers.push(request.sequenceNumber);
        }
      }

      const accountState = await vault.getAccountState(user1.address);
      expect(accountState.totalPendingWithdrawalShares).to.equal(sharesToRedeem * 5n);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(5);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(3);
    });

    it("should work correctly with getAccountState after cancellation", async function () {
      const sharesToRedeem = ethers.parseUnits("1000", 18);
      await vault.connect(user1).approve(await vault.getAddress(), sharesToRedeem * 2n);

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver1.address);
      const request1 = await vault.pendingWithdrawals(0);
      const seqNum1 = request1.sequenceNumber;

      await vault.connect(user1).redeemShares(sharesToRedeem, receiver2.address);
      const request2 = await vault.pendingWithdrawals(1);
      const seqNum2 = request2.sequenceNumber;

      // Cancel first request
      await vault.connect(user1).cancelPendingWithdrawalRequest(seqNum1);

      // Verify getAccountState returns correct data
      const accountState = await vault.getAccountState(user1.address);
      expect(accountState.totalPendingWithdrawalShares).to.equal(sharesToRedeem * 2n);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers.length).to.equal(2);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers[0]).to.equal(seqNum1);
      expect(accountState.pendingWithdrawalRequestSequenceNumbers[1]).to.equal(seqNum2);
      expect(accountState.cancelWithdrawRequestSequenceNumbers.length).to.equal(1);
      expect(accountState.cancelWithdrawRequestSequenceNumbers[0]).to.equal(seqNum1);
    });
  });
});
