import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  AtomicLiquidity,
  EmberProtocolConfig,
  EmberVault,
  EmberVaultValidator,
  ERC20Token,
} from "../typechain-types";
import { deployBaseSetup, deployEmberVault } from "./helpers/atomicLiquidity";

/**
 * The atomic vault's exits under a withdrawal allow-list.
 *
 * Two different lists meet on the swap path, and they answer different questions. AL's own
 * list says who may take collateral out of AL. The SOURCE vault's list says who may exit that
 * vault — and the swap is an exit from it, because AL redeems the shares as itself
 * (`redeemShares(amount, address(this))`), so the source vault never sees the account that
 * actually left. Without the source check the swap is a way around the source vault's list.
 */
describe("AtomicLiquidity - Withdrawal Allow List", function () {
  let vault: AtomicLiquidity;
  let protocolConfig: EmberProtocolConfig;
  let collateralToken: ERC20Token;
  let emberVault: EmberVault;
  let configSigner: HardhatEthersSigner;

  let alVaultValidator: EmberVaultValidator;
  let sourceValidator: EmberVaultValidator;

  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  let vaultAddr: string;
  let shareAddr: string;

  const SWAP_SHARES = ethers.parseUnits("100", 18);

  async function deployValidator(): Promise<EmberVaultValidator> {
    const v = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberVaultValidator"),
      [await protocolConfig.getAddress(), owner.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberVaultValidator;
    await v.waitForDeployment();
    return v;
  }

  const allowOnAl = (user: string, status = true) =>
    protocolConfig.connect(operator).setVaultWithdrawAllowList(vaultAddr, user, status);
  const allowOnSource = (user: string, status = true) =>
    protocolConfig.connect(operator).setVaultWithdrawAllowList(shareAddr, user, status);
  /** AL settles by redeeming as itself, so arming a source list without AL on it stops swaps. */
  const allowAlOnSource = () => allowOnSource(vaultAddr);

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, alice, bob, carol] =
      await ethers.getSigners();

    ({ vault, protocolConfig, collateralToken, configSigner } = await deployBaseSetup({
      owner,
      feeRecipient,
      admin,
      operator,
      rateManager,
      fundUsers: [alice, bob, carol],
    }));
    vaultAddr = await vault.getAddress();

    emberVault = await deployEmberVault({
      owner,
      protocolConfig,
      collateralToken,
      admin,
      operator,
      rateManager,
    });
    shareAddr = await emberVault.getAddress();

    alVaultValidator = await deployValidator();
    sourceValidator = await deployValidator();
    await protocolConfig
      .connect(admin)
      .setVaultValidator(vaultAddr, await alVaultValidator.getAddress());
    await protocolConfig
      .connect(admin)
      .setVaultValidator(shareAddr, await sourceValidator.getAddress());

    // Users hold EmberShares of the source vault, and AL holds collateral to front payouts.
    const userBalance = ethers.parseUnits("100000", 18);
    for (const u of [alice, bob, carol]) {
      await collateralToken.connect(u).approve(shareAddr, userBalance);
      await emberVault.connect(u).deposit(ethers.parseUnits("10000", 18), u.address);
      await emberVault.connect(u).approve(vaultAddr, userBalance);
    }
    await vault.connect(alice).deposit(ethers.parseUnits("50000", 18), alice.address);

    await vault
      .connect(configSigner)
      .setEmberShareWhitelist(
        admin.address,
        shareAddr,
        true,
        ethers.parseUnits("0.01", 18),
        ethers.parseUnits("0.2", 18),
        ethers.parseUnits("0.05", 18),
        ethers.parseUnits("1", 18),
        0,
        0
      );
  });

  const swap = (from: HardhatEthersSigner, receiver: string) =>
    vault.connect(from).swapEmberShares(shareAddr, SWAP_SHARES, receiver, 0);

  it("declares that it enforces the list, so the config will record one", async function () {
    expect(await vault.enforcesWithdrawAllowList()).to.be.true;
    await expect(allowOnAl(alice.address)).to.not.be.reverted;
  });

  describe("Swap — source vault's list", function () {
    it("leaves the swap open while the source list is empty", async function () {
      expect(await sourceValidator.withdrawAllowListCount(shareAddr)).to.equal(0n);
      await expect(swap(bob, bob.address)).to.emit(vault, "EmberShareSwapped");
    });

    it("blocks a swapper who may not exit the source vault", async function () {
      // One listed account is enough to arm the source list; bob is not on it.
      await allowAlOnSource();
      await allowOnSource(alice.address);
      await expect(swap(bob, bob.address)).to.be.revertedWithCustomError(
        vault,
        "WithdrawNotAllowed"
      );
    });

    it("blocks paying out to a receiver who may not exit the source vault", async function () {
      await allowAlOnSource();
      await allowOnSource(bob.address);
      await expect(swap(bob, carol.address)).to.be.revertedWithCustomError(
        vault,
        "WithdrawNotAllowed"
      );
    });

    it("allows a listed owner swapping to a listed receiver", async function () {
      await allowAlOnSource();
      await allowOnSource(bob.address);
      await allowOnSource(carol.address);
      await expect(swap(bob, carol.address)).to.emit(vault, "EmberShareSwapped");
    });

    it("blocks the swap when AL itself may not exit the source", async function () {
      // AL settles with `redeemShares(amount, address(this))`, so a source list that excludes AL
      // makes settlement impossible. Accepting the swap anyway would pay real collateral for
      // shares `redeemCollectedEmberShares` can never redeem — a one-way drain, one swap at a
      // time. Bob is listed on the source; only AL is missing.
      await allowOnSource(bob.address);
      await expect(swap(bob, bob.address)).to.be.revertedWithCustomError(
        vault,
        "WithdrawNotAllowed"
      );

      // Listing AL unblocks it without touching bob's own listing.
      await allowAlOnSource();
      await expect(swap(bob, bob.address)).to.emit(vault, "EmberShareSwapped");
    });

    it("stays open when the source vault has no validator at all", async function () {
      await protocolConfig.connect(admin).setVaultValidator(shareAddr, ethers.ZeroAddress);
      await expect(swap(bob, bob.address)).to.emit(vault, "EmberShareSwapped");
    });
  });

  describe("Swap — AL's own list", function () {
    it("blocks a swapper who may not withdraw from AL", async function () {
      await allowOnAl(alice.address);
      await expect(swap(bob, bob.address)).to.be.revertedWithCustomError(
        vault,
        "WithdrawNotAllowed"
      );
    });

    it("allows the swap once the swapper and receiver are both listed on AL", async function () {
      await allowOnAl(bob.address);
      await allowOnAl(carol.address);
      await expect(swap(bob, carol.address)).to.emit(vault, "EmberShareSwapped");
    });
  });

  // The two lists are ANDed, not chained: neither is a fallback for the other. Each is
  // independently permissive while empty, which is what makes an empty list look like a
  // fallback from the outside — it abstains rather than deferring.
  describe("Swap — how the two lists combine", function () {
    it("both empty: open", async function () {
      await expect(swap(bob, bob.address)).to.emit(vault, "EmberShareSwapped");
    });

    it("source empty, AL armed: AL's list alone decides", async function () {
      await allowOnAl(bob.address);
      await expect(swap(bob, bob.address)).to.emit(vault, "EmberShareSwapped");
      await expect(swap(carol, carol.address)).to.be.revertedWithCustomError(
        vault,
        "WithdrawNotAllowed"
      );
    });

    it("AL empty, source armed: the source's list alone decides", async function () {
      await allowAlOnSource();
      await allowOnSource(bob.address);
      await expect(swap(bob, bob.address)).to.emit(vault, "EmberShareSwapped");
      await expect(swap(carol, carol.address)).to.be.revertedWithCustomError(
        vault,
        "WithdrawNotAllowed"
      );
    });

    it("both armed: on the source but NOT on AL is still blocked", async function () {
      await allowAlOnSource();
      await allowOnSource(bob.address);
      await allowOnAl(carol.address); // arms AL's list without listing bob
      await expect(swap(bob, bob.address)).to.be.revertedWithCustomError(
        vault,
        "WithdrawNotAllowed"
      );
    });

    it("both armed: on AL but NOT on the source is still blocked", async function () {
      await allowOnAl(bob.address);
      await allowAlOnSource();
      await allowOnSource(carol.address); // arms the source list without listing bob
      await expect(swap(bob, bob.address)).to.be.revertedWithCustomError(
        vault,
        "WithdrawNotAllowed"
      );
    });

    it("both armed: on both lists passes", async function () {
      await allowAlOnSource();
      await allowOnSource(bob.address);
      await allowOnAl(bob.address);
      await expect(swap(bob, bob.address)).to.emit(vault, "EmberShareSwapped");
    });
  });

  describe("Misconfigured validator", function () {
    it("fails closed when AL's validator address has no code", async function () {
      // A staticcall to a codeless address succeeds returning nothing, so treating that as
      // allowed would silently disable the list on a fat-fingered setVaultValidator.
      await protocolConfig.connect(admin).setVaultValidator(vaultAddr, bob.address);
      await expect(
        vault.connect(alice).redeemShares(ethers.parseUnits("10", 18), alice.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawNotAllowed");
    });

    it("fails closed on the swap when the SOURCE validator has no code", async function () {
      await protocolConfig.connect(admin).setVaultValidator(shareAddr, bob.address);
      await expect(swap(bob, bob.address)).to.be.revertedWithCustomError(
        vault,
        "WithdrawNotAllowed"
      );
    });
  });

  describe("AL's other exits", function () {
    it("blocks redeemShares for an unlisted owner", async function () {
      await allowOnAl(carol.address);
      await expect(
        vault.connect(alice).redeemShares(ethers.parseUnits("10", 18), alice.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawNotAllowed");
    });

    it("blocks redeemShares paying out to an unlisted receiver", async function () {
      await allowOnAl(alice.address);
      await expect(
        vault.connect(alice).redeemShares(ethers.parseUnits("10", 18), bob.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawNotAllowed");
    });

    it("blocks instantWithdraw for an unlisted caller", async function () {
      await vault
        .connect(configSigner)
        .setMaxInstantWithdrawShares(admin.address, ethers.parseUnits("1000", 18));
      await allowOnAl(carol.address);
      await expect(
        vault.connect(alice).instantWithdraw(ethers.parseUnits("10", 18), alice.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawNotAllowed");
    });

    it("skips a queued request whose owner was delisted after queueing", async function () {
      // Queue while the list is still empty, so the request itself is valid when made.
      const shares = ethers.parseUnits("10", 18);
      await vault.connect(alice).redeemShares(shares, alice.address);

      const sharesBefore = await vault.balanceOf(alice.address);
      // Arming the list with someone else delists alice.
      await allowOnAl(carol.address);

      await expect(vault.connect(operator).processWithdrawalRequests(1)).to.not.be.reverted;

      // Skipped, not reverted: the shares come back and the queue advances rather than
      // wedging behind the delisted account.
      expect(await vault.balanceOf(alice.address)).to.equal(sharesBefore + shares);
    });
  });
});
