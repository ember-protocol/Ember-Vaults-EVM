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

describe("AtomicLiquidity - Instant Withdraw", function () {
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
  let user2: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;

  // The default rate is 1e18, so shares == assets at the unit level.
  const DEPOSIT = ethers.parseUnits("1000", 18);
  const ONE = ethers.parseUnits("1", 18);

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, user1, user2, guardian] =
      await ethers.getSigners();

    ({ vault, protocolConfig, collateralToken, configSigner } = await deployBaseSetup({
      owner,
      feeRecipient,
      admin,
      operator,
      rateManager,
      fundUsers: [user1, user2],
    }));

    // Pause authority is guardian-only, routed via EmberProtocolConfig.
    await protocolConfig.connect(owner).setGuardian(guardian.address);

    strategy = await deployMockStrategy(collateralToken);
    await vault.connect(user1).deposit(DEPOSIT, user1.address);
  });

  describe("setMaxInstantWithdrawShares", function () {
    it("starts at zero — feature is disabled by default", async function () {
      expect(await vault.maxInstantWithdrawShares()).to.equal(0n);
      expect(await vault.cumulativeInstantWithdrawShares()).to.equal(0n);
      expect(await vault.availableInstantWithdrawShares()).to.equal(0n);
    });

    it("only callable by protocol-config, caller must be admin", async function () {
      await expect(
        vault.connect(admin).setMaxInstantWithdrawShares(admin.address, 1n)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");

      await expect(
        vault.connect(configSigner).setMaxInstantWithdrawShares(operator.address, 1n)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("rejects same-value updates", async function () {
      const target = ethers.parseUnits("123", 18);
      await vault.connect(configSigner).setMaxInstantWithdrawShares(admin.address, target);
      // Attempt to set to current value.
      await expect(
        vault.connect(configSigner).setMaxInstantWithdrawShares(admin.address, target)
      ).to.be.revertedWithCustomError(vault, "SameValue");
    });

    it("emits InstantWithdrawLimitUpdated and updates state", async function () {
      const target = ethers.parseUnits("1000000", 18);
      await expect(vault.connect(configSigner).setMaxInstantWithdrawShares(admin.address, target))
        .to.emit(vault, "InstantWithdrawLimitUpdated")
        .withArgs(
          await vault.getAddress(),
          0n,
          target,
          0n,
          (val: bigint) => val > 0n,
          (val: bigint) => val > 0n
        );
      expect(await vault.maxInstantWithdrawShares()).to.equal(target);
      expect(await vault.availableInstantWithdrawShares()).to.equal(target);
    });
  });

  describe("setInstantWithdrawFeePercentage", function () {
    it("rejects fee > 100% (1e18)", async function () {
      await expect(
        vault
          .connect(configSigner)
          .setInstantWithdrawFeePercentage(admin.address, ethers.parseUnits("1.01", 18))
      ).to.be.revertedWithCustomError(vault, "InstantWithdrawFeeTooHigh");
    });

    it("emits InstantWithdrawFeeUpdated and updates state", async function () {
      const fee = ethers.parseUnits("0.02", 18);
      await expect(
        vault.connect(configSigner).setInstantWithdrawFeePercentage(admin.address, fee)
      ).to.emit(vault, "InstantWithdrawFeeUpdated");
      expect(await vault.instantWithdrawFeePercentage()).to.equal(fee);
    });
  });

  describe("instantWithdraw - validation", function () {
    it("reverts InstantWithdrawCapExceeded when feature is disabled (max = 0)", async function () {
      await expect(
        vault.connect(user1).instantWithdraw(ONE, user1.address)
      ).to.be.revertedWithCustomError(vault, "InstantWithdrawCapExceeded");
    });

    it("reverts on shares < minWithdrawableShares", async function () {
      await vault
        .connect(configSigner)
        .setMaxInstantWithdrawShares(admin.address, ethers.parseUnits("100", 18));

      const tooSmall = (await vault.minWithdrawableShares()) - 1n;
      await expect(
        vault.connect(user1).instantWithdraw(tooSmall, user1.address)
      ).to.be.revertedWithCustomError(vault, "InsufficientShares");
    });

    it("reverts when user does not own enough shares", async function () {
      await vault
        .connect(configSigner)
        .setMaxInstantWithdrawShares(admin.address, ethers.parseUnits("999999", 18));
      await expect(
        vault.connect(user2).instantWithdraw(ONE, user2.address) // user2 hasn't deposited
      ).to.be.revertedWithCustomError(vault, "InsufficientShares");
    });

    it("reverts when withdrawals are paused", async function () {
      await vault
        .connect(configSigner)
        .setMaxInstantWithdrawShares(admin.address, ethers.parseUnits("999999", 18));
      await protocolConfig
        .connect(guardian)
        .setVaultPausedStatus(await vault.getAddress(), "withdrawals", true);
      await expect(
        vault.connect(user1).instantWithdraw(ONE, user1.address)
      ).to.be.revertedWithCustomError(vault, "OperationPaused");
    });

    it("reverts when receiver is blacklisted", async function () {
      await vault
        .connect(configSigner)
        .setMaxInstantWithdrawShares(admin.address, ethers.parseUnits("999999", 18));
      await protocolConfig.connect(owner).setBlacklistedAccount(user2.address, true);
      await expect(
        vault.connect(user1).instantWithdraw(ONE, user2.address)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");
    });

    it("reverts when receiver is the zero address", async function () {
      await vault
        .connect(configSigner)
        .setMaxInstantWithdrawShares(admin.address, ethers.parseUnits("999999", 18));
      await expect(
        vault.connect(user1).instantWithdraw(ONE, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("redeemShares reverts when receiver is the zero address", async function () {
      // A zero-receiver request would freeze the FIFO withdrawal queue at processing time.
      await expect(
        vault.connect(user1).redeemShares(ONE, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });
  });

  describe("instantWithdraw - flow", function () {
    const FEE_PCT = ethers.parseUnits("0.02", 18); // 2%
    const MAX = ethers.parseUnits("500", 18);

    beforeEach(async function () {
      await vault.connect(configSigner).setMaxInstantWithdrawShares(admin.address, MAX);
      await vault.connect(configSigner).setInstantWithdrawFeePercentage(admin.address, FEE_PCT);
    });

    it("burns shares immediately and pays user gross - fee", async function () {
      const sharesToBurn = ethers.parseUnits("100", 18);
      const sharesBefore = await vault.shareOf(user1.address);
      const totalSharesBefore = await vault.totalShares();
      const userBalBefore = await collateralToken.balanceOf(user1.address);

      // gross = convertToAssets(shares); rate is 1e18 so gross == shares numerically
      const gross = await vault.convertToAssets(sharesToBurn);
      const expectedFee = (gross * FEE_PCT) / ONE;
      const expectedNet = gross - expectedFee;

      await expect(vault.connect(user1).instantWithdraw(sharesToBurn, user1.address)).to.emit(
        vault,
        "InstantWithdrawn"
      );

      expect(await vault.shareOf(user1.address)).to.equal(sharesBefore - sharesToBurn);
      expect(await vault.totalShares()).to.equal(totalSharesBefore - sharesToBurn);
      expect(await vault.cumulativeInstantWithdrawShares()).to.equal(sharesToBurn);
      expect((await collateralToken.balanceOf(user1.address)) - userBalBefore).to.equal(
        expectedNet
      );
    });

    it("accrues the fee into platformFee.accrued", async function () {
      const sharesToBurn = ethers.parseUnits("100", 18);
      const before = (await vault.platformFee()).accrued;

      await vault.connect(user1).instantWithdraw(sharesToBurn, user1.address);

      const gross = await vault.convertToAssets(sharesToBurn);
      const expectedFee = (gross * FEE_PCT) / ONE;
      const accruedAfter = (await vault.platformFee()).accrued;
      // accrual may include time-based fee from elapsed seconds; assert at least the
      // instant-withdraw fee was added.
      expect(accruedAfter - before).to.be.greaterThanOrEqual(expectedFee);
    });

    it("reverts when cumulative + new shares > max", async function () {
      // Burn the whole cap first.
      await vault.connect(user1).instantWithdraw(MAX, user1.address);
      expect(await vault.cumulativeInstantWithdrawShares()).to.equal(MAX);

      // Any further burn should revert.
      await expect(
        vault.connect(user1).instantWithdraw(ONE, user1.address)
      ).to.be.revertedWithCustomError(vault, "InstantWithdrawCapExceeded");
    });

    it("admin raising max grants new headroom", async function () {
      await vault.connect(user1).instantWithdraw(MAX, user1.address);
      const newMax = MAX + ethers.parseUnits("100", 18);
      await vault.connect(configSigner).setMaxInstantWithdrawShares(admin.address, newMax);
      // New available headroom is exactly newMax - cumulative.
      expect(await vault.availableInstantWithdrawShares()).to.equal(
        newMax - (await vault.cumulativeInstantWithdrawShares())
      );

      await expect(vault.connect(user1).instantWithdraw(ethers.parseUnits("50", 18), user1.address))
        .to.not.be.reverted;
    });

    it("auto-pulls from strategy when vault balance is short", async function () {
      // Move most of the vault balance into the strategy.
      await vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress());
      const totalCollat = await collateralToken.balanceOf(await vault.getAddress());
      // Leave only 10 USDC liquid.
      const leaveLiquid = ethers.parseUnits("10", 18);
      await vault.connect(operator).supplyToStrategy(totalCollat - leaveLiquid);

      const sharesToBurn = ethers.parseUnits("200", 18); // gross 200 > 10 liquid
      const userBalBefore = await collateralToken.balanceOf(user1.address);

      await expect(vault.connect(user1).instantWithdraw(sharesToBurn, user1.address)).to.emit(
        vault,
        "InstantWithdrawn"
      );

      // User received the net payout — the deficit was pulled from the strategy mid-flow.
      const userBalAfter = await collateralToken.balanceOf(user1.address);
      expect(userBalAfter - userBalBefore).to.be.greaterThan(0n);
    });

    it("reverts InsufficientBalance when vault is short and no strategy is set", async function () {
      // Drain all vault liquid balance to the operator's sub-account flow surrogate by
      // sending it to a sub-account... actually simpler: just send out via direct transfer
      // by impersonating the vault. To keep things in-bound we instead set up the vault
      // such that supplyToSubAccount drains it, but we don't have a sub-account whitelisted.
      // Instead, we set up a rate that makes gross bigger than vault balance.
      //
      // Simpler approach: deposit a huge amount, lower the rate so 1 share converts to a
      // huge number of assets. But rate-update interval gates that. Easier still: just
      // burn shares > vault balance / rate is impossible at rate=1e18 with 1000 deposited.
      //
      // Trick: make the user's effective shares larger than vault balance by swapping to a
      // strategy and clearing it. We use the configured strategy then unset and observe.
      await vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress());
      const totalCollat = await collateralToken.balanceOf(await vault.getAddress());
      await vault.connect(operator).supplyToStrategy(totalCollat);

      // Now vault has 0 liquid balance. Unset strategy to disable auto-pull.
      // We need to drain strategy first because setStrategy(0) doesn't migrate.
      // Trade-off: keep strategy set but make it unable to fulfill — easier to just
      // assert the auto-pull works (covered above) and assert strategy-not-set path
      // separately by constructing a minimal scenario:
      const sharesToBurn = ethers.parseUnits("50", 18);

      // Drain strategy to get vault back to having 0 in strategy AND 0 liquid.
      await vault.connect(operator).withdrawFromStrategy(totalCollat);
      // Now vault has full balance again.
      // Send everything out via collectPlatformFee? That requires accrued. Alternate:
      // operator transfers via an admin-whitelisted sub-account.
      // Whitelist user2 as a sub-account and drain to them.
      await protocolConfig
        .connect(admin)
        .setVaultSubAccount(await vault.getAddress(), user2.address, true);
      await vault
        .connect(operator)
        .supplyToSubAccount(
          user2.address,
          await collateralToken.balanceOf(await vault.getAddress())
        );

      // Vault is now liquid-empty; strategy is also empty; clear strategy so auto-pull fails.
      await vault.connect(configSigner).setStrategy(admin.address, ethers.ZeroAddress);

      await expect(
        vault.connect(user1).instantWithdraw(sharesToBurn, user1.address)
      ).to.be.revertedWithCustomError(vault, "InsufficientBalance");
    });
  });

  describe("availableInstantWithdrawShares", function () {
    it("clamps at zero when cumulative >= max", async function () {
      const max = ethers.parseUnits("100", 18);
      await vault.connect(configSigner).setMaxInstantWithdrawShares(admin.address, max);
      await vault.connect(user1).instantWithdraw(max, user1.address);
      expect(await vault.availableInstantWithdrawShares()).to.equal(0n);

      // Lowering max below cumulative also clamps to zero.
      await vault.connect(configSigner).setMaxInstantWithdrawShares(admin.address, max - 1n);
      expect(await vault.availableInstantWithdrawShares()).to.equal(0n);
    });
  });
});
