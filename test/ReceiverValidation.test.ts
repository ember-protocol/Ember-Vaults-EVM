import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { EmberVault, EmberProtocolConfig, ERC20Token } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmberVault - Receiver Validation", function () {
  let vault: EmberVault;
  let protocolConfig: EmberProtocolConfig;
  let collateralToken: ERC20Token;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let subAccount1: HardhatEthersSigner;
  let subAccount2: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let blacklistedUser: HardhatEthersSigner;

  beforeEach(async function () {
    [
      owner,
      admin,
      operator,
      rateManager,
      feeRecipient,
      subAccount1,
      subAccount2,
      user1,
      user2,
      blacklistedUser,
    ] = await ethers.getSigners();

    // Deploy protocol config
    const protocolConfigFactory = await ethers.getContractFactory("EmberProtocolConfig");
    protocolConfig = (await upgrades.deployProxy(
      protocolConfigFactory,
      [owner.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as EmberProtocolConfig;

    // Deploy collateral token
    const tokenFactory = await ethers.getContractFactory("ERC20Token");
    collateralToken = (await upgrades.deployProxy(
      tokenFactory,
      [owner.address, "Test USDC", "USDC", 18, 0],
      { initializer: "initialize", kind: "uups" }
    )) as ERC20Token;

    // Deploy vault
    const vaultFactory = await ethers.getContractFactory("EmberVault");
    const initParams = {
      name: "Test Vault",
      receiptTokenSymbol: "tvUSDC",
      collateralToken: await collateralToken.getAddress(),
      admin: admin.address,
      operator: operator.address,
      rateManager: rateManager.address,
      maxRateChangePerUpdate: ethers.parseUnits("0.1", 18),
      feePercentage: ethers.parseUnits("0.01", 18),
      minWithdrawableShares: ethers.parseUnits("0.01", 18),
      rateUpdateInterval: 3600001,
      maxTVL: ethers.MaxUint256,
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

    // Mint tokens to users and approve vault
    const mintAmount = ethers.parseUnits("1000000", 18);
    await collateralToken.connect(owner).mint(user1.address, mintAmount);
    await collateralToken.connect(owner).mint(user2.address, mintAmount);
    await collateralToken.connect(owner).mint(blacklistedUser.address, mintAmount);

    await collateralToken.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
    await collateralToken.connect(user2).approve(await vault.getAddress(), ethers.MaxUint256);
    await collateralToken
      .connect(blacklistedUser)
      .approve(await vault.getAddress(), ethers.MaxUint256);

    // Blacklist one user
    await protocolConfig.connect(owner).setBlacklistedAccount(blacklistedUser.address, true);
  });

  describe("deposit() - Receiver Validation", function () {
    const depositAmount = ethers.parseUnits("1000", 18);

    it("should allow deposit to normal receiver", async function () {
      await vault.connect(user1).deposit(depositAmount, user2.address);
      expect(await vault.balanceOf(user2.address)).to.be.greaterThan(0);
    });

    it("should reject deposit to blacklisted receiver", async function () {
      await expect(
        vault.connect(user1).deposit(depositAmount, blacklistedUser.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");
    });

    it("should reject deposit to sub-account receiver", async function () {
      await expect(
        vault.connect(user1).deposit(depositAmount, subAccount1.address)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");
    });

    it("should reject deposit from blacklisted depositor even with valid receiver", async function () {
      await expect(
        vault.connect(blacklistedUser).deposit(depositAmount, user2.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");
    });

    it("should reject deposit when both depositor and receiver are blacklisted", async function () {
      await expect(
        vault.connect(blacklistedUser).deposit(depositAmount, blacklistedUser.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");
    });

    it("should allow deposit when receiver is unblacklisted", async function () {
      // First verify it's blocked
      await expect(
        vault.connect(user1).deposit(depositAmount, blacklistedUser.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Unblacklist
      await protocolConfig.connect(owner).setBlacklistedAccount(blacklistedUser.address, false);

      // Now should work
      await vault.connect(user1).deposit(depositAmount, blacklistedUser.address);
      expect(await vault.balanceOf(blacklistedUser.address)).to.be.greaterThan(0);
    });

    it("should allow depositor to deposit to themselves", async function () {
      await vault.connect(user1).deposit(depositAmount, user1.address);
      expect(await vault.balanceOf(user1.address)).to.be.greaterThan(0);
    });
  });

  describe("mint() - Receiver Validation", function () {
    const sharesToMint = ethers.parseUnits("1000", 18);

    it("should allow mint to normal receiver", async function () {
      await vault.connect(user1).mint(sharesToMint, user2.address);
      expect(await vault.balanceOf(user2.address)).to.equal(sharesToMint);
    });

    it("should reject mint to blacklisted receiver", async function () {
      await expect(
        vault.connect(user1).mint(sharesToMint, blacklistedUser.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");
    });

    it("should reject mint to sub-account receiver", async function () {
      await expect(
        vault.connect(user1).mint(sharesToMint, subAccount1.address)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");
    });

    it("should reject mint from blacklisted depositor even with valid receiver", async function () {
      await expect(
        vault.connect(blacklistedUser).mint(sharesToMint, user2.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");
    });

    it("should reject mint when both depositor and receiver are blacklisted", async function () {
      await expect(
        vault.connect(blacklistedUser).mint(sharesToMint, blacklistedUser.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");
    });

    it("should allow mint when receiver is unblacklisted", async function () {
      // First verify it's blocked
      await expect(
        vault.connect(user1).mint(sharesToMint, blacklistedUser.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Unblacklist
      await protocolConfig.connect(owner).setBlacklistedAccount(blacklistedUser.address, false);

      // Now should work
      await vault.connect(user1).mint(sharesToMint, blacklistedUser.address);
      expect(await vault.balanceOf(blacklistedUser.address)).to.equal(sharesToMint);
    });

    it("should allow depositor to mint to themselves", async function () {
      await vault.connect(user1).mint(sharesToMint, user1.address);
      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
    });
  });

  describe("Security - Preventing Bypass Attacks", function () {
    const depositAmount = ethers.parseUnits("1000", 18);
    const sharesToMint = ethers.parseUnits("1000", 18);

    it("should prevent blacklisted user from getting shares via deposit proxy", async function () {
      // Blacklisted user tries to get shares by having someone else deposit to them
      await expect(
        vault.connect(user1).deposit(depositAmount, blacklistedUser.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Verify blacklisted user has no shares
      expect(await vault.balanceOf(blacklistedUser.address)).to.equal(0);
    });

    it("should prevent blacklisted user from getting shares via mint proxy", async function () {
      // Blacklisted user tries to get shares by having someone else mint to them
      await expect(
        vault.connect(user1).mint(sharesToMint, blacklistedUser.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Verify blacklisted user has no shares
      expect(await vault.balanceOf(blacklistedUser.address)).to.equal(0);
    });

    it("should prevent sub-account from receiving shares via deposit", async function () {
      // Try to deposit to sub-account
      await expect(
        vault.connect(user1).deposit(depositAmount, subAccount1.address)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");

      // Verify sub-account has no shares
      expect(await vault.balanceOf(subAccount1.address)).to.equal(0);
    });

    it("should prevent sub-account from receiving shares via mint", async function () {
      // Try to mint to sub-account
      await expect(
        vault.connect(user1).mint(sharesToMint, subAccount1.address)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");

      // Verify sub-account has no shares
      expect(await vault.balanceOf(subAccount1.address)).to.equal(0);
    });

    it("should enforce receiver validation even when depositor is valid", async function () {
      // Valid depositor (user1) tries to deposit to blacklisted receiver
      await expect(
        vault.connect(user1).deposit(depositAmount, blacklistedUser.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");

      // Valid depositor (user1) tries to deposit to sub-account
      await expect(
        vault.connect(user1).deposit(depositAmount, subAccount2.address)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");
    });
  });

  describe("Edge Cases", function () {
    it("should handle receiver validation with zero address (ERC20 will revert)", async function () {
      const depositAmount = ethers.parseUnits("1000", 18);

      // The zero address check happens in ERC20's _mint function
      // OpenZeppelin's ERC20 reverts with "ERC20: mint to the zero address"
      await expect(vault.connect(user1).deposit(depositAmount, ethers.ZeroAddress)).to.be.reverted;
    });

    it("should validate receiver on every deposit/mint call", async function () {
      const depositAmount = ethers.parseUnits("1000", 18);

      // First deposit to valid receiver works
      await vault.connect(user1).deposit(depositAmount, user2.address);
      expect(await vault.balanceOf(user2.address)).to.be.greaterThan(0);

      // Blacklist user2
      await protocolConfig.connect(owner).setBlacklistedAccount(user2.address, true);

      // Second deposit to now-blacklisted receiver fails
      await expect(
        vault.connect(user1).deposit(depositAmount, user2.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");
    });
  });
});
