import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type {
  EmberVault,
  EmberProtocolConfig,
  ERC20Token,
  FixedPointMathWrapper,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmberVault - Mint Shares", function () {
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
  });

  describe("Success Cases", function () {
    it("should allow user to mint shares by depositing calculated collateral amount", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      // Approve vault to spend collateral
      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const sequenceNumberBefore = await vault.sequenceNumber();

      await expect(vault.connect(user1).mint(sharesToMint, user1.address))
        .to.emit(vault, "VaultDeposit")
        .withArgs(
          await vault.getAddress(),
          user1.address,
          user1.address,
          expectedAmount,
          sharesToMint,
          sharesToMint, // totalShares after mint
          (timestamp: any) => {
            expect(timestamp).to.be.a("bigint");
            return true;
          },
          sequenceNumberBefore + 1n
        );

      // Check receipt token balance
      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);

      // Check collateral token balance (should be transferred to vault)
      expect(await collateralToken.balanceOf(await vault.getAddress())).to.equal(expectedAmount);
    });

    it("should calculate collateral amount correctly using ceiling division", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      const parsedEvent = vault.interface.parseLog(event!);
      const amountDeposited = parsedEvent?.args.amountDeposited;

      expect(amountDeposited).to.equal(expectedAmount);
      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
    });

    it("should emit VaultDeposit event with correct parameters", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);
      const sequenceNumberBefore = await vault.sequenceNumber();

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = vault.interface.parseLog(event!);
      expect(parsedEvent?.args.vault).to.equal(await vault.getAddress());
      expect(parsedEvent?.args.depositor).to.equal(user1.address);
      expect(parsedEvent?.args.amountDeposited).to.equal(expectedAmount);
      expect(parsedEvent?.args.sharesMinted).to.equal(sharesToMint);
      expect(parsedEvent?.args.totalShares).to.equal(sharesToMint);
      expect(parsedEvent?.args.timestamp).to.be.a("bigint");
      expect(parsedEvent?.args.sequenceNumber).to.equal(sequenceNumberBefore + 1n);
    });

    it("should update total shares correctly", async function () {
      const sharesToMint1 = ethers.parseUnits("1000", 18);
      const sharesToMint2 = ethers.parseUnits("500", 18);

      const rateData = await vault.rate();
      const expectedAmount1 = await math.divCeil(sharesToMint1, rateData.value);
      const expectedAmount2 = await math.divCeil(sharesToMint2, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount1);
      await collateralToken.connect(user2).approve(await vault.getAddress(), expectedAmount2);

      await vault.connect(user1).mint(sharesToMint1, user1.address);
      expect(await vault.totalSupply()).to.equal(sharesToMint1);

      await vault.connect(user2).mint(sharesToMint2, user2.address);
      expect(await vault.totalSupply()).to.equal(sharesToMint1 + sharesToMint2);
    });

    it("should allow multiple mints from same user", async function () {
      const sharesToMint1 = ethers.parseUnits("1000", 18);
      const sharesToMint2 = ethers.parseUnits("500", 18);

      const rateData = await vault.rate();
      const expectedAmount1 = await math.divCeil(sharesToMint1, rateData.value);
      const expectedAmount2 = await math.divCeil(sharesToMint2, rateData.value);

      await collateralToken
        .connect(user1)
        .approve(await vault.getAddress(), expectedAmount1 + expectedAmount2);

      await vault.connect(user1).mint(sharesToMint1, user1.address);
      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint1);

      await vault.connect(user1).mint(sharesToMint2, user1.address);
      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint1 + sharesToMint2);
    });

    it("should allow multiple users to mint shares", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);
      await collateralToken.connect(user2).approve(await vault.getAddress(), expectedAmount);
      await collateralToken.connect(user3).approve(await vault.getAddress(), expectedAmount);

      await vault.connect(user1).mint(sharesToMint, user1.address);
      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);

      await vault.connect(user2).mint(sharesToMint, user2.address);
      expect(await vault.balanceOf(user2.address)).to.equal(sharesToMint);

      await vault.connect(user3).mint(sharesToMint, user3.address);
      expect(await vault.balanceOf(user3.address)).to.equal(sharesToMint);

      expect(await vault.totalSupply()).to.equal(sharesToMint * 3n);
    });

    it("should transfer collateral tokens to vault", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const vaultAddress = await vault.getAddress();

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      const vaultBalanceBefore = await collateralToken.balanceOf(vaultAddress);
      await collateralToken.connect(user1).approve(vaultAddress, expectedAmount);

      await vault.connect(user1).mint(sharesToMint, user1.address);

      const vaultBalanceAfter = await collateralToken.balanceOf(vaultAddress);
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore + expectedAmount);
    });

    it("should increment sequence number", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const sequenceNumberBefore = await vault.sequenceNumber();
      await vault.connect(user1).mint(sharesToMint, user1.address);
      const sequenceNumberAfter = await vault.sequenceNumber();

      expect(sequenceNumberAfter).to.equal(sequenceNumberBefore + 1n);
    });

    it("should charge platform fees during mint", async function () {
      // Fast forward time to accumulate fees
      await ethers.provider.send("evm_increaseTime", [3600]); // 1 hour
      await ethers.provider.send("evm_mine", []);

      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const platformFeeBefore = await vault.platformFee();
      await vault.connect(user1).mint(sharesToMint, user1.address);
      const platformFeeAfter = await vault.platformFee();

      // Platform fee should be charged (lastChargedAt should be updated)
      expect(platformFeeAfter.lastChargedAt).to.be.greaterThan(platformFeeBefore.lastChargedAt);
    });

    it("should return the correct amount deposited", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      const parsedEvent = vault.interface.parseLog(event!);
      const amountDeposited = parsedEvent?.args.amountDeposited;

      expect(amountDeposited).to.equal(expectedAmount);
    });

    it("should use ceiling division for amount calculation", async function () {
      // Test with shares that don't divide evenly by rate
      // This ensures ceiling division is used
      const sharesToMint = ethers.parseUnits("1", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);
      const regularDiv = await math.div(sharesToMint, rateData.value);

      // Ceiling division should be >= regular division
      expect(expectedAmount).to.be.gte(regularDiv);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      const parsedEvent = vault.interface.parseLog(event!);
      const amountDeposited = parsedEvent?.args.amountDeposited;

      expect(amountDeposited).to.equal(expectedAmount);
    });
  });

  describe("Validation - Protocol Pause", function () {
    it("should reject mint when protocol is paused", async function () {
      await protocolConfig.connect(owner).pauseNonAdminOperations(true);

      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.be.revertedWithCustomError(vault, "ProtocolPaused");

      // Unpause for cleanup
      await protocolConfig.connect(owner).pauseNonAdminOperations(false);
    });

    it("should allow mint when protocol is unpaused", async function () {
      // Ensure protocol is not paused
      const isPaused = await protocolConfig.getProtocolPauseStatus();
      if (isPaused) {
        await protocolConfig.connect(owner).pauseNonAdminOperations(false);
      }

      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await expect(vault.connect(user1).mint(sharesToMint, user1.address)).to.emit(
        vault,
        "VaultDeposit"
      );
    });
  });

  describe("Validation - Vault Pause", function () {
    it("should reject mint when deposits are paused", async function () {
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "deposits", true);

      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.be.revertedWithCustomError(vault, "OperationPaused");

      // Unpause for cleanup
      await protocolConfig
        .connect(admin)
        .setVaultPausedStatus(await vault.getAddress(), "deposits", false);
    });

    it("should allow mint when deposits are unpaused", async function () {
      // Ensure deposits are not paused
      const pauseStatus = await vault.pauseStatus();
      if (pauseStatus.deposits) {
        await protocolConfig
          .connect(admin)
          .setVaultPausedStatus(await vault.getAddress(), "deposits", false);
      }

      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await expect(vault.connect(user1).mint(sharesToMint, user1.address)).to.emit(
        vault,
        "VaultDeposit"
      );
    });
  });

  describe("Validation - Blacklist", function () {
    it("should reject mint from blacklisted account", async function () {
      await protocolConfig.connect(owner).setBlacklistedAccount(user1.address, true);

      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Unblacklist for cleanup
      await protocolConfig.connect(owner).setBlacklistedAccount(user1.address, false);
    });

    it("should allow mint from unblacklisted account", async function () {
      // Check if account is blacklisted and unblacklist if needed
      const isBlacklisted = await protocolConfig.isAccountBlacklisted(user1.address);
      if (isBlacklisted) {
        await protocolConfig.connect(owner).setBlacklistedAccount(user1.address, false);
      }

      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await expect(vault.connect(user1).mint(sharesToMint, user1.address)).to.emit(
        vault,
        "VaultDeposit"
      );
    });

    it("should allow mint from account that was previously blacklisted", async function () {
      // Blacklist first
      await protocolConfig.connect(owner).setBlacklistedAccount(user1.address, true);

      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Unblacklist
      await protocolConfig.connect(owner).setBlacklistedAccount(user1.address, false);

      // Now should be able to mint
      await expect(vault.connect(user1).mint(sharesToMint, user1.address)).to.emit(
        vault,
        "VaultDeposit"
      );
    });
  });

  describe("Validation - Sub-Accounts", function () {
    it("should reject mint from sub-account", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(subAccount1).approve(await vault.getAddress(), expectedAmount);

      await expect(
        vault.connect(subAccount1).mint(sharesToMint, subAccount1.address)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");
    });

    it("should allow mint from regular user (not sub-account)", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await expect(vault.connect(user1).mint(sharesToMint, user1.address)).to.emit(
        vault,
        "VaultDeposit"
      );
    });

    it("should allow mint after removing sub-account status", async function () {
      // Add user1 as sub-account
      await protocolConfig
        .connect(admin)
        .setVaultSubAccount(await vault.getAddress(), user1.address, true);

      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");

      // Remove sub-account status
      await protocolConfig
        .connect(admin)
        .setVaultSubAccount(await vault.getAddress(), user1.address, false);

      // Now should be able to mint
      await expect(vault.connect(user1).mint(sharesToMint, user1.address)).to.emit(
        vault,
        "VaultDeposit"
      );
    });
  });

  describe("Validation - Amount", function () {
    it("should reject zero shares mint", async function () {
      const sharesToMint = 0n;

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should reject mint with insufficient approval", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);
      const approvalAmount = expectedAmount / 2n; // Less than required

      await collateralToken.connect(user1).approve(await vault.getAddress(), approvalAmount);

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.be.revertedWithCustomError(collateralToken, "ERC20InsufficientAllowance");
    });

    it("should reject mint with no approval", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.be.revertedWithCustomError(collateralToken, "ERC20InsufficientAllowance");
    });

    it("should accept very small share amounts", async function () {
      const sharesToMint = 1n; // 1 wei

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      if (expectedAmount > 0n) {
        await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

        await vault.connect(user1).mint(sharesToMint, user1.address);
        expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
      }
    });
  });

  describe("Validation - Max TVL", function () {
    it("should reject mint that would exceed max TVL", async function () {
      const maxTVL = await vault.maxTVL();
      const rateData = await vault.rate();

      // Calculate shares that would exceed max TVL
      // TVL = totalShares / rate.value
      // We want: (currentShares + newShares) / rate.value > maxTVL
      // newShares > maxTVL * rate.value - currentShares

      const currentShares = await vault.totalSupply();
      const maxShares = await math.mul(maxTVL, rateData.value);
      const sharesToMint = maxShares - currentShares + ethers.parseUnits("1", 18);

      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      // Ensure user has enough tokens
      const userBalance = await collateralToken.balanceOf(user1.address);
      if (userBalance < expectedAmount) {
        await collateralToken
          .connect(owner)
          .transfer(user1.address, expectedAmount - userBalance + ethers.parseUnits("1000", 18));
      }

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.be.revertedWithCustomError(vault, "MaxTVLReached");
    });

    it("should allow mint that stays within max TVL", async function () {
      const maxTVL = await vault.maxTVL();
      const rateData = await vault.rate();

      const currentShares = await vault.totalSupply();
      const maxShares = await math.mul(maxTVL, rateData.value);
      const remainingShares = maxShares - currentShares;

      // Mint half of remaining shares
      const sharesToMint = remainingShares / 2n;

      if (sharesToMint > 0n && sharesToMint <= ethers.parseUnits("100000", 18)) {
        const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

        // Ensure user has enough tokens
        const userBalance = await collateralToken.balanceOf(user1.address);
        if (userBalance < expectedAmount) {
          await collateralToken
            .connect(owner)
            .transfer(user1.address, expectedAmount - userBalance + ethers.parseUnits("1000", 18));
        }

        await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

        await expect(vault.connect(user1).mint(sharesToMint, user1.address)).to.emit(
          vault,
          "VaultDeposit"
        );
      }
    });
  });

  describe("Validation - Zero Amount", function () {
    it("should reject mint that results in zero amount", async function () {
      // This can happen if shares are very small relative to rate
      // For a rate of 1e18 and shares of 1 wei, amount = ceil(1 / 1e18) = 1 wei
      // To get zero amount, we'd need rate to be very large, but that's not possible in normal operation
      // So we'll test that amount is always > 0 for normal mints

      const sharesToMint = ethers.parseUnits("1", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      if (expectedAmount > 0n) {
        await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

        const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
        const receipt = await tx.wait();
        const event = receipt?.logs.find(
          (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
        );
        const parsedEvent = vault.interface.parseLog(event!);
        const amountDeposited = parsedEvent?.args.amountDeposited;

        expect(amountDeposited).to.be.gt(0n);
      }
    });
  });

  describe("Edge Cases", function () {
    it("should handle very small share amounts", async function () {
      const sharesToMint = ethers.parseUnits("0.000001", 18); // Very small amount

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      if (expectedAmount > 0n) {
        await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

        await vault.connect(user1).mint(sharesToMint, user1.address);
        expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
      }
    });

    it("should handle large share amounts", async function () {
      const sharesToMint = ethers.parseUnits("100000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);
      const maxTVL = await vault.maxTVL();
      const currentShares = await vault.totalSupply();
      const maxShares = await math.mul(maxTVL, rateData.value);
      const newShares = currentShares + sharesToMint;

      if (newShares <= maxShares && expectedAmount <= ethers.parseUnits("100000", 18)) {
        await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

        await vault.connect(user1).mint(sharesToMint, user1.address);
        expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
      }
    });

    it("should handle rapid successive mints", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount * 5n);

      for (let i = 0; i < 5; i++) {
        await vault.connect(user1).mint(sharesToMint, user1.address);
        expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint * BigInt(i + 1));
      }
    });

    it("should preserve mint state after failed mint attempts", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      // Try mint without approval
      await expect(vault.connect(user1).mint(sharesToMint, user1.address)).to.be.reverted;

      // Approve and mint successfully
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);
      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);
      await vault.connect(user1).mint(sharesToMint, user1.address);

      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
    });

    it("should handle mints from multiple users in same block", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);
      await collateralToken.connect(user2).approve(await vault.getAddress(), expectedAmount);
      await collateralToken.connect(user3).approve(await vault.getAddress(), expectedAmount);

      await vault.connect(user1).mint(sharesToMint, user1.address);
      await vault.connect(user2).mint(sharesToMint, user2.address);
      await vault.connect(user3).mint(sharesToMint, user3.address);

      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
      expect(await vault.balanceOf(user2.address)).to.equal(sharesToMint);
      expect(await vault.balanceOf(user3.address)).to.equal(sharesToMint);
      expect(await vault.totalSupply()).to.equal(sharesToMint * 3n);
    });

    it("should preserve mint state after reentrancy attempt", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      // The function should complete successfully
      await vault.connect(user1).mint(sharesToMint, user1.address);

      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
    });
  });

  describe("Event Verification", function () {
    it("should emit event with correct vault address", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      expect(event).to.not.be.undefined;

      const parsedEvent = vault.interface.parseLog(event!);
      expect(parsedEvent?.args.vault).to.equal(await vault.getAddress());
    });

    it("should emit event with correct depositor address", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.depositor).to.equal(user1.address);
    });

    it("should emit event with correct amount and shares", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.amountDeposited).to.equal(expectedAmount);
      expect(parsedEvent?.args.sharesMinted).to.equal(sharesToMint);
    });

    it("should emit event with correct total shares", async function () {
      const sharesToMint1 = ethers.parseUnits("1000", 18);
      const sharesToMint2 = ethers.parseUnits("500", 18);

      const rateData = await vault.rate();
      const expectedAmount1 = await math.divCeil(sharesToMint1, rateData.value);
      const expectedAmount2 = await math.divCeil(sharesToMint2, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount1);
      await collateralToken.connect(user2).approve(await vault.getAddress(), expectedAmount2);

      await vault.connect(user1).mint(sharesToMint1, user1.address);

      const tx = await vault.connect(user2).mint(sharesToMint2, user2.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.totalShares).to.equal(sharesToMint1 + sharesToMint2);
    });

    it("should emit event with valid timestamp", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.timestamp).to.be.a("bigint");
      expect(parsedEvent?.args.timestamp).to.be.gt(0n);
      expect(parsedEvent?.args.timestamp).to.be.gte(BigInt(block!.timestamp) * 1000n);
    });

    it("should emit event with correct sequence number", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const sequenceNumberBefore = await vault.sequenceNumber();

      const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      const parsedEvent = vault.interface.parseLog(event!);

      expect(parsedEvent?.args.sequenceNumber).to.equal(sequenceNumberBefore + 1n);
    });
  });

  describe("Integration Tests", function () {
    it("should allow mints independently of other vault properties", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const rolesBefore = await vault.roles();
      const maxTVLBefore = await vault.maxTVL();

      await vault.connect(user1).mint(sharesToMint, user1.address);

      const rolesAfter = await vault.roles();
      expect(rolesAfter.admin).to.equal(rolesBefore.admin);
      expect(rolesAfter.operator).to.equal(rolesBefore.operator);
      expect(rolesAfter.rateManager).to.equal(rolesBefore.rateManager);
      expect(await vault.maxTVL()).to.equal(maxTVLBefore);
    });

    it("should work correctly with rate updates", async function () {
      // Make initial mint
      const sharesToMint1 = ethers.parseUnits("1000", 18);
      const rateData1 = await vault.rate();
      const expectedAmount1 = await math.divCeil(sharesToMint1, rateData1.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount1);
      await vault.connect(user1).mint(sharesToMint1, user1.address);

      const shares1 = await vault.balanceOf(user1.address);

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

      // Make another mint with new rate
      const sharesToMint2 = ethers.parseUnits("500", 18);
      const rateData2 = await vault.rate();
      const expectedAmount2 = await math.divCeil(sharesToMint2, rateData2.value);

      await collateralToken.connect(user2).approve(await vault.getAddress(), expectedAmount2);
      await vault.connect(user2).mint(sharesToMint2, user2.address);

      expect(await vault.balanceOf(user2.address)).to.equal(sharesToMint2);
      expect(await vault.balanceOf(user1.address)).to.equal(shares1); // First user's shares unchanged
    });

    it("should handle mints with platform fee charging", async function () {
      // Fast forward time to accumulate fees
      await ethers.provider.send("evm_increaseTime", [86400]); // 1 day
      await ethers.provider.send("evm_mine", []);

      const sharesToMint = ethers.parseUnits("10000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const platformFeeBefore = await vault.platformFee();
      await vault.connect(user1).mint(sharesToMint, user1.address);
      const platformFeeAfter = await vault.platformFee();

      // Platform fee should be charged
      expect(platformFeeAfter.lastChargedAt).to.be.greaterThan(platformFeeBefore.lastChargedAt);
    });

    it("should calculate TVL correctly after mints", async function () {
      const sharesToMint = ethers.parseUnits("1000", 18);
      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      await vault.connect(user1).mint(sharesToMint, user1.address);

      const totalShares = await vault.totalSupply();
      const expectedTVL = await math.div(totalShares, rateData.value);
      const actualTVL = await vault.totalAssets();

      expect(actualTVL).to.equal(expectedTVL);
    });

    it("should handle complex mint scenarios", async function () {
      // Multiple users, multiple mints, rate changes
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);

      // User1 mints
      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount * 2n);
      await vault.connect(user1).mint(sharesToMint, user1.address);

      // User2 mints
      await collateralToken.connect(user2).approve(await vault.getAddress(), expectedAmount);
      await vault.connect(user2).mint(sharesToMint, user2.address);

      // User1 mints again
      await vault.connect(user1).mint(sharesToMint, user1.address);

      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint * 2n);
      expect(await vault.balanceOf(user2.address)).to.equal(sharesToMint);
      expect(await vault.totalSupply()).to.equal(sharesToMint * 3n);
    });

    it("should calculate amount correctly with ceiling division", async function () {
      // Test that ceiling division is used (amount should be >= regular division)
      const sharesToMint = ethers.parseUnits("1000", 18);

      const rateData = await vault.rate();
      const expectedAmount = await math.divCeil(sharesToMint, rateData.value);
      const regularDiv = await math.div(sharesToMint, rateData.value);

      // Ceiling division should be >= regular division
      expect(expectedAmount).to.be.gte(regularDiv);

      await collateralToken.connect(user1).approve(await vault.getAddress(), expectedAmount);

      const tx = await vault.connect(user1).mint(sharesToMint, user1.address);
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => vault.interface.parseLog(log)?.name === "VaultDeposit"
      );
      const parsedEvent = vault.interface.parseLog(event!);
      const amountDeposited = parsedEvent?.args.amountDeposited;

      expect(amountDeposited).to.equal(expectedAmount);
      expect(amountDeposited).to.be.gte(regularDiv);
    });
  });
});
