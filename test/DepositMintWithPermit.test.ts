import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { EmberVault, EmberProtocolConfig, ERC20Token } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmberVault - Deposit and Mint with Permit", function () {
  let vault: EmberVault;
  let protocolConfig: EmberProtocolConfig;
  let collateralToken: ERC20Token;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  const VAULT_NAME = "Test Vault";
  const COLLATERAL_TOKEN_NAME = "Test USD Coin";
  const COLLATERAL_TOKEN_SYMBOL = "TUSDC";
  const VAULT_SYMBOL = "EVLT";
  const INITIAL_SUPPLY = ethers.parseUnits("1000000", 6);
  const FEE_PERCENTAGE = ethers.parseUnits("0.05", 18);
  const MIN_WITHDRAWABLE_SHARES = ethers.parseUnits("0.01", 6);
  const RATE_UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in ms
  const MAX_RATE_CHANGE_PER_UPDATE = ethers.parseUnits("0.1", 18);
  const MAX_TVL = ethers.parseUnits("10000000", 6);

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, user1, user2] = await ethers.getSigners();

    // Deploy collateral token with permit support
    const collateralFactory = await ethers.getContractFactory("ERC20Token");
    collateralToken = (await upgrades.deployProxy(collateralFactory, [
      owner.address,
      COLLATERAL_TOKEN_NAME,
      COLLATERAL_TOKEN_SYMBOL,
      6,
      INITIAL_SUPPLY,
    ])) as ERC20Token;
    await collateralToken.waitForDeployment();

    // Deploy protocol config
    const EmberProtocolConfigFactory = await ethers.getContractFactory("EmberProtocolConfig");
    protocolConfig = (await upgrades.deployProxy(
      EmberProtocolConfigFactory,
      [owner.address, feeRecipient.address],
      { kind: "uups" }
    )) as EmberProtocolConfig;
    await protocolConfig.waitForDeployment();

    // Deploy vault
    const EmberVaultFactory = await ethers.getContractFactory("EmberVault");
    const initParams = {
      name: VAULT_NAME,
      collateralToken: await collateralToken.getAddress(),
      receiptTokenSymbol: VAULT_SYMBOL,
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
      EmberVaultFactory,
      [await protocolConfig.getAddress(), owner.address, initParams, []],
      { kind: "uups" }
    )) as EmberVault;
    await vault.waitForDeployment();

    // Mint tokens to users
    await collateralToken.connect(owner).mint(user1.address, ethers.parseUnits("100000", 6));
    await collateralToken.connect(owner).mint(user2.address, ethers.parseUnits("100000", 6));
  });

  describe("depositWithPermit", function () {
    describe("Success Cases", function () {
      it("should allow user to deposit using permit signature", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        // Get permit signature
        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: depositAmount,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        const userBalanceBefore = await collateralToken.balanceOf(user1.address);
        const vaultBalanceBefore = await collateralToken.balanceOf(await vault.getAddress());

        // Deposit with permit
        const tx = await vault
          .connect(user1)
          .depositWithPermit(depositAmount, user1.address, deadline, sig.v, sig.r, sig.s);
        await tx.wait();

        const userBalanceAfter = await collateralToken.balanceOf(user1.address);
        const vaultBalanceAfter = await collateralToken.balanceOf(await vault.getAddress());
        const userShares = await vault.balanceOf(user1.address);

        expect(userBalanceBefore - userBalanceAfter).to.equal(depositAmount);
        expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(depositAmount);
        expect(userShares).to.be.gt(0);
      });

      it("should emit VaultDeposit event", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: depositAmount,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .depositWithPermit(depositAmount, user1.address, deadline, sig.v, sig.r, sig.s)
        )
          .to.emit(vault, "VaultDeposit")
          .withArgs(
            await vault.getAddress(),
            user1.address,
            user1.address,
            depositAmount,
            (val: any) => val > 0, // shares
            (val: any) => val > 0, // totalShares
            (val: any) => val > 0, // timestamp
            (val: any) => val > 0 // sequence
          );
      });

      it("should allow deposit to different receiver", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: depositAmount,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await vault
          .connect(user1)
          .depositWithPermit(depositAmount, user2.address, deadline, sig.v, sig.r, sig.s);

        const user2Shares = await vault.balanceOf(user2.address);
        const user1Shares = await vault.balanceOf(user1.address);

        expect(user2Shares).to.be.gt(0);
        expect(user1Shares).to.equal(0);
      });

      it("should handle multiple deposits with permit from same user", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        // First deposit
        let nonce = await collateralToken.nonces(user1.address);
        let domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        let types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        let value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: depositAmount,
          nonce: nonce,
          deadline: deadline,
        };

        let signature = await user1.signTypedData(domain, types, value);
        let sig = ethers.Signature.from(signature);

        await vault
          .connect(user1)
          .depositWithPermit(depositAmount, user1.address, deadline, sig.v, sig.r, sig.s);

        const sharesAfterFirst = await vault.balanceOf(user1.address);

        // Second deposit
        nonce = await collateralToken.nonces(user1.address);
        value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: depositAmount,
          nonce: nonce,
          deadline: deadline,
        };

        signature = await user1.signTypedData(domain, types, value);
        sig = ethers.Signature.from(signature);

        await vault
          .connect(user1)
          .depositWithPermit(depositAmount, user1.address, deadline, sig.v, sig.r, sig.s);

        const sharesAfterSecond = await vault.balanceOf(user1.address);
        expect(sharesAfterSecond).to.be.gt(sharesAfterFirst);
      });
    });

    describe("Validation", function () {
      it("should reject expired permit", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);
        const deadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: depositAmount,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .depositWithPermit(depositAmount, user1.address, deadline, sig.v, sig.r, sig.s)
        ).to.be.reverted;
      });

      it("should reject invalid signature", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: depositAmount,
          nonce: nonce,
          deadline: deadline,
        };

        // User2 signs instead of user1
        const signature = await user2.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .depositWithPermit(depositAmount, user1.address, deadline, sig.v, sig.r, sig.s)
        ).to.be.reverted;
      });

      it("should reject zero amount deposit", async function () {
        const depositAmount = 0;
        const deadline = ethers.MaxUint256;

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: depositAmount,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .depositWithPermit(depositAmount, user1.address, deadline, sig.v, sig.r, sig.s)
        ).to.be.revertedWithCustomError(vault, "ZeroAmount");
      });

      it("should reject deposit when vault deposits are paused", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        // Pause deposits
        await protocolConfig
          .connect(admin)
          .setVaultPausedStatus(await vault.getAddress(), "deposits", true);

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: depositAmount,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .depositWithPermit(depositAmount, user1.address, deadline, sig.v, sig.r, sig.s)
        ).to.be.revertedWithCustomError(vault, "OperationPaused");
      });

      it("should reject deposit to blacklisted receiver", async function () {
        const depositAmount = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        // Blacklist user2
        await protocolConfig.connect(owner).setBlacklistedAccount(user2.address, true);

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: depositAmount,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .depositWithPermit(depositAmount, user2.address, deadline, sig.v, sig.r, sig.s)
        ).to.be.revertedWithCustomError(vault, "Blacklisted");
      });
    });
  });

  describe("mintWithPermit", function () {
    describe("Success Cases", function () {
      it("should allow user to mint shares using permit signature", async function () {
        const sharesToMint = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        // Calculate required assets
        const assetsRequired = await vault.previewMint(sharesToMint);

        // Get permit signature
        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: assetsRequired,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        const userBalanceBefore = await collateralToken.balanceOf(user1.address);
        const userSharesBefore = await vault.balanceOf(user1.address);

        // Mint with permit
        await vault
          .connect(user1)
          .mintWithPermit(sharesToMint, user1.address, deadline, sig.v, sig.r, sig.s);

        const userBalanceAfter = await collateralToken.balanceOf(user1.address);
        const userSharesAfter = await vault.balanceOf(user1.address);

        expect(userSharesAfter - userSharesBefore).to.equal(sharesToMint);
        expect(userBalanceBefore - userBalanceAfter).to.be.gte(assetsRequired);
      });

      it("should emit VaultDeposit event", async function () {
        const sharesToMint = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        const assetsRequired = await vault.previewMint(sharesToMint);

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: assetsRequired,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .mintWithPermit(sharesToMint, user1.address, deadline, sig.v, sig.r, sig.s)
        )
          .to.emit(vault, "VaultDeposit")
          .withArgs(
            await vault.getAddress(),
            user1.address,
            user1.address,
            (val: any) => val > 0, // assets
            sharesToMint,
            (val: any) => val > 0, // totalShares
            (val: any) => val > 0, // timestamp
            (val: any) => val > 0 // sequence
          );
      });

      it("should allow mint to different receiver", async function () {
        const sharesToMint = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        const assetsRequired = await vault.previewMint(sharesToMint);

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: assetsRequired,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await vault
          .connect(user1)
          .mintWithPermit(sharesToMint, user2.address, deadline, sig.v, sig.r, sig.s);

        const user2Shares = await vault.balanceOf(user2.address);
        const user1Shares = await vault.balanceOf(user1.address);

        expect(user2Shares).to.equal(sharesToMint);
        expect(user1Shares).to.equal(0);
      });

      it("should handle multiple mints with permit from same user", async function () {
        const sharesToMint = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        // First mint
        let assetsRequired = await vault.previewMint(sharesToMint);
        let nonce = await collateralToken.nonces(user1.address);
        let domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        let types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        let value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: assetsRequired,
          nonce: nonce,
          deadline: deadline,
        };

        let signature = await user1.signTypedData(domain, types, value);
        let sig = ethers.Signature.from(signature);

        await vault
          .connect(user1)
          .mintWithPermit(sharesToMint, user1.address, deadline, sig.v, sig.r, sig.s);

        const sharesAfterFirst = await vault.balanceOf(user1.address);

        // Second mint
        assetsRequired = await vault.previewMint(sharesToMint);
        nonce = await collateralToken.nonces(user1.address);
        value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: assetsRequired,
          nonce: nonce,
          deadline: deadline,
        };

        signature = await user1.signTypedData(domain, types, value);
        sig = ethers.Signature.from(signature);

        await vault
          .connect(user1)
          .mintWithPermit(sharesToMint, user1.address, deadline, sig.v, sig.r, sig.s);

        const sharesAfterSecond = await vault.balanceOf(user1.address);
        expect(sharesAfterSecond - sharesAfterFirst).to.equal(sharesToMint);
      });
    });

    describe("Validation", function () {
      it("should reject expired permit", async function () {
        const sharesToMint = ethers.parseUnits("1000", 6);
        const deadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

        const assetsRequired = await vault.previewMint(sharesToMint);

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: assetsRequired,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .mintWithPermit(sharesToMint, user1.address, deadline, sig.v, sig.r, sig.s)
        ).to.be.reverted;
      });

      it("should reject invalid signature", async function () {
        const sharesToMint = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        const assetsRequired = await vault.previewMint(sharesToMint);

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: assetsRequired,
          nonce: nonce,
          deadline: deadline,
        };

        // User2 signs instead of user1
        const signature = await user2.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .mintWithPermit(sharesToMint, user1.address, deadline, sig.v, sig.r, sig.s)
        ).to.be.reverted;
      });

      it("should reject zero shares mint", async function () {
        const sharesToMint = 0;
        const deadline = ethers.MaxUint256;

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: 0,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .mintWithPermit(sharesToMint, user1.address, deadline, sig.v, sig.r, sig.s)
        ).to.be.revertedWithCustomError(vault, "ZeroAmount");
      });

      it("should reject mint when vault deposits are paused", async function () {
        const sharesToMint = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        // Pause deposits
        await protocolConfig
          .connect(admin)
          .setVaultPausedStatus(await vault.getAddress(), "deposits", true);

        const assetsRequired = await vault.previewMint(sharesToMint);

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: assetsRequired,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .mintWithPermit(sharesToMint, user1.address, deadline, sig.v, sig.r, sig.s)
        ).to.be.revertedWithCustomError(vault, "OperationPaused");
      });

      it("should reject mint to blacklisted receiver", async function () {
        const sharesToMint = ethers.parseUnits("1000", 6);
        const deadline = ethers.MaxUint256;

        // Blacklist user2
        await protocolConfig.connect(owner).setBlacklistedAccount(user2.address, true);

        const assetsRequired = await vault.previewMint(sharesToMint);

        const nonce = await collateralToken.nonces(user1.address);
        const domain = {
          name: COLLATERAL_TOKEN_NAME,
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await collateralToken.getAddress(),
        };
        const types = {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        };
        const value = {
          owner: user1.address,
          spender: await vault.getAddress(),
          value: assetsRequired,
          nonce: nonce,
          deadline: deadline,
        };

        const signature = await user1.signTypedData(domain, types, value);
        const sig = ethers.Signature.from(signature);

        await expect(
          vault
            .connect(user1)
            .mintWithPermit(sharesToMint, user2.address, deadline, sig.v, sig.r, sig.s)
        ).to.be.revertedWithCustomError(vault, "Blacklisted");
      });
    });
  });

  describe("Gas Efficiency Comparison", function () {
    it("should compare gas usage: approve+deposit vs depositWithPermit", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);

      // Traditional approve + deposit
      await collateralToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      const tx1 = await vault.connect(user1).deposit(depositAmount, user1.address);
      const receipt1 = await tx1.wait();
      const gasUsedTraditional = receipt1!.gasUsed;

      // Deposit with permit
      const deadline = ethers.MaxUint256;
      const nonce = await collateralToken.nonces(user2.address);
      const domain = {
        name: COLLATERAL_TOKEN_NAME,
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await collateralToken.getAddress(),
      };
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const value = {
        owner: user2.address,
        spender: await vault.getAddress(),
        value: depositAmount,
        nonce: nonce,
        deadline: deadline,
      };

      const signature = await user2.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      const tx2 = await vault
        .connect(user2)
        .depositWithPermit(depositAmount, user2.address, deadline, sig.v, sig.r, sig.s);
      const receipt2 = await tx2.wait();
      const gasUsedPermit = receipt2!.gasUsed;

      console.log(`Gas used (approve + deposit): ${gasUsedTraditional}`);
      console.log(`Gas used (depositWithPermit): ${gasUsedPermit}`);

      // depositWithPermit should use less total gas (no separate approve tx)
      expect(gasUsedPermit).to.be.lt(gasUsedTraditional * 2n);
    });
  });
});
