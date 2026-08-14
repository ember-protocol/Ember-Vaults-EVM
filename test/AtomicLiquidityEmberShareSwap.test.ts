import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  AtomicLiquidity,
  EmberProtocolConfig,
  EmberVault,
  ERC20Token,
  MockERC4626,
} from "../typechain-types";
import { deployBaseSetup, deployEmberVault, deployMockStrategy } from "./helpers/atomicLiquidity";

describe("AtomicLiquidity - EmberShare Cross-Vault Swap", function () {
  let vault: AtomicLiquidity;
  let protocolConfig: EmberProtocolConfig;
  let collateralToken: ERC20Token;
  let strategy: MockERC4626;
  let emberVault: EmberVault;
  let configSigner: HardhatEthersSigner;

  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;

  const ONE = ethers.parseUnits("1", 18);
  const FEE_PCT = ethers.parseUnits("0.01", 18); // 1%
  const HOLDBACK_PCT = ethers.parseUnits("0.05", 18); // 5%
  const MAX_CAP_PCT = ethers.parseUnits("0.2", 18); // 20% of EmberVault TVL per epoch

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, alice, bob, carol, guardian] =
      await ethers.getSigners();

    ({ vault, protocolConfig, collateralToken, configSigner } = await deployBaseSetup({
      owner,
      feeRecipient,
      admin,
      operator,
      rateManager,
      fundUsers: [alice, bob, carol],
    }));

    // Guardian holds the emergency-pause authority routed through
    // EmberProtocolConfig.setVaultPausedStatus (onlyGuardian).
    await protocolConfig.connect(owner).setGuardian(guardian.address);

    strategy = await deployMockStrategy(collateralToken);

    emberVault = await deployEmberVault({
      owner,
      protocolConfig,
      collateralToken,
      admin,
      operator,
      rateManager,
    });

    // Pre-approve EmberVault for users so they can deposit collateral and get EmberShares.
    const userBalance = ethers.parseUnits("100000", 18);
    for (const u of [alice, bob, carol]) {
      await collateralToken.connect(u).approve(await emberVault.getAddress(), userBalance);
    }

    // Each user deposits into EmberVault to receive EmberShares.
    await emberVault.connect(alice).deposit(ethers.parseUnits("10000", 18), alice.address);
    await emberVault.connect(bob).deposit(ethers.parseUnits("10000", 18), bob.address);
    await emberVault.connect(carol).deposit(ethers.parseUnits("10000", 18), carol.address);

    // Seed the AtomicLiquidity vault with collateral so it has liquidity to front payouts.
    // alice also deposits some collateral into AL for liquidity (this is a separate flow).
    await vault.connect(alice).deposit(ethers.parseUnits("50000", 18), alice.address);

    // Users approve AL to pull their EmberShares.
    for (const u of [alice, bob, carol]) {
      await emberVault
        .connect(u)
        .approve(await vault.getAddress(), ethers.parseUnits("100000", 18));
    }
  });

  // 100% by default — most pre-existing tests don't exercise the concentration cap and
  // shouldn't be gated by it. The fee-multiplier curve is empty by default (1× scaling).
  const MAX_UTIL_PCT_DEFAULT = ethers.parseUnits("1", 18);

  async function whitelistShare(opts?: {
    feePct?: bigint;
    holdbackPct?: bigint;
    maxCapPct?: bigint;
    maxUtilPct?: bigint;
    minSwapGross?: bigint;
    maxHeldValueAbsolute?: bigint;
  }) {
    const fee = opts?.feePct ?? FEE_PCT;
    const holdback = opts?.holdbackPct ?? HOLDBACK_PCT;
    const cap = opts?.maxCapPct ?? MAX_CAP_PCT;
    const maxUtil = opts?.maxUtilPct ?? MAX_UTIL_PCT_DEFAULT;
    const minSwapGross = opts?.minSwapGross ?? 0n;
    const maxHeldValueAbsolute = opts?.maxHeldValueAbsolute ?? 0n;
    return vault
      .connect(configSigner)
      .setEmberShareWhitelist(
        admin.address,
        await emberVault.getAddress(),
        true,
        fee,
        cap,
        holdback,
        maxUtil,
        minSwapGross,
        maxHeldValueAbsolute
      );
  }

  describe("setEmberShareWhitelist", function () {
    it("only callable by protocol-config, caller must be admin", async function () {
      await expect(
        vault
          .connect(admin)
          .setEmberShareWhitelist(
            admin.address,
            await emberVault.getAddress(),
            true,
            0,
            0,
            0,
            0,
            0,
            0
          )
      ).to.be.revertedWithCustomError(vault, "Unauthorized");

      await expect(
        vault
          .connect(configSigner)
          .setEmberShareWhitelist(
            operator.address,
            await emberVault.getAddress(),
            true,
            0,
            0,
            0,
            0,
            0,
            0
          )
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("rejects zero share address", async function () {
      await expect(
        vault
          .connect(configSigner)
          .setEmberShareWhitelist(admin.address, ethers.ZeroAddress, true, 0, 0, 0, 0, 0, 0)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("rejects any percentage > 1e18", async function () {
      const badPct = ethers.parseUnits("1.01", 18);
      await expect(
        vault
          .connect(configSigner)
          .setEmberShareWhitelist(
            admin.address,
            await emberVault.getAddress(),
            true,
            badPct,
            0,
            0,
            0,
            0,
            0
          )
      ).to.be.revertedWithCustomError(vault, "InvalidPercentage");

      await expect(
        vault
          .connect(configSigner)
          .setEmberShareWhitelist(
            admin.address,
            await emberVault.getAddress(),
            true,
            0,
            badPct,
            0,
            0,
            0,
            0
          )
      ).to.be.revertedWithCustomError(vault, "InvalidPercentage");

      await expect(
        vault
          .connect(configSigner)
          .setEmberShareWhitelist(
            admin.address,
            await emberVault.getAddress(),
            true,
            0,
            0,
            badPct,
            0,
            0,
            0
          )
      ).to.be.revertedWithCustomError(vault, "InvalidPercentage");

      // New: maxUtilizationPercentage also clamps to 1e18.
      await expect(
        vault
          .connect(configSigner)
          .setEmberShareWhitelist(
            admin.address,
            await emberVault.getAddress(),
            true,
            0,
            0,
            0,
            badPct,
            0,
            0
          )
      ).to.be.revertedWithCustomError(vault, "InvalidPercentage");
    });

    it("rejects fee + holdback > 1e18", async function () {
      const fee = ethers.parseUnits("0.6", 18);
      const holdback = ethers.parseUnits("0.5", 18);
      await expect(
        vault
          .connect(configSigner)
          .setEmberShareWhitelist(
            admin.address,
            await emberVault.getAddress(),
            true,
            fee,
            MAX_CAP_PCT,
            holdback,
            MAX_UTIL_PCT_DEFAULT,
            0,
            0
          )
      ).to.be.revertedWithCustomError(vault, "InvalidPercentage");
    });

    it("emits EmberShareWhitelistUpdated and stores config", async function () {
      await expect(whitelistShare({ minSwapGross: 12345n, maxHeldValueAbsolute: 67890n })).to.emit(
        vault,
        "EmberShareWhitelistUpdated"
      );

      const cfg = await vault.emberShareConfigs(await emberVault.getAddress());
      expect(cfg.whitelisted).to.equal(true);
      expect(cfg.feePercentage).to.equal(FEE_PCT);
      expect(cfg.maxCapacityPercentage).to.equal(MAX_CAP_PCT);
      expect(cfg.holdbackPercentage).to.equal(HOLDBACK_PCT);
      expect(cfg.minSwapGross).to.equal(12345n);
      expect(cfg.maxHeldValueAbsolute).to.equal(67890n);
    });

    it("de-listing keeps epoch state intact", async function () {
      await whitelistShare();
      // Generate some epoch state by swapping.
      await vault
        .connect(alice)
        .swapEmberShares(
          await emberVault.getAddress(),
          ethers.parseUnits("100", 18),
          alice.address,
          0n
        );
      const before = await vault.emberShareConfigs(await emberVault.getAddress());

      // De-list.
      await vault
        .connect(configSigner)
        .setEmberShareWhitelist(
          admin.address,
          await emberVault.getAddress(),
          false,
          0,
          0,
          0,
          0,
          0,
          0
        );

      const after = await vault.emberShareConfigs(await emberVault.getAddress());
      expect(after.whitelisted).to.equal(false);
      // Epoch fields preserved.
      expect(after.epochStartedAt).to.equal(before.epochStartedAt);
      expect(after.epochUsedAmount).to.equal(before.epochUsedAmount);
    });
  });

  describe("swapEmberShares - validation", function () {
    it("reverts when share is not whitelisted", async function () {
      await expect(
        vault.connect(alice).swapEmberShares(await emberVault.getAddress(), ONE, alice.address, 0n)
      ).to.be.revertedWithCustomError(vault, "EmberShareNotWhitelisted");
    });

    it("reverts when withdrawals are paused on AL", async function () {
      await whitelistShare();
      await protocolConfig
        .connect(guardian)
        .setVaultPausedStatus(await vault.getAddress(), "withdrawals", true);
      await expect(
        vault.connect(alice).swapEmberShares(await emberVault.getAddress(), ONE, alice.address, 0n)
      ).to.be.revertedWithCustomError(vault, "OperationPaused");
    });

    // fix 1: AL pause authority is guardian-only (routed via EmberProtocolConfig).
    it("only the guardian can pause AL — admin/operator are rejected at the protocol-config", async function () {
      const share = await vault.getAddress();
      for (const caller of [admin, operator]) {
        await expect(
          protocolConfig.connect(caller).setVaultPausedStatus(share, "withdrawals", true)
        ).to.be.revertedWithCustomError(protocolConfig, "Unauthorized");
      }
      await protocolConfig.connect(guardian).setVaultPausedStatus(share, "withdrawals", true);
      expect((await vault.pauseStatus()).withdrawals).to.equal(true);
    });

    // fix 2: a swap is refused when the SOURCE vault's withdrawals are paused, so AL
    // can't take in shares it couldn't later redeem at the source.
    it("reverts when the SOURCE vault has withdrawals paused", async function () {
      await whitelistShare();
      await protocolConfig
        .connect(guardian)
        .setVaultPausedStatus(await emberVault.getAddress(), "withdrawals", true);
      await expect(
        vault.connect(alice).swapEmberShares(await emberVault.getAddress(), ONE, alice.address, 0n)
      ).to.be.revertedWithCustomError(vault, "OperationPaused");
    });

    // fix 2: source deposits / privilegedOperations don't affect AL's settlement path,
    // so they must NOT block the swap.
    it("still swaps when the SOURCE vault has only deposits/privilegedOperations paused", async function () {
      await whitelistShare();
      await protocolConfig
        .connect(guardian)
        .setVaultPausedStatus(await emberVault.getAddress(), "deposits", true);
      await protocolConfig
        .connect(guardian)
        .setVaultPausedStatus(await emberVault.getAddress(), "privilegedOperations", true);
      await expect(
        vault.connect(alice).swapEmberShares(await emberVault.getAddress(), ONE, alice.address, 0n)
      ).to.not.be.reverted;
    });

    it("reverts on zero share amount", async function () {
      await whitelistShare();
      await expect(
        vault.connect(alice).swapEmberShares(await emberVault.getAddress(), 0, alice.address, 0n)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts when receiver is zero address", async function () {
      await whitelistShare();
      await expect(
        vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), ONE, ethers.ZeroAddress, 0n)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    // Dust floor: a swap whose gross collateral value is below `minSwapGross` is rejected.
    // Without this, an attacker spams sub-unit swaps whose fee rounds to 0 but which still
    // queue near-zero holdback entries — bloating releaseUsersHoldback and enabling a
    // partial-release (unwindingPercentage < 100%) revert DoS.
    it("reverts when gross is below the configured minSwapGross floor", async function () {
      const swapAmount = ethers.parseUnits("100", 18);
      const gross = await emberVault.convertToAssets(swapAmount);
      await whitelistShare({ minSwapGross: gross + 1n });
      await expect(
        vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), swapAmount, alice.address, 0n)
      ).to.be.revertedWithCustomError(vault, "SwapAmountTooSmall");
    });

    it("allows a swap whose gross exactly meets the minSwapGross floor", async function () {
      const swapAmount = ethers.parseUnits("100", 18);
      const gross = await emberVault.convertToAssets(swapAmount);
      await whitelistShare({ minSwapGross: gross });
      await expect(
        vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), swapAmount, alice.address, 0n)
      ).to.not.be.reverted;
    });

    it("applies no floor when minSwapGross is 0", async function () {
      await whitelistShare({ minSwapGross: 0n });
      await expect(
        vault.connect(alice).swapEmberShares(await emberVault.getAddress(), ONE, alice.address, 0n)
      ).to.not.be.reverted;
    });

    // Absolute held-value cap: a swap whose post-swap held value exceeds maxHeldValueAbsolute
    // is rejected, independent of AL's TVL.
    it("rejects a swap whose held value would exceed maxHeldValueAbsolute", async function () {
      const swapAmount = ethers.parseUnits("100", 18);
      const gross = await emberVault.convertToAssets(swapAmount);
      await whitelistShare({ maxHeldValueAbsolute: gross - 1n });
      await expect(
        vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), swapAmount, alice.address, 0n)
      ).to.be.revertedWithCustomError(vault, "EmberShareHeldValueCapExceeded");
    });

    it("allows a swap whose held value is at the maxHeldValueAbsolute ceiling", async function () {
      const swapAmount = ethers.parseUnits("100", 18);
      const gross = await emberVault.convertToAssets(swapAmount);
      await whitelistShare({ maxHeldValueAbsolute: gross });
      await expect(
        vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), swapAmount, alice.address, 0n)
      ).to.not.be.reverted;
    });

    // The absolute cap is TVL-independent, so the deposit→inflate→swap bypass of the
    // percentage utilization cap does not work against it.
    it("absolute held-value cap is not bypassable by inflating AL TVL", async function () {
      const swapAmount = ethers.parseUnits("100", 18);
      const gross = await emberVault.convertToAssets(swapAmount);
      await whitelistShare({
        maxHeldValueAbsolute: gross - 1n,
        maxUtilPct: ethers.parseUnits("1", 18), // 100% — the % cap would NOT gate after inflation
      });

      // Inflate AL TVL massively; this dilutes the utilization ratio but not the absolute cap.
      await vault.connect(bob).deposit(ethers.parseUnits("500000", 18), bob.address);

      await expect(
        vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), swapAmount, alice.address, 0n)
      ).to.be.revertedWithCustomError(vault, "EmberShareHeldValueCapExceeded");
    });

    it("reverts when blacklisted", async function () {
      await whitelistShare();
      await protocolConfig.connect(owner).setBlacklistedAccount(alice.address, true);
      await expect(
        vault.connect(alice).swapEmberShares(await emberVault.getAddress(), ONE, alice.address, 0n)
      ).to.be.revertedWithCustomError(vault, "Blacklisted");
    });
  });

  describe("swapEmberShares - flow", function () {
    beforeEach(async function () {
      await whitelistShare();
    });

    it("pulls EmberShares, pays user net, queues holdback, accrues fee", async function () {
      const swapAmount = ethers.parseUnits("100", 18);
      const gross = await emberVault.convertToAssets(swapAmount);
      const expectedFee = (gross * FEE_PCT) / ONE;
      const expectedHoldback = (gross * HOLDBACK_PCT) / ONE;
      const expectedNet = gross - expectedFee - expectedHoldback;

      const aliceCollatBefore = await collateralToken.balanceOf(alice.address);
      const aliceEmberBefore = await emberVault.balanceOf(alice.address);
      const accruedBefore = (await vault.platformFee()).accrued;

      await expect(
        vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), swapAmount, alice.address, 0n)
      ).to.emit(vault, "EmberShareSwapped");

      // EmberShares moved from alice to AL — AL did NOT auto-redeem.
      expect(await emberVault.balanceOf(alice.address)).to.equal(aliceEmberBefore - swapAmount);
      expect(await emberVault.balanceOf(await vault.getAddress())).to.equal(swapAmount);

      // Alice received `net` USDC.
      expect((await collateralToken.balanceOf(alice.address)) - aliceCollatBefore).to.equal(
        expectedNet
      );

      // Holdback queued for alice.
      expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(1n);
      const entry = await vault.getHoldbackEntry(await emberVault.getAddress(), 0);
      expect(entry.recipient).to.equal(alice.address);
      expect(entry.amount).to.equal(expectedHoldback);
      expect(entry.released).to.equal(0n);

      // Fee accrued (≥ expected; small platform-fee time accrual may be added too).
      const accruedAfter = (await vault.platformFee()).accrued;
      expect(accruedAfter - accruedBefore).to.be.greaterThanOrEqual(expectedFee);
    });

    // The swap fee is netted out of TVL by the time-based fee formula (base = TVL - accrued).
    // The swap must therefore settle the elapsed time-based fee FIRST (checkpointing
    // lastChargedAt) before booking its own fee — otherwise the swap fee would retroactively
    // shrink the fee base for the whole prior period and under-charge the platform.
    it("settles time-based platform fees before booking the swap fee", async function () {
      const share = await emberVault.getAddress();
      const feeBefore = await vault.platformFee();

      // Elapse time so a non-zero time-based fee is owed on AL's TVL.
      await time.increase(30 * 24 * 60 * 60);

      const swapAmount = ethers.parseUnits("100", 18);
      const gross = await emberVault.convertToAssets(swapAmount);
      const expectedSwapFee = (gross * FEE_PCT) / ONE;

      // The swap settles the elapsed time-based fee as part of the same call.
      await expect(
        vault.connect(alice).swapEmberShares(share, swapAmount, alice.address, 0n)
      ).to.emit(vault, "VaultPlatformFeeCharged");

      const feeAfter = await vault.platformFee();
      // lastChargedAt was checkpointed to the swap time (stale before this fix).
      expect(feeAfter.lastChargedAt).to.be.greaterThan(feeBefore.lastChargedAt);
      // accrued grew by the swap fee PLUS a strictly-positive settled time-based fee.
      expect(feeAfter.accrued - feeBefore.accrued).to.be.greaterThan(expectedSwapFee);
    });

    it("epoch capacity blocks redemptions that would push past cap", async function () {
      // EmberVault TVL is ~30k (3 users × 10k each). 50% cap = 15k worth in one epoch.
      const tvl = await emberVault.totalAssets();
      const cap = (tvl * MAX_CAP_PCT) / ONE;

      // Burn cap exactly, then expect next swap to fail.
      const grossPerShare = ONE; // rate is 1, so 1 share = 1 asset
      const sharesAtCap = cap; // numerically equal at rate 1
      await vault
        .connect(alice)
        .swapEmberShares(await emberVault.getAddress(), sharesAtCap, alice.address, 0n);

      await expect(
        vault.connect(bob).swapEmberShares(await emberVault.getAddress(), ONE, bob.address, 0n)
      ).to.be.revertedWithCustomError(vault, "EmberShareCapExceeded");
    });

    it("epoch resets after 24h", async function () {
      const tvl = await emberVault.totalAssets();
      const cap = (tvl * MAX_CAP_PCT) / ONE;

      await vault
        .connect(alice)
        .swapEmberShares(await emberVault.getAddress(), cap, alice.address, 0n);

      await expect(
        vault.connect(bob).swapEmberShares(await emberVault.getAddress(), ONE, bob.address, 0n)
      ).to.be.revertedWithCustomError(vault, "EmberShareCapExceeded");

      // Advance 24h + 1s.
      await time.increase(24 * 60 * 60 + 1);

      // After the rolling window expires, the cap is fresh again.
      await expect(
        vault.connect(bob).swapEmberShares(await emberVault.getAddress(), ONE, bob.address, 0n)
      ).to.not.be.reverted;
    });

    it("availableEmberShareCapacity tracks usage and resets after 24h", async function () {
      const tvl = await emberVault.totalAssets();
      const cap = (tvl * MAX_CAP_PCT) / ONE;
      expect(await vault.availableEmberShareCapacity(await emberVault.getAddress())).to.equal(cap);

      const half = cap / 2n;
      await vault
        .connect(alice)
        .swapEmberShares(await emberVault.getAddress(), half, alice.address, 0n);

      // EmberVault TVL has dropped (alice's deposit hasn't been burnt yet — the
      // EmberVault.redeemShares wasn't called by AL — so TVL is unchanged).
      expect(await vault.availableEmberShareCapacity(await emberVault.getAddress())).to.equal(
        cap - half
      );

      await time.increase(24 * 60 * 60 + 1);
      // Window reset: full cap again.
      expect(await vault.availableEmberShareCapacity(await emberVault.getAddress())).to.equal(cap);
    });

    it("auto-pulls from strategy when AL is short on liquid balance", async function () {
      await vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress());

      // Move ~all AL liquid into the strategy.
      const totalLiquid = await collateralToken.balanceOf(await vault.getAddress());
      await vault.connect(operator).supplyToStrategy(totalLiquid - ethers.parseUnits("1", 18));

      const swapAmount = ethers.parseUnits("100", 18);
      await expect(
        vault
          .connect(bob)
          .swapEmberShares(await emberVault.getAddress(), swapAmount, bob.address, 0n)
      ).to.not.be.reverted;
    });
  });

  describe("setSwapWaiver / waivers", function () {
    beforeEach(async function () {
      await whitelistShare();
    });

    describe("admin setter", function () {
      it("only callable via protocol-config, caller must be admin", async function () {
        await expect(
          vault.connect(admin).setSwapWaiver(admin.address, alice.address, true, false)
        ).to.be.revertedWithCustomError(vault, "Unauthorized");

        await expect(
          vault.connect(configSigner).setSwapWaiver(operator.address, alice.address, true, false)
        ).to.be.revertedWithCustomError(vault, "Unauthorized");
      });

      it("rejects zero account", async function () {
        await expect(
          vault.connect(configSigner).setSwapWaiver(admin.address, ethers.ZeroAddress, true, false)
        ).to.be.revertedWithCustomError(vault, "ZeroAddress");
      });

      it("emits SwapWaiverUpdated and stores both flags independently", async function () {
        await expect(
          vault.connect(configSigner).setSwapWaiver(admin.address, alice.address, true, false)
        )
          .to.emit(vault, "SwapWaiverUpdated")
          .withArgs(
            await vault.getAddress(),
            alice.address,
            true,
            false,
            (val: bigint) => val > 0n,
            (val: bigint) => val > 0n
          );
        expect(await vault.feeWaivedAddresses(alice.address)).to.equal(true);
        expect(await vault.holdbackWaivedAddresses(alice.address)).to.equal(false);
      });

      it("can flip flags off again", async function () {
        await vault.connect(configSigner).setSwapWaiver(admin.address, alice.address, true, true);
        expect(await vault.feeWaivedAddresses(alice.address)).to.equal(true);
        expect(await vault.holdbackWaivedAddresses(alice.address)).to.equal(true);

        await vault.connect(configSigner).setSwapWaiver(admin.address, alice.address, false, false);
        expect(await vault.feeWaivedAddresses(alice.address)).to.equal(false);
        expect(await vault.holdbackWaivedAddresses(alice.address)).to.equal(false);
      });
    });

    describe("swap behavior with waivers", function () {
      const SWAP = ethers.parseUnits("100", 18);

      it("default: no waiver — normal fee + holdback applied", async function () {
        const gross = await emberVault.convertToAssets(SWAP);
        const expFee = (gross * FEE_PCT) / ONE;
        const expHb = (gross * HOLDBACK_PCT) / ONE;
        const expNet = gross - expFee - expHb;

        const aliceBefore = await collateralToken.balanceOf(alice.address);
        await vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), SWAP, alice.address, 0n);
        expect((await collateralToken.balanceOf(alice.address)) - aliceBefore).to.equal(expNet);

        // Holdback queued.
        expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(1n);
      });

      it("fee-waived only: net = gross - holdback; fee=0; holdback still queued", async function () {
        await vault.connect(configSigner).setSwapWaiver(admin.address, alice.address, true, false);

        const gross = await emberVault.convertToAssets(SWAP);
        const expHb = (gross * HOLDBACK_PCT) / ONE;
        const expNet = gross - expHb; // fee = 0

        const aliceBefore = await collateralToken.balanceOf(alice.address);
        const accruedBefore = (await vault.platformFee()).accrued;

        await expect(
          vault
            .connect(alice)
            .swapEmberShares(await emberVault.getAddress(), SWAP, alice.address, 0n)
        )
          .to.emit(vault, "EmberShareSwapped")
          .withArgs(
            await vault.getAddress(),
            await emberVault.getAddress(),
            alice.address,
            alice.address,
            SWAP,
            gross,
            0n, // feeAmount (waived)
            expHb,
            expNet,
            (val: bigint) => val >= 0n, // epochUsedAmount
            (val: bigint) => val >= 0n, // utilizationAtSwap
            ONE, // feeMultiplierApplied — 1× because the curve is empty by default
            (val: bigint) => val > 0n, // timestamp
            (val: bigint) => val > 0n // sequenceNumber
          );

        expect((await collateralToken.balanceOf(alice.address)) - aliceBefore).to.equal(expNet);
        // No fee accrued for the swap (time-based fee may add a tiny bit; assert no ≥ feeAmount jump).
        const accruedAfter = (await vault.platformFee()).accrued;
        expect(accruedAfter - accruedBefore).to.be.lessThan((gross * FEE_PCT) / ONE);

        // Holdback still queued.
        expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(1n);
        const entry = await vault.getHoldbackEntry(await emberVault.getAddress(), 0);
        expect(entry.amount).to.equal(expHb);
      });

      it("holdback-waived only: net = gross - fee; no entry queued; fee accrued", async function () {
        await vault.connect(configSigner).setSwapWaiver(admin.address, alice.address, false, true);

        const gross = await emberVault.convertToAssets(SWAP);
        const expFee = (gross * FEE_PCT) / ONE;
        const expNet = gross - expFee; // holdback = 0

        const aliceBefore = await collateralToken.balanceOf(alice.address);

        await vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), SWAP, alice.address, 0n);

        expect((await collateralToken.balanceOf(alice.address)) - aliceBefore).to.equal(expNet);
        // Holdback queue is empty — nothing to release later.
        expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(0n);
      });

      it("both waived: user gets full gross; no fee, no holdback queued", async function () {
        await vault.connect(configSigner).setSwapWaiver(admin.address, alice.address, true, true);

        const gross = await emberVault.convertToAssets(SWAP);

        const aliceBefore = await collateralToken.balanceOf(alice.address);
        await vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), SWAP, alice.address, 0n);

        expect((await collateralToken.balanceOf(alice.address)) - aliceBefore).to.equal(gross);
        expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(0n);
      });

      it("waiver applies to share-OWNER (msg.sender), not the receiver", async function () {
        // Bob has no waiver; alice does. Bob calls swap and routes payout to alice's address.
        // Fee should still be charged because bob (the share owner) is not waived.
        await vault.connect(configSigner).setSwapWaiver(admin.address, alice.address, true, true);

        const gross = await emberVault.convertToAssets(SWAP);
        const expFee = (gross * FEE_PCT) / ONE;
        const expHb = (gross * HOLDBACK_PCT) / ONE;
        const expNet = gross - expFee - expHb;

        const aliceBefore = await collateralToken.balanceOf(alice.address);
        await vault
          .connect(bob)
          .swapEmberShares(await emberVault.getAddress(), SWAP, alice.address, 0n);

        expect((await collateralToken.balanceOf(alice.address)) - aliceBefore).to.equal(expNet);
        // Bob's holdback IS queued (recipient is alice though).
        expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(1n);
      });

      it("holdback-waived swap does NOT affect later non-waived swaps' queue ordering", async function () {
        // alice waived, bob not. Alice swaps first (no entry queued). Bob swaps next (entry queued).
        await vault.connect(configSigner).setSwapWaiver(admin.address, alice.address, false, true);

        await vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), SWAP, alice.address, 0n);
        await vault
          .connect(bob)
          .swapEmberShares(await emberVault.getAddress(), SWAP, bob.address, 0n);

        // Only bob's entry is in the queue; alice's swap skipped queueing because of waiver.
        expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(1n);
        const entry = await vault.getHoldbackEntry(await emberVault.getAddress(), 0);
        expect(entry.recipient).to.equal(bob.address);
      });

      it("waiver still consumes per-epoch capacity (cap is a TVL guardrail, not a fee policy)", async function () {
        // Confirm that exempting fee/holdback does not bypass the EmberVault TVL cap — the
        // cap protects the source vault from drain, not the AL revenue share.
        await vault.connect(configSigner).setSwapWaiver(admin.address, alice.address, true, true);

        const tvl = await emberVault.totalAssets();
        const cap = (tvl * MAX_CAP_PCT) / ONE;

        // Burn cap exactly with alice's swap; bob's tiny follow-up should still revert.
        await vault
          .connect(alice)
          .swapEmberShares(await emberVault.getAddress(), cap, alice.address, 0n);

        await expect(
          vault.connect(bob).swapEmberShares(await emberVault.getAddress(), ONE, bob.address, 0n)
        ).to.be.revertedWithCustomError(vault, "EmberShareCapExceeded");
      });
    });
  });

  describe("redeemCollectedEmberShares", function () {
    beforeEach(async function () {
      await whitelistShare();
      // Generate some collected shares.
      await vault
        .connect(alice)
        .swapEmberShares(
          await emberVault.getAddress(),
          ethers.parseUnits("100", 18),
          alice.address,
          0n
        );
      await vault
        .connect(bob)
        .swapEmberShares(
          await emberVault.getAddress(),
          ethers.parseUnits("200", 18),
          bob.address,
          0n
        );
    });

    it("reverts when caller is not operator", async function () {
      await expect(
        vault
          .connect(admin)
          .redeemCollectedEmberShares(await emberVault.getAddress(), ethers.parseUnits("100", 18))
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("reverts on zero share or zero amount", async function () {
      await expect(
        vault.connect(operator).redeemCollectedEmberShares(ethers.ZeroAddress, ONE)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");

      await expect(
        vault.connect(operator).redeemCollectedEmberShares(await emberVault.getAddress(), 0)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts when amount exceeds AL's held balance of the share", async function () {
      const held = await emberVault.balanceOf(await vault.getAddress());
      await expect(
        vault.connect(operator).redeemCollectedEmberShares(await emberVault.getAddress(), held + 1n)
      ).to.be.revertedWithCustomError(vault, "InsufficientBalance");
    });

    it("creates a withdrawal request on the source EmberVault and emits event", async function () {
      const held = await emberVault.balanceOf(await vault.getAddress());
      const queueLenBefore = await emberVault.getPendingWithdrawalsLength();

      await expect(
        vault.connect(operator).redeemCollectedEmberShares(await emberVault.getAddress(), held)
      ).to.emit(vault, "EmberSharesRedemptionInitiated");

      // EmberVault now has a pending withdrawal request from AL.
      expect(await emberVault.getPendingWithdrawalsLength()).to.equal(queueLenBefore + 1n);

      // AL no longer holds those shares (transferred to EmberVault while parked).
      expect(await emberVault.balanceOf(await vault.getAddress())).to.equal(0n);
    });

    it("works on chunked redemptions", async function () {
      const held = await emberVault.balanceOf(await vault.getAddress());
      const half = held / 2n;

      await vault.connect(operator).redeemCollectedEmberShares(await emberVault.getAddress(), half);
      await vault
        .connect(operator)
        .redeemCollectedEmberShares(await emberVault.getAddress(), held - half);

      // Two pending requests created on EmberVault.
      expect(await emberVault.getPendingWithdrawalsLength()).to.be.greaterThanOrEqual(2n);
    });
  });

  describe("releaseUsersHoldback", function () {
    beforeEach(async function () {
      await whitelistShare();

      // Three swaps -> three holdback entries.
      await vault
        .connect(alice)
        .swapEmberShares(
          await emberVault.getAddress(),
          ethers.parseUnits("100", 18),
          alice.address,
          0n
        );
      await vault
        .connect(bob)
        .swapEmberShares(
          await emberVault.getAddress(),
          ethers.parseUnits("200", 18),
          bob.address,
          0n
        );
      await vault
        .connect(carol)
        .swapEmberShares(
          await emberVault.getAddress(),
          ethers.parseUnits("300", 18),
          carol.address,
          0n
        );
    });

    it("reverts when caller is not operator", async function () {
      await expect(
        vault.connect(admin).releaseUsersHoldback(await emberVault.getAddress(), ONE, 10n)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("emits releasedFrom/To sequence numbers spanning exactly the settled FIFO block", async function () {
      const share = await emberVault.getAddress();
      const e0 = await vault.getHoldbackEntry(share, 0);
      const e1 = await vault.getHoldbackEntry(share, 1);
      const e2 = await vault.getHoldbackEntry(share, 2);

      // Entries are queued in strictly increasing swap-sequence order.
      expect(e0.sequenceNumber).to.be.lessThan(e1.sequenceNumber);
      expect(e1.sequenceNumber).to.be.lessThan(e2.sequenceNumber);

      const parseHoldbackReleased = (logs: readonly { topics: string[]; data: string }[]) =>
        logs
          .map((l) => {
            try {
              return vault.interface.parseLog(l);
            } catch {
              return null;
            }
          })
          .find((p) => p?.name === "HoldbackReleased");

      // Partial release of the oldest two entries -> range [e0, e1].
      const rc1 = await (await vault.connect(operator).releaseUsersHoldback(share, ONE, 2n)).wait();
      const ev1 = parseHoldbackReleased(rc1!.logs);
      expect(ev1, "HoldbackReleased not emitted").to.not.equal(undefined);
      expect(ev1!.args.entriesProcessed).to.equal(2n);
      expect(ev1!.args.releasedFromSequenceNumber).to.equal(e0.sequenceNumber);
      expect(ev1!.args.releasedToSequenceNumber).to.equal(e1.sequenceNumber);

      // Next release settles the remaining single entry -> range [e2, e2].
      const rc2 = await (
        await vault.connect(operator).releaseUsersHoldback(share, ONE, 10n)
      ).wait();
      const ev2 = parseHoldbackReleased(rc2!.logs);
      expect(ev2!.args.entriesProcessed).to.equal(1n);
      expect(ev2!.args.releasedFromSequenceNumber).to.equal(e2.sequenceNumber);
      expect(ev2!.args.releasedToSequenceNumber).to.equal(e2.sequenceNumber);
    });

    it("reverts on percentage > 1e18 (0 is valid — M-2 socialize-full-loss)", async function () {
      // M-2: unwindingPercentage == 0 is a valid "pay nothing / socialize the full loss" run,
      // not an error — so 0 must NOT revert with InvalidPercentage. Only > 100% is rejected.
      await expect(
        vault
          .connect(operator)
          .releaseUsersHoldback(await emberVault.getAddress(), ethers.parseUnits("1.01", 18), 10n)
      ).to.be.revertedWithCustomError(vault, "InvalidPercentage");

      await expect(
        vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), 0, 10n)
      ).to.not.be.revertedWithCustomError(vault, "InvalidPercentage");
    });

    it("reverts on maxEntries = 0", async function () {
      await expect(
        vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 0)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts on empty queue", async function () {
      // Drain by full release first.
      await vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 100n);
      // Now everything is fully released and head advanced — queue effectively empty.
      await expect(
        vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 10n)
      ).to.be.revertedWithCustomError(vault, "EmptyHoldbackQueue");
    });

    it("100% drains all entries and advances queue head", async function () {
      const aliceBefore = await collateralToken.balanceOf(alice.address);
      const bobBefore = await collateralToken.balanceOf(bob.address);
      const carolBefore = await collateralToken.balanceOf(carol.address);

      const e0 = await vault.getHoldbackEntry(await emberVault.getAddress(), 0);
      const e1 = await vault.getHoldbackEntry(await emberVault.getAddress(), 1);
      const e2 = await vault.getHoldbackEntry(await emberVault.getAddress(), 2);

      await vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 100n);

      expect((await collateralToken.balanceOf(alice.address)) - aliceBefore).to.equal(e0.amount);
      expect((await collateralToken.balanceOf(bob.address)) - bobBefore).to.equal(e1.amount);
      expect((await collateralToken.balanceOf(carol.address)) - carolBefore).to.equal(e2.amount);

      expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(0n);
      expect(await vault.holdbackQueueStartIndex(await emberVault.getAddress())).to.equal(3n);
    });

    it("one-shot settlement: <100% pays the haircut amount and closes each entry permanently", async function () {
      const ninety = ethers.parseUnits("0.9", 18);

      const aliceBefore = await collateralToken.balanceOf(alice.address);
      const e0 = await vault.getHoldbackEntry(await emberVault.getAddress(), 0);
      const expectedPayout = (e0.amount * ninety) / ONE;

      await vault
        .connect(operator)
        .releaseUsersHoldback(await emberVault.getAddress(), ninety, 100n);

      expect((await collateralToken.balanceOf(alice.address)) - aliceBefore).to.equal(
        expectedPayout
      );
      // Entry's released field records what was actually paid out (for off-chain audit).
      const e0After = await vault.getHoldbackEntry(await emberVault.getAddress(), 0);
      expect(e0After.released).to.equal(expectedPayout);
      // Head advances past every visited entry regardless of unwindingPercentage.
      expect(await vault.holdbackQueueStartIndex(await emberVault.getAddress())).to.equal(3n);

      // Re-calling at 100% does NOT re-open closed entries — the queue is empty.
      await expect(
        vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 100n)
      ).to.be.revertedWithCustomError(vault, "EmptyHoldbackQueue");
    });

    it("settles sub-precision dust holdback in full instead of reverting the batch (anti-griefing)", async function () {
      const shareAddr = await emberVault.getAddress();

      // Seed a dust entry whose 5% holdback floors to a single base unit — the
      // exact thing a griefer creates with a tiny swap. Aim for a gross of ~30
      // base units (5% of 30 = 1) in a rate-agnostic way.
      const shareAmt = await emberVault.convertToShares(30n);
      await vault.connect(alice).swapEmberShares(shareAddr, shareAmt, alice.address, 0n);

      const dustIndex = 3n; // appended after the three entries from beforeEach
      const dust = await vault.getHoldbackEntry(shareAddr, dustIndex);
      expect(dust.amount).to.equal(1n);

      // At 90% the dust entry's payout floors to zero. Before the fix this
      // reverted the whole batch with InvalidPercentage and — because the head
      // pointer is fixed in storage and cannot be skipped — stalled every entry
      // behind it for any unwindingPercentage < 100%. Now it settles in full.
      const ninety = ethers.parseUnits("0.9", 18);
      await vault.connect(operator).releaseUsersHoldback(shareAddr, ninety, 100n);

      // Whole queue drained in one call — dust did not stall it.
      expect(await vault.holdbackQueueStartIndex(shareAddr)).to.equal(4n);
      expect(await vault.getPendingHoldbackEntries(shareAddr)).to.equal(0n);

      // The dust entry was paid its full amount (not zeroed out).
      const dustAfter = await vault.getHoldbackEntry(shareAddr, dustIndex);
      expect(dustAfter.released).to.equal(dust.amount);
    });

    it("maxEntries bounds gas; head advances by exactly entriesProcessed", async function () {
      // Release ONLY 1 entry at 100%.
      await vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 1n);

      expect(await vault.holdbackQueueStartIndex(await emberVault.getAddress())).to.equal(1n);
      // Two unprocessed entries left.
      expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(2n);

      // Process the rest with a generous budget; head moves to the end.
      await vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 100n);
      expect(await vault.holdbackQueueStartIndex(await emberVault.getAddress())).to.equal(3n);
    });

    it("FIFO order: oldest entry pays first", async function () {
      // Release one entry — the oldest (alice's) should be processed.
      const aliceBefore = await collateralToken.balanceOf(alice.address);
      const bobBefore = await collateralToken.balanceOf(bob.address);

      await vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 1n);

      expect((await collateralToken.balanceOf(alice.address)) - aliceBefore).to.be.greaterThan(0n);
      expect(await collateralToken.balanceOf(bob.address)).to.equal(bobBefore);
    });

    it("auto-pulls collateral from strategy if AL is short", async function () {
      // Drain AL liquid into strategy.
      await vault.connect(configSigner).setStrategy(admin.address, await strategy.getAddress());
      const liquid = await collateralToken.balanceOf(await vault.getAddress());
      await vault.connect(operator).supplyToStrategy(liquid - ethers.parseUnits("1", 18));

      // Now release: AL must auto-pull from strategy to satisfy the holdback payouts.
      await expect(
        vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 100n)
      ).to.not.be.reverted;
    });

    it("emits HoldbackReleased with summary fields", async function () {
      await expect(
        vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 100n)
      ).to.emit(vault, "HoldbackReleased");
    });

    // A recipient that is blacklisted AFTER its holdback was queued (e.g. because it can no
    // longer receive the collateral token) would otherwise freeze the FIFO head. The release
    // now SKIPS such entries — forfeiting the holdback and advancing past them — so later
    // entries can still be settled. This is the resolution path for the head-of-queue DoS.
    it("skips a blacklisted recipient, forfeits its holdback, and pays the rest", async function () {
      const share = await emberVault.getAddress();
      // Blacklist the head recipient (alice) — her entry is already queued from beforeEach.
      await protocolConfig.connect(owner).setBlacklistedAccount(alice.address, true);

      const aliceBefore = await collateralToken.balanceOf(alice.address);
      const bobBefore = await collateralToken.balanceOf(bob.address);
      const carolBefore = await collateralToken.balanceOf(carol.address);

      await vault.connect(operator).releaseUsersHoldback(share, ONE, 100n);

      // Blacklisted recipient received nothing; the others were paid their full holdback.
      expect(await collateralToken.balanceOf(alice.address)).to.equal(aliceBefore);
      expect(await collateralToken.balanceOf(bob.address)).to.be.greaterThan(bobBefore);
      expect(await collateralToken.balanceOf(carol.address)).to.be.greaterThan(carolBefore);

      // Head advanced past every entry, including the skipped one — queue fully drained.
      expect(await vault.getPendingHoldbackEntries(share)).to.equal(0n);
    });

    it("a skip-only batch advances the head instead of reverting", async function () {
      const share = await emberVault.getAddress();
      await protocolConfig.connect(owner).setBlacklistedAccount(alice.address, true);

      const pendingBefore = await vault.getPendingHoldbackEntries(share);
      // maxEntries = 1 visits only alice's (blacklisted) entry → nothing released, but it must
      // still advance rather than revert, otherwise the DoS is unresolved.
      await expect(vault.connect(operator).releaseUsersHoldback(share, ONE, 1n)).to.not.be.reverted;
      expect(await vault.getPendingHoldbackEntries(share)).to.equal(pendingBefore - 1n);
    });

    it("reports entriesSkipped in the HoldbackReleased event", async function () {
      const share = await emberVault.getAddress();
      await protocolConfig.connect(owner).setBlacklistedAccount(alice.address, true);

      const rc = await (
        await vault.connect(operator).releaseUsersHoldback(share, ONE, 100n)
      ).wait();
      const ev = rc!.logs
        .map((l) => {
          try {
            return vault.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p?.name === "HoldbackReleased");
      expect(ev, "HoldbackReleased not emitted").to.not.equal(undefined);
      expect(ev!.args.entriesProcessed).to.equal(3n);
      expect(ev!.args.entriesSkipped).to.equal(1n);
    });
  });

  describe("End-to-end: swap -> redeem-collected -> EmberVault settle -> release", function () {
    it("user gets net immediately, then full holdback after settlement & release", async function () {
      await whitelistShare();

      const swapAmount = ethers.parseUnits("100", 18);
      const gross = await emberVault.convertToAssets(swapAmount);
      const expectedFee = (gross * FEE_PCT) / ONE;
      const expectedHoldback = (gross * HOLDBACK_PCT) / ONE;
      const expectedNet = gross - expectedFee - expectedHoldback;

      const aliceStart = await collateralToken.balanceOf(alice.address);

      // 1. Alice swaps EmberShares for net immediately.
      await vault
        .connect(alice)
        .swapEmberShares(await emberVault.getAddress(), swapAmount, alice.address, 0n);

      let aliceNow = await collateralToken.balanceOf(alice.address);
      expect(aliceNow - aliceStart).to.equal(expectedNet);

      // 2. Operator forwards the collected EmberShares to EmberVault for redemption.
      await vault
        .connect(operator)
        .redeemCollectedEmberShares(await emberVault.getAddress(), swapAmount);

      // 3. EmberVault operator processes the request (sends collateral back to AL).
      await emberVault.connect(operator).processWithdrawalRequests(10n);

      // 4. AL operator releases 100% of holdback.
      await vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 100n);

      // Alice has now received net + holdback = gross - fee.
      aliceNow = await collateralToken.balanceOf(alice.address);
      expect(aliceNow - aliceStart).to.equal(expectedNet + expectedHoldback);

      // Holdback queue is fully drained.
      expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(0n);
    });
  });

  // Operator may not want to settle the entire holdback queue in one shot. The maxEntries
  // parameter on releaseUsersHoldback supports FIFO partial processing: pay out the oldest
  // N users now, leave the rest queued at their full holdback amount until a later call.
  // This mirrors how processWithdrawalRequests works on the regular EmberVault.
  describe("Partial batch release (FIFO subset of a large queue)", function () {
    // We can't easily create 100 distinct user signers in hardhat, so we simulate the
    // 100-user scenario with 10 sequential swaps from the existing users — same FIFO
    // semantics, smaller test footprint.
    const QUEUE_SIZE = 10n;
    const SWAP_PER_USER = ethers.parseUnits("50", 18);

    beforeEach(async function () {
      await whitelistShare();
      // Create QUEUE_SIZE entries by interleaving swaps across alice/bob/carol so the
      // FIFO order has predictable recipients per index.
      const queueOwners = [alice, bob, carol];
      for (let i = 0; i < Number(QUEUE_SIZE); i++) {
        const owner = queueOwners[i % queueOwners.length];
        await vault
          .connect(owner)
          .swapEmberShares(await emberVault.getAddress(), SWAP_PER_USER, owner.address, 0n);
      }
      expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(
        QUEUE_SIZE
      );

      // Have AL forward all collected EmberShares for settlement so it has collateral
      // to release any subset of holdbacks.
      const collected = await emberVault.balanceOf(await vault.getAddress());
      await vault
        .connect(operator)
        .redeemCollectedEmberShares(await emberVault.getAddress(), collected);
      await emberVault.connect(operator).processWithdrawalRequests(100n);
    });

    it("processes only the requested subset; unprocessed entries remain queued at full amount", async function () {
      const shareAddr = await emberVault.getAddress();
      const BATCH = 4n;

      // Capture each entry's amount BEFORE release. Indexes are absolute positions in
      // the queue and survive across head advances.
      const amountsBefore: bigint[] = [];
      for (let i = 0; i < Number(QUEUE_SIZE); i++) {
        amountsBefore.push((await vault.getHoldbackEntry(shareAddr, i)).amount);
      }

      // Operator processes the oldest BATCH only.
      const tx = await vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, BATCH);
      const receipt = await tx.wait();
      // entriesProcessed in the event matches BATCH.
      const evt = receipt!.logs
        .map((l) => {
          try {
            return vault.interface.parseLog({ topics: [...l.topics], data: l.data });
          } catch {
            return null;
          }
        })
        .find((l) => l && l.name === "HoldbackReleased");
      expect(evt!.args.entriesProcessed).to.equal(BATCH);

      // Head advanced by exactly BATCH; the remaining entries stay queued.
      expect(await vault.holdbackQueueStartIndex(shareAddr)).to.equal(BATCH);
      expect(await vault.getPendingHoldbackEntries(shareAddr)).to.equal(QUEUE_SIZE - BATCH);

      // Entries [0..BATCH) have released = amount (paid in full at 100%).
      for (let i = 0; i < Number(BATCH); i++) {
        const entry = await vault.getHoldbackEntry(shareAddr, i);
        expect(entry.released).to.equal(amountsBefore[i]);
      }

      // Entries [BATCH..QUEUE_SIZE) are untouched: amount unchanged, released still 0.
      // Operator's bad-debt exposure on these users is unchanged until a later call.
      for (let i = Number(BATCH); i < Number(QUEUE_SIZE); i++) {
        const entry = await vault.getHoldbackEntry(shareAddr, i);
        expect(entry.amount).to.equal(amountsBefore[i]);
        expect(entry.released).to.equal(0n);
      }
    });

    it("staged batches drain the queue FIFO without disturbing later entries", async function () {
      const shareAddr = await emberVault.getAddress();

      // Batch sizes 4, 3, 3 → totals 10.
      await vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 4n);
      expect(await vault.holdbackQueueStartIndex(shareAddr)).to.equal(4n);
      expect(await vault.getPendingHoldbackEntries(shareAddr)).to.equal(6n);

      await vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 3n);
      expect(await vault.holdbackQueueStartIndex(shareAddr)).to.equal(7n);
      expect(await vault.getPendingHoldbackEntries(shareAddr)).to.equal(3n);

      await vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 3n);
      expect(await vault.holdbackQueueStartIndex(shareAddr)).to.equal(10n);
      expect(await vault.getPendingHoldbackEntries(shareAddr)).to.equal(0n);

      // Subsequent attempt reverts because queue is exhausted.
      await expect(
        vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 1n)
      ).to.be.revertedWithCustomError(vault, "EmptyHoldbackQueue");
    });

    it("recipients are paid in FIFO order — index 0 first, index N-1 last", async function () {
      const shareAddr = await emberVault.getAddress();
      const balancesBefore = {
        alice: await collateralToken.balanceOf(alice.address),
        bob: await collateralToken.balanceOf(bob.address),
        carol: await collateralToken.balanceOf(carol.address),
      };

      // Process only the first 2 entries. Queue indexes 0 and 1 belong to alice and bob
      // respectively (round-robin order from setup). Carol (index 2) should NOT be paid.
      await vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 2n);

      const aliceDelta = (await collateralToken.balanceOf(alice.address)) - balancesBefore.alice;
      const bobDelta = (await collateralToken.balanceOf(bob.address)) - balancesBefore.bob;
      const carolDelta = (await collateralToken.balanceOf(carol.address)) - balancesBefore.carol;

      expect(aliceDelta).to.be.greaterThan(0n);
      expect(bobDelta).to.be.greaterThan(0n);
      expect(carolDelta).to.equal(0n); // Not yet paid — still queued.
    });

    it("partial release works at <100% too: 50 of 100 users at 95% unwinding", async function () {
      // Same partial-batch mechanic stacks with the haircut model — 4 of 10 paid at 95%.
      const shareAddr = await emberVault.getAddress();
      const ninetyFive = ethers.parseUnits("0.95", 18);

      const e0Amount = (await vault.getHoldbackEntry(shareAddr, 0)).amount;
      const expectedPayout0 = (e0Amount * ninetyFive) / ONE;

      await vault.connect(operator).releaseUsersHoldback(shareAddr, ninetyFive, 4n);

      // Head advances by 4; entries 0..3 closed at 95%; entries 4..9 untouched.
      expect(await vault.holdbackQueueStartIndex(shareAddr)).to.equal(4n);
      expect((await vault.getHoldbackEntry(shareAddr, 0)).released).to.equal(expectedPayout0);
      // Operator can still call again on the unprocessed tail at any other percentage —
      // the haircut on the first batch does not constrain later batches.
      expect((await vault.getHoldbackEntry(shareAddr, 5)).released).to.equal(0n);
    });
  });

  // ============================================================================
  // Ported Sui features: concentration cap + fee-multiplier curve, redemption-history cache
  // ============================================================================
  describe("Concentration cap (maxUtilizationPercentage)", function () {
    it("blocks a swap that would push post-swap utilization past the cap", async function () {
      // alice has 10,000 EmberShares (worth 10,000 USDC at rate=1). AL TVL is 50,000 USDC.
      // Set maxUtilization = 10% → cap is 5,000 USDC of held value.
      const tenPct = ethers.parseUnits("0.1", 18);
      await whitelistShare({ maxUtilPct: tenPct });

      // 4,000 share swap → held value = 4,000 → utilization = 4000/50000 = 8% → OK.
      await vault
        .connect(alice)
        .swapEmberShares(
          await emberVault.getAddress(),
          ethers.parseUnits("4000", 18),
          alice.address,
          0n
        );

      // Another 2,000 → held value = 6,000 → utilization = 12% → over the 10% cap.
      await expect(
        vault
          .connect(bob)
          .swapEmberShares(
            await emberVault.getAddress(),
            ethers.parseUnits("2000", 18),
            bob.address,
            0n
          )
      ).to.be.revertedWithCustomError(vault, "EmberShareUtilizationCapExceeded");
    });

    it("a swap right at the cap is allowed, a strictly larger one is not", async function () {
      const tenPct = ethers.parseUnits("0.1", 18);
      await whitelistShare({ maxUtilPct: tenPct });

      // TVL = 50_000, cap = 5_000. Exactly 5_000 shares lands at the cap.
      await vault
        .connect(alice)
        .swapEmberShares(
          await emberVault.getAddress(),
          ethers.parseUnits("5000", 18),
          alice.address,
          0n
        );

      // Even a tiny extra swap pushes utilization over 10% (use 1 USDC, well past
      // the FixedPointMath.div rounding floor at TVL=50_000).
      await expect(
        vault
          .connect(bob)
          .swapEmberShares(
            await emberVault.getAddress(),
            ethers.parseUnits("1", 18),
            bob.address,
            0n
          )
      ).to.be.revertedWithCustomError(vault, "EmberShareUtilizationCapExceeded");
    });
  });

  describe("Fee-multiplier curve (updateEmberShareFeeMultiplierTier)", function () {
    beforeEach(async function () {
      await whitelistShare();
    });

    it("only callable via protocol-config, caller must be admin", async function () {
      await expect(
        vault
          .connect(admin)
          .updateEmberShareFeeMultiplierTier(
            admin.address,
            await emberVault.getAddress(),
            0,
            ONE,
            false
          )
      ).to.be.revertedWithCustomError(vault, "Unauthorized");

      await expect(
        vault
          .connect(configSigner)
          .updateEmberShareFeeMultiplierTier(
            operator.address,
            await emberVault.getAddress(),
            0,
            ONE,
            false
          )
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("rejects multiplier < 1e18 on insert (fees can only go UP)", async function () {
      await expect(
        vault
          .connect(configSigner)
          .updateEmberShareFeeMultiplierTier(
            admin.address,
            await emberVault.getAddress(),
            0,
            ONE - 1n,
            false
          )
      ).to.be.revertedWithCustomError(vault, "InvalidFeeMultiplier");
    });

    it("rejects threshold > 1e18", async function () {
      const overOne = ONE + 1n;
      await expect(
        vault
          .connect(configSigner)
          .updateEmberShareFeeMultiplierTier(
            admin.address,
            await emberVault.getAddress(),
            overOne,
            ethers.parseUnits("2", 18),
            false
          )
      ).to.be.revertedWithCustomError(vault, "InvalidPercentage");
    });

    it("rejects remove on a non-existent threshold", async function () {
      await expect(
        vault
          .connect(configSigner)
          .updateEmberShareFeeMultiplierTier(
            admin.address,
            await emberVault.getAddress(),
            ethers.parseUnits("0.5", 18),
            0,
            true
          )
      ).to.be.revertedWithCustomError(vault, "TierNotFound");
    });

    // ---- A-10: bound & validate the fee-multiplier curve at set time ----

    async function setTier(threshold: bigint, multiplier: bigint) {
      return vault
        .connect(configSigner)
        .updateEmberShareFeeMultiplierTier(
          admin.address,
          await emberVault.getAddress(),
          threshold,
          multiplier,
          false
        );
    }

    it("A-10: rejects a multiplier above MAX_FEE_MULTIPLIER (100x)", async function () {
      // Re-whitelist with a ~0 base fee so the effective-fee guard doesn't fire first and we
      // isolate the max-multiplier bound.
      await whitelistShare({ feePct: 1n, holdbackPct: 0n });
      const hundredX = ethers.parseUnits("100", 18);
      await expect(setTier(0, hundredX + 1n)).to.be.revertedWithCustomError(
        vault,
        "InvalidFeeMultiplier"
      );
      // Exactly 100x is allowed against a negligible base fee.
      await expect(setTier(0, hundredX)).to.not.be.reverted;
    });

    it("A-10: rejects a tier whose effective fee + holdback exceeds 100%", async function () {
      // base 40% + holdback 40% (ok at whitelist). A 2x tier => effective 80%, +holdback = 120%.
      await whitelistShare({
        feePct: ethers.parseUnits("0.4", 18),
        holdbackPct: ethers.parseUnits("0.4", 18),
      });
      await expect(setTier(0, ethers.parseUnits("2", 18))).to.be.revertedWithCustomError(
        vault,
        "InvalidFeeMultiplier"
      );
    });

    it("A-10: rejects effective fee == 100% even with zero holdback (strict guard)", async function () {
      // base 1%, holdback 0. A 100x tier => effective exactly 100%, which the swap rejects.
      await whitelistShare({ feePct: ethers.parseUnits("0.01", 18), holdbackPct: 0n });
      await expect(setTier(0, ethers.parseUnits("100", 18))).to.be.revertedWithCustomError(
        vault,
        "InvalidFeeMultiplier"
      );
    });

    it("A-10: rejects a non-monotonic curve", async function () {
      await whitelistShare({ feePct: ethers.parseUnits("0.01", 18), holdbackPct: 0n });
      // Insert an aggressive low-utilization tier, then a cheaper higher-utilization tier.
      await setTier(ethers.parseUnits("0.2", 18), ethers.parseUnits("3", 18));
      await expect(
        setTier(ethers.parseUnits("0.5", 18), ethers.parseUnits("2", 18))
      ).to.be.revertedWithCustomError(vault, "InvalidFeeMultiplier");
    });

    it("A-10: caps the curve at MAX_FEE_MULTIPLIER_TIERS (20)", async function () {
      await whitelistShare({ feePct: 1n, holdbackPct: 0n });
      // 20 tiers at distinct ascending thresholds, all 1x (monotonic, effective ~0) — allowed.
      for (let i = 1; i <= 20; i++) {
        await setTier((ONE * BigInt(i)) / 21n, ONE);
      }
      // The 21st tier is rejected.
      await expect(setTier((ONE * 20n) / 21n + 1n, ONE)).to.be.revertedWithCustomError(
        vault,
        "InvalidFeeMultiplier"
      );
    });

    it("A-10: whitelist re-validation blocks a base raise that would brick the top tier", async function () {
      // base 1%, holdback 0, with a 50x tier => effective 50% (ok).
      await whitelistShare({ feePct: ethers.parseUnits("0.01", 18), holdbackPct: 0n });
      await setTier(ethers.parseUnits("0.5", 18), ethers.parseUnits("50", 18));
      // Raising the base to 3% would make the top tier's effective fee 150% -> rejected.
      await expect(
        whitelistShare({ feePct: ethers.parseUnits("0.03", 18), holdbackPct: 0n })
      ).to.be.revertedWithCustomError(vault, "InvalidFeeMultiplier");
    });

    it("scales the effective fee at higher utilization (1.5× at 50% util)", async function () {
      // No cap concerns — leave max utilization at 100%. Insert a single tier:
      // at >= 50% utilization, fee multiplier = 1.5×.
      const fiftyPct = ethers.parseUnits("0.5", 18);
      const onePointFive = ethers.parseUnits("1.5", 18);
      await vault
        .connect(configSigner)
        .updateEmberShareFeeMultiplierTier(
          admin.address,
          await emberVault.getAddress(),
          fiftyPct,
          onePointFive,
          false
        );

      // First swap small enough to keep utilization < 50% → no multiplier (1×).
      const small = ethers.parseUnits("1000", 18); // → util = 1000/50000 = 2%
      const grossSmall = await emberVault.convertToAssets(small);
      const baseFeeSmall = (grossSmall * FEE_PCT) / ONE;
      const expHbSmall = (grossSmall * HOLDBACK_PCT) / ONE;
      const expNetSmall = grossSmall - baseFeeSmall - expHbSmall;

      const aliceBefore = await collateralToken.balanceOf(alice.address);
      await vault
        .connect(alice)
        .swapEmberShares(await emberVault.getAddress(), small, alice.address, 0n);
      expect((await collateralToken.balanceOf(alice.address)) - aliceBefore).to.equal(expNetSmall);

      // Now a bigger swap whose post-swap utilization clears the 50% threshold.
      // AL TVL still ~50,000 (no rate change). We've already used 1000. Need
      // post-swap util >= 50% → held >= 25,000. Bob has 10,000 → swap full 10,000.
      // Held becomes 11,000 → util = 22% → still below 50%, doesn't trigger.
      //
      // Instead, set the curve threshold lower (2%) to make the multiplier
      // fire on bob's swap.
      const twoPct = ethers.parseUnits("0.02", 18);
      await vault
        .connect(configSigner)
        .updateEmberShareFeeMultiplierTier(
          admin.address,
          await emberVault.getAddress(),
          twoPct,
          onePointFive,
          false
        );

      const big = ethers.parseUnits("5000", 18); // post-swap held = 6000 → util ~12%
      const grossBig = await emberVault.convertToAssets(big);
      // Effective fee = base * 1.5
      const baseFeeBig = (grossBig * FEE_PCT) / ONE;
      const expFeeBig = (baseFeeBig * onePointFive) / ONE; // multiplied
      const expHbBig = (grossBig * HOLDBACK_PCT) / ONE;
      const expNetBig = grossBig - expFeeBig - expHbBig;

      const bobBefore = await collateralToken.balanceOf(bob.address);
      await vault.connect(bob).swapEmberShares(await emberVault.getAddress(), big, bob.address, 0n);
      expect((await collateralToken.balanceOf(bob.address)) - bobBefore).to.equal(expNetBig);
    });

    it("upserts a tier (updates multiplier at the same threshold)", async function () {
      const t = ethers.parseUnits("0.5", 18);
      const m1 = ethers.parseUnits("1.5", 18);
      const m2 = ethers.parseUnits("2.0", 18);
      await vault
        .connect(configSigner)
        .updateEmberShareFeeMultiplierTier(
          admin.address,
          await emberVault.getAddress(),
          t,
          m1,
          false
        );
      // Update — same threshold, different multiplier. Must not abort with a
      // duplicate error.
      await expect(
        vault
          .connect(configSigner)
          .updateEmberShareFeeMultiplierTier(
            admin.address,
            await emberVault.getAddress(),
            t,
            m2,
            false
          )
      ).to.emit(vault, "EmberShareFeeMultiplierTierUpdated");
    });

    it("remove emits the event with multiplier = 0 and removed = true", async function () {
      const t = ethers.parseUnits("0.3", 18);
      const m = ethers.parseUnits("1.2", 18);
      await vault
        .connect(configSigner)
        .updateEmberShareFeeMultiplierTier(
          admin.address,
          await emberVault.getAddress(),
          t,
          m,
          false
        );
      await expect(
        vault
          .connect(configSigner)
          .updateEmberShareFeeMultiplierTier(
            admin.address,
            await emberVault.getAddress(),
            t,
            0,
            true
          )
      )
        .to.emit(vault, "EmberShareFeeMultiplierTierUpdated")
        .withArgs(
          await vault.getAddress(),
          await emberVault.getAddress(),
          t,
          0,
          true,
          (v: bigint) => v > 0n,
          (v: bigint) => v > 0n
        );
    });
  });

  describe("hasActiveRedemptionHistory cache flag", function () {
    beforeEach(async function () {
      await whitelistShare();
      await vault
        .connect(alice)
        .swapEmberShares(
          await emberVault.getAddress(),
          ethers.parseUnits("100", 18),
          alice.address,
          0n
        );
    });

    it("starts false and flips true on first redeemCollectedEmberShares", async function () {
      expect(await vault.hasActiveRedemptionHistory()).to.equal(false);
      await vault
        .connect(operator)
        .redeemCollectedEmberShares(await emberVault.getAddress(), ethers.parseUnits("100", 18));
      expect(await vault.hasActiveRedemptionHistory()).to.equal(true);
    });

    it("stays true after subsequent calls (sticky)", async function () {
      // First call flips the flag.
      await vault
        .connect(operator)
        .redeemCollectedEmberShares(await emberVault.getAddress(), ethers.parseUnits("50", 18));
      expect(await vault.hasActiveRedemptionHistory()).to.equal(true);

      // Subsequent call is idempotent on the flag.
      await vault
        .connect(operator)
        .redeemCollectedEmberShares(await emberVault.getAddress(), ethers.parseUnits("50", 18));
      expect(await vault.hasActiveRedemptionHistory()).to.equal(true);
    });
  });

  describe("collectPlatformFee — loss parameter", function () {
    beforeEach(async function () {
      // Build up accrued platform fees by running a swap (5% fee on 1000 USDC gross = 50).
      await whitelistShare();
      await vault
        .connect(alice)
        .swapEmberShares(
          await emberVault.getAddress(),
          ethers.parseUnits("1000", 18),
          alice.address,
          0n
        );
    });

    it("with loss = 0, transfers full accrued and emits lossAbsorbed = 0", async function () {
      const accrued = (await vault.platformFee()).accrued;
      expect(accrued).to.be.greaterThan(0n);

      const recipient = await protocolConfig.getPlatformFeeRecipient();
      const recipientBefore = await collateralToken.balanceOf(recipient);

      await expect(vault.connect(operator).collectPlatformFee(0n)).to.emit(
        vault,
        "VaultPlatformFeeCollected"
      );

      // Recipient received the full accrued (give or take time-based-fee re-accrual that
      // may have added a hair more during the call).
      const recipientAfter = await collateralToken.balanceOf(recipient);
      expect(recipientAfter - recipientBefore).to.be.greaterThanOrEqual(accrued);

      // Bucket settled to zero.
      expect((await vault.platformFee()).accrued).to.equal(0n);
    });

    it("loss covering most-of-accrued transfers only the tiny remainder", async function () {
      // _chargeAccruedPlatformFees() runs FIRST inside collectPlatformFee, so the
      // post-charge accrued is slightly higher than what we read here (due to time-
      // based-fee accrual over the test's elapsed seconds). Passing `loss = pre-call
      // accrued` therefore nets out almost everything; only the time-delta is paid out.
      const accruedBefore = (await vault.platformFee()).accrued;
      const recipient = await protocolConfig.getPlatformFeeRecipient();
      const recipientBefore = await collateralToken.balanceOf(recipient);

      await vault.connect(operator).collectPlatformFee(accruedBefore);

      const transferred = (await collateralToken.balanceOf(recipient)) - recipientBefore;
      // Transferred must be tiny compared to the original accrued — at most the time-
      // based fee accrual during the call.
      expect(transferred).to.be.lessThan(accruedBefore / 100n + 100n);
      // Bucket fully settled.
      expect((await vault.platformFee()).accrued).to.equal(0n);
    });

    it("with 0 < loss < accrued, transfers accrued - loss and the rest stays in vault", async function () {
      // Capture accrued BEFORE the call. The actual transferred amount may be slightly
      // higher than (accrued - loss) due to time-based fee accrual inside the function;
      // we assert the relationship holds modulo a small drift.
      const accrued = (await vault.platformFee()).accrued;
      const half = accrued / 2n;

      const recipient = await protocolConfig.getPlatformFeeRecipient();
      const recipientBefore = await collateralToken.balanceOf(recipient);

      await vault.connect(operator).collectPlatformFee(half);

      const transferred = (await collateralToken.balanceOf(recipient)) - recipientBefore;
      // At least (accrued - half) was paid out. The protocol charges some additional
      // time-based fee during the call which is also paid; assert a sane upper bound.
      expect(transferred).to.be.greaterThanOrEqual(accrued - half);
      expect(transferred).to.be.lessThanOrEqual(accrued); // never pays more than original accrued
      expect((await vault.platformFee()).accrued).to.equal(0n);
    });

    it("reverts InvalidValue when loss exceeds post-charge accrued", async function () {
      // Pre-call accrued + a generous margin > post-charge accrued — guaranteed to fail.
      const accrued = (await vault.platformFee()).accrued;
      await expect(
        vault.connect(operator).collectPlatformFee(accrued * 10n)
      ).to.be.revertedWithCustomError(vault, "InvalidValue");
    });

    // No ZeroAmount test here — `_chargeAccruedPlatformFees` ticks time-based fee accrual
    // inside the call, so even a freshly-drained vault may have a hair of accrual on the
    // next block. EmberVault has equivalent coverage for the empty-bucket revert.
  });

  // Worked example from the spec — verifies the contract math against the documented values.
  //
  //   User has 1000 EmberShares.  Share price = 1.1 USDC.  fee = 5%.  holdback = 10%.
  //   theoretical gross = 1000 * 1.1                    = 1100 USDC
  //   fee               = 5%  * 1100                    = 55 USDC
  //   holdback          = 10% * 1100                    = 110 USDC
  //   immediate net     = 1100 - 55 - 110               = 935 USDC
  //   later, unwinding_% = 90%
  //   holdback released = 110 * 90%                     = 99 USDC
  //   total user receives = 935 + 99                    = 1034 USDC (11 USDC haircut)
  describe("Worked example (1000 shares, price 1.1, 5% fee, 10% holdback, 90% unwinding)", function () {
    const SHARES = ethers.parseUnits("1000", 18);
    const FEE = ethers.parseUnits("0.05", 18);
    const HOLDBACK = ethers.parseUnits("0.10", 18);
    const UNWIND = ethers.parseUnits("0.90", 18);

    beforeEach(async function () {
      // EmberVault default rate is 1e18 (share price 1.0). To make share price 1.1, we set
      // rate = 1e18 / 1.1 ≈ 909090909090909091. Going 1e18 -> 909090909090909091 is a
      // ~9.09% change, within the 10% maxRateChangePerUpdate. Need to wait the 2h
      // rateUpdateInterval before the rate manager can update.
      await time.increase(2 * 60 * 60 + 1);

      // rate = 1e18 / 1.1, rounded to be EXACTLY representable so the share-price math
      // the test asserts against produces clean, predictable values up to ~1 wei.
      const targetRate = ethers.parseUnits("1", 18) / 11n + ethers.parseUnits("1", 18); // ≈ 909090...091
      // The expression above is wrong; compute properly:
      const newRate = (ethers.parseUnits("1", 18) * 10n) / 11n;
      await emberVault.connect(rateManager).updateVaultRate(newRate);

      // Whitelist with the example percentages. Cap is generous so the swap doesn't trip
      // the per-epoch limit.
      await vault.connect(configSigner).setEmberShareWhitelist(
        admin.address,
        await emberVault.getAddress(),
        true,
        FEE,
        ethers.parseUnits("0.9", 18), // 90% capacity
        HOLDBACK,
        ethers.parseUnits("1", 18), // 100% maxUtilization — don't gate this test
        0, // no minSwapGross floor
        0 // no absolute held-value cap
      );
    });

    it("share price is ~1.1 after the rate update", async function () {
      const gross = await emberVault.convertToAssets(SHARES);
      // 1000 * 1.1 = 1100. Tolerance for integer rounding from 1/1.1.
      expect(gross).to.be.closeTo(ethers.parseUnits("1100", 18), ethers.parseUnits("0.000001", 18));
    });

    it("immediate net at swap matches 935 USDC (gross - fee - holdback)", async function () {
      const gross = await emberVault.convertToAssets(SHARES);
      const expectedFee = (gross * FEE) / ONE; // 55 USDC at gross=1100
      const expectedHoldback = (gross * HOLDBACK) / ONE; // 110 USDC
      const expectedNet = gross - expectedFee - expectedHoldback; // 935 USDC

      // Alice may have received funds from earlier swaps in setUp/setUp peers, so capture
      // her balance just before the swap.
      const aliceBefore = await collateralToken.balanceOf(alice.address);

      await vault
        .connect(alice)
        .swapEmberShares(await emberVault.getAddress(), SHARES, alice.address, 0n);

      const received = (await collateralToken.balanceOf(alice.address)) - aliceBefore;
      expect(received).to.equal(expectedNet);

      // Sanity vs. the spec's literal values (within rounding tolerance).
      expect(received).to.be.closeTo(
        ethers.parseUnits("935", 18),
        ethers.parseUnits("0.000001", 18)
      );
    });

    it("holdback entry stores 110 USDC and fee accrues 55 USDC", async function () {
      const gross = await emberVault.convertToAssets(SHARES);
      const expectedFee = (gross * FEE) / ONE;
      const expectedHoldback = (gross * HOLDBACK) / ONE;

      const accruedBefore = (await vault.platformFee()).accrued;

      await vault
        .connect(alice)
        .swapEmberShares(await emberVault.getAddress(), SHARES, alice.address, 0n);

      const queueLen = await vault.getPendingHoldbackEntries(await emberVault.getAddress());
      expect(queueLen).to.equal(1n);

      const entry = await vault.getHoldbackEntry(await emberVault.getAddress(), 0);
      expect(entry.recipient).to.equal(alice.address);
      expect(entry.amount).to.equal(expectedHoldback);
      expect(entry.amount).to.be.closeTo(
        ethers.parseUnits("110", 18),
        ethers.parseUnits("0.000001", 18)
      );

      // Platform fee accrues at least the swap fee (time-based fee may add a tiny extra).
      const accruedAfter = (await vault.platformFee()).accrued;
      expect(accruedAfter - accruedBefore).to.be.greaterThanOrEqual(expectedFee);
      expect(expectedFee).to.be.closeTo(
        ethers.parseUnits("55", 18),
        ethers.parseUnits("0.000001", 18)
      );
    });

    it("releaseUsersHoldback at 90% pays 99 USDC and closes the entry", async function () {
      const gross = await emberVault.convertToAssets(SHARES);
      const expectedHoldback = (gross * HOLDBACK) / ONE;
      const expectedRelease = (expectedHoldback * UNWIND) / ONE;

      // Swap to create the holdback entry.
      await vault
        .connect(alice)
        .swapEmberShares(await emberVault.getAddress(), SHARES, alice.address, 0n);

      // Forward shares to EmberVault and process settlement so AL has full collateral.
      await vault
        .connect(operator)
        .redeemCollectedEmberShares(await emberVault.getAddress(), SHARES);
      await emberVault.connect(operator).processWithdrawalRequests(10n);

      const aliceBefore = await collateralToken.balanceOf(alice.address);

      // 90% unwinding — the user absorbs 11 USDC haircut on this entry.
      await vault
        .connect(operator)
        .releaseUsersHoldback(await emberVault.getAddress(), UNWIND, 10n);

      const releasedToAlice = (await collateralToken.balanceOf(alice.address)) - aliceBefore;
      expect(releasedToAlice).to.equal(expectedRelease);
      expect(releasedToAlice).to.be.closeTo(
        ethers.parseUnits("99", 18),
        ethers.parseUnits("0.000001", 18)
      );

      // Entry's released field records the actual payout for off-chain reconciliation.
      const entry = await vault.getHoldbackEntry(await emberVault.getAddress(), 0);
      expect(entry.released).to.equal(expectedRelease);

      // Queue head advanced past the entry — it is permanently closed.
      expect(await vault.getPendingHoldbackEntries(await emberVault.getAddress())).to.equal(0n);

      // Re-calling 100% does not re-open it.
      await expect(
        vault.connect(operator).releaseUsersHoldback(await emberVault.getAddress(), ONE, 10n)
      ).to.be.revertedWithCustomError(vault, "EmptyHoldbackQueue");
    });

    it("end-to-end: user nets 935 USDC at swap, gets 99 USDC at unwinding, totals 1034 USDC", async function () {
      const aliceStart = await collateralToken.balanceOf(alice.address);

      await vault
        .connect(alice)
        .swapEmberShares(await emberVault.getAddress(), SHARES, alice.address, 0n);

      await vault
        .connect(operator)
        .redeemCollectedEmberShares(await emberVault.getAddress(), SHARES);
      await emberVault.connect(operator).processWithdrawalRequests(10n);

      await vault
        .connect(operator)
        .releaseUsersHoldback(await emberVault.getAddress(), UNWIND, 10n);

      const totalReceived = (await collateralToken.balanceOf(alice.address)) - aliceStart;
      // 935 + 99 = 1034 USDC
      expect(totalReceived).to.be.closeTo(
        ethers.parseUnits("1034", 18),
        ethers.parseUnits("0.000001", 18)
      );
    });
  });

  describe("solvencyMargin (monitoring view)", function () {
    it("equals backing minus (totalAssets + accrued)", async function () {
      const vaultAddr = await vault.getAddress();
      const idle = await collateralToken.balanceOf(vaultAddr);
      const stratAssets = await vault.getStrategyAssets();
      const ta = await vault.totalAssets();
      const accrued = (await vault.platformFee()).accrued;

      const expected = idle + stratAssets - ta - accrued;
      expect(await vault.solvencyMargin()).to.equal(expected);
    });

    it("increases one-for-one when collateral is donated to the vault", async function () {
      const vaultAddr = await vault.getAddress();
      const before = await vault.solvencyMargin();

      // A direct transfer adds backing without adding shares/claims.
      const donation = ethers.parseUnits("123", 18);
      await collateralToken.connect(alice).transfer(vaultAddr, donation);

      expect(await vault.solvencyMargin()).to.equal(before + donation);
    });
  });

  describe("Ported audit fixes: A-9 slippage & L-5 setter bounds", function () {
    // ---- A-9: minNetOut slippage guard on swapEmberShares ----
    it("A-9: reverts when the net payout is below minNetOut", async function () {
      await whitelistShare(); // fee 1%, holdback 5%, empty curve (1× multiplier)
      const share = await emberVault.getAddress();
      const swapAmount = ethers.parseUnits("100", 18);

      const gross = await emberVault.convertToAssets(swapAmount);
      const fee = (gross * FEE_PCT) / ONE;
      const holdback = (gross * HOLDBACK_PCT) / ONE;
      const net = gross - fee - holdback;

      // Demanding one wei more than the actual payout must revert.
      await expect(
        vault.connect(alice).swapEmberShares(share, swapAmount, alice.address, net + 1n)
      ).to.be.revertedWithCustomError(vault, "SlippageToleranceExceeded");
    });

    it("A-9: succeeds when minNetOut equals the net payout", async function () {
      await whitelistShare();
      const share = await emberVault.getAddress();
      const swapAmount = ethers.parseUnits("100", 18);

      const gross = await emberVault.convertToAssets(swapAmount);
      const fee = (gross * FEE_PCT) / ONE;
      const holdback = (gross * HOLDBACK_PCT) / ONE;
      const net = gross - fee - holdback;

      await expect(
        vault.connect(alice).swapEmberShares(share, swapAmount, alice.address, net)
      ).to.emit(vault, "EmberShareSwapped");
    });

    // ---- L-5: strict fee-setter bounds ----
    it("L-5: rejects an instant-withdraw fee == 100%", async function () {
      await expect(
        vault.connect(configSigner).setInstantWithdrawFeePercentage(admin.address, ONE)
      ).to.be.revertedWithCustomError(vault, "InstantWithdrawFeeTooHigh");
      // Strictly below 100% is still accepted.
      await expect(
        vault
          .connect(configSigner)
          .setInstantWithdrawFeePercentage(admin.address, ethers.parseUnits("0.99", 18))
      ).to.not.be.reverted;
    });

    it("L-5: rejects whitelisting a source with a 100% base fee", async function () {
      await expect(whitelistShare({ feePct: ONE })).to.be.revertedWithCustomError(
        vault,
        "InvalidPercentage"
      );
    });
  });

  // M-3: exercises the amount-weighted, receiver-keyed anti-JIT clock math directly at the
  // validator (where the algorithm lives). AtomicLiquidity computes oldWeight = receiver's
  // prior shares + queued withdrawal shares and forwards it here; these tests pin the blend.
  describe("M-3: amount-weighted receiver-keyed anti-JIT clock (validator)", function () {
    let validator: any;
    let fakeVault: HardhatEthersSigner;
    let receiver: HardhatEthersSigner;
    const T0 = 1_000_000n; // ms
    const TF = 3_000_000n; // a far-future deposit time

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      fakeVault = signers[15];
      receiver = signers[16];
      const Factory = await ethers.getContractFactory("EmberVaultValidator");
      validator = await upgrades.deployProxy(
        Factory,
        [await protocolConfig.getAddress(), owner.address],
        { kind: "uups" }
      );
    });

    async function record(oldWeight: bigint, newShares: bigint, ts: bigint) {
      // recordWeightedDeposit requires msg.sender == the vault arg; impersonate via fakeVault.
      return validator
        .connect(fakeVault)
        .recordWeightedDeposit(fakeVault.address, receiver.address, oldWeight, newShares, ts);
    }

    it("records exactly `now` for a fresh receiver (oldWeight == 0)", async function () {
      await record(0n, 1_000_000n, T0);
      expect(await validator.lastDepositTimestamp(fakeVault.address, receiver.address)).to.equal(
        T0
      );
    });

    it("a dust deposit barely moves an aged receiver's clock (grief-resistant)", async function () {
      await record(0n, 1_000_000n, T0); // receiver now aged at T0 with weight 1e6
      await record(1_000_000n, 1n, TF); // attacker dusts 1 share at a far-future time
      const stored = await validator.lastDepositTimestamp(fakeVault.address, receiver.address);
      // Weighted clock stays essentially at T0, nowhere near the far-future TF.
      expect(stored).to.be.gte(T0);
      expect(stored).to.be.lt(T0 + 100n);
      expect(stored).to.be.lt((T0 + TF) / 2n);
    });

    it("a large fresh top-up moves the clock to the share-weighted midpoint", async function () {
      await record(0n, 1_000_000n, T0); // weight 1e6 aged at T0
      await record(1_000_000n, 1_000_000n, TF); // equal-size top-up at TF
      const stored = await validator.lastDepositTimestamp(fakeVault.address, receiver.address);
      expect(stored).to.equal((T0 + TF) / 2n); // exact midpoint
    });

    it("recordWeightedDeposit is callable only by the vault itself", async function () {
      await expect(
        validator
          .connect(receiver)
          .recordWeightedDeposit(fakeVault.address, receiver.address, 0n, 1n, T0)
      ).to.be.revertedWithCustomError(validator, "Unauthorized");
    });
  });
});
