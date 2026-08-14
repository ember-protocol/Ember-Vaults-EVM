import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  AtomicLiquidity,
  EmberProtocolConfig,
  ERC20Token,
  MockERC4626,
} from "../typechain-types";
import { deployBaseSetup, deployMockStrategy } from "./helpers/atomicLiquidity";

describe("AtomicLiquidity - Strategy Integration", function () {
  let vault: AtomicLiquidity;
  let protocolConfig: EmberProtocolConfig;
  let collateralToken: ERC20Token;
  let strategy: MockERC4626;
  let configSigner: HardhatEthersSigner;

  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;

  const DEPOSIT = ethers.parseUnits("1000", 18);

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, user1, outsider, guardian] =
      await ethers.getSigners();

    ({ vault, protocolConfig, collateralToken, configSigner } = await deployBaseSetup({
      owner,
      feeRecipient,
      admin,
      operator,
      rateManager,
      fundUsers: [user1],
    }));

    // Pause authority is guardian-only, routed via EmberProtocolConfig.
    await protocolConfig.connect(owner).setGuardian(guardian.address);

    strategy = await deployMockStrategy(collateralToken);

    // Seed vault with a deposit so supplyToStrategy has something to move.
    await vault.connect(user1).deposit(DEPOSIT, user1.address);
  });

  describe("setStrategy", function () {
    it("reverts when caller is not the protocol config", async function () {
      await expect(
        vault.connect(admin).setStrategy(admin.address, await strategy.getAddress())
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("reverts when the dispatched caller is not admin", async function () {
      await expect(
        vault.connect(configSigner).setStrategy(operator.address, await strategy.getAddress())
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("reverts when the strategy's asset() does not match collateralToken", async function () {
      // Deploy a strategy that wraps a different token.
      const otherToken = await deployBaseSetup({
        owner,
        feeRecipient,
        admin,
        operator,
        rateManager,
      });
      const wrongStrat = await deployMockStrategy(otherToken.collateralToken);

      await expect(
        vault.connect(configSigner).setStrategy(admin.address, await wrongStrat.getAddress())
      ).to.be.revertedWithCustomError(vault, "InvalidStrategy");
    });

    it("reverts on SameValue when set to the current strategy", async function () {
      await vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress());

      await expect(
        vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress())
      ).to.be.revertedWithCustomError(vault, "SameValue");
    });

    it("sets the strategy and emits StrategyUpdated", async function () {
      await expect(
        vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress())
      )
        .to.emit(vault, "StrategyUpdated")
        .withArgs(
          await vault.getAddress(),
          ethers.ZeroAddress,
          await strategy.getAddress(),
          (val: bigint) => val > 0n,
          (val: bigint) => val > 0n
        );
      expect(await vault.strategy()).to.equal(await strategy.getAddress());
    });

    it("can clear the strategy by setting address(0)", async function () {
      await vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress());
      await vault.connect(configSigner).setStrategy(admin.address, ethers.ZeroAddress);
      expect(await vault.strategy()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("supplyToStrategy", function () {
    beforeEach(async function () {
      await vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress());
    });

    it("reverts when caller is not operator", async function () {
      await expect(vault.connect(outsider).supplyToStrategy(DEPOSIT)).to.be.revertedWithCustomError(
        vault,
        "Unauthorized"
      );
    });

    it("reverts on ZeroAmount", async function () {
      await expect(vault.connect(operator).supplyToStrategy(0)).to.be.revertedWithCustomError(
        vault,
        "ZeroAmount"
      );
    });

    it("reverts when no strategy is set", async function () {
      await vault.connect(configSigner).setStrategy(admin.address, ethers.ZeroAddress);
      await expect(vault.connect(operator).supplyToStrategy(DEPOSIT)).to.be.revertedWithCustomError(
        vault,
        "StrategyNotSet"
      );
    });

    it("reverts when vault balance is insufficient", async function () {
      const tooMuch = (await collateralToken.balanceOf(await vault.getAddress())) + 1n;
      await expect(vault.connect(operator).supplyToStrategy(tooMuch)).to.be.revertedWithCustomError(
        vault,
        "InsufficientBalance"
      );
    });

    it("reverts when privileged operations are paused", async function () {
      await protocolConfig
        .connect(guardian)
        .setVaultPausedStatus(await vault.getAddress(), "privilegedOperations", true);
      await expect(vault.connect(operator).supplyToStrategy(DEPOSIT)).to.be.revertedWithCustomError(
        vault,
        "OperationPaused"
      );
    });

    it("deposits collateral into the strategy and emits StrategySupplied", async function () {
      const before = await collateralToken.balanceOf(await vault.getAddress());

      await expect(vault.connect(operator).supplyToStrategy(DEPOSIT)).to.emit(
        vault,
        "StrategySupplied"
      );

      const after = await collateralToken.balanceOf(await vault.getAddress());
      expect(before - after).to.equal(DEPOSIT);

      // Strategy now holds the collateral; vault holds strategy shares.
      expect(await collateralToken.balanceOf(await strategy.getAddress())).to.equal(DEPOSIT);
      expect(await strategy.balanceOf(await vault.getAddress())).to.be.greaterThan(0n);

      // getStrategyAssets reflects the supplied amount (no yield yet).
      expect(await vault.getStrategyAssets()).to.equal(DEPOSIT);
    });
  });

  describe("withdrawFromStrategy", function () {
    beforeEach(async function () {
      await vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress());
      await vault.connect(operator).supplyToStrategy(DEPOSIT);
    });

    it("reverts when caller is not operator", async function () {
      await expect(
        vault.connect(outsider).withdrawFromStrategy(DEPOSIT)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("reverts on ZeroAmount", async function () {
      await expect(vault.connect(operator).withdrawFromStrategy(0)).to.be.revertedWithCustomError(
        vault,
        "ZeroAmount"
      );
    });

    it("reverts when no strategy is set", async function () {
      // Drain first, then unset.
      await vault.connect(operator).withdrawFromStrategy(DEPOSIT);
      await vault.connect(configSigner).setStrategy(admin.address, ethers.ZeroAddress);
      await expect(vault.connect(operator).withdrawFromStrategy(1n)).to.be.revertedWithCustomError(
        vault,
        "StrategyNotSet"
      );
    });

    it("returns collateral to the vault and emits StrategyWithdrawn", async function () {
      const before = await collateralToken.balanceOf(await vault.getAddress());

      await expect(vault.connect(operator).withdrawFromStrategy(DEPOSIT / 2n)).to.emit(
        vault,
        "StrategyWithdrawn"
      );

      const after = await collateralToken.balanceOf(await vault.getAddress());
      expect(after - before).to.equal(DEPOSIT / 2n);
      expect(await vault.getStrategyAssets()).to.equal(DEPOSIT - DEPOSIT / 2n);
    });
  });

  describe("getStrategyAssets", function () {
    it("returns 0 when no strategy is configured", async function () {
      expect(await vault.getStrategyAssets()).to.equal(0n);
    });

    it("reflects yield earned by direct collateral transfers to the strategy", async function () {
      await vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress());
      await vault.connect(operator).supplyToStrategy(DEPOSIT);

      // Donate yield to the strategy: per-share value of strategy goes up, so vault's
      // claim grows even though the vault didn't supply more.
      const yieldAmount = ethers.parseUnits("100", 18);
      await collateralToken.connect(owner).transfer(await strategy.getAddress(), yieldAmount);

      // OZ ERC4626 has a 1-wei virtual offset on convertToAssets, so allow ±1.
      expect(await vault.getStrategyAssets()).to.be.closeTo(DEPOSIT + yieldAmount, 1n);
    });
  });
});
