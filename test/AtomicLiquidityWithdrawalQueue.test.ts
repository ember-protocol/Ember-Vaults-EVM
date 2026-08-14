import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { AtomicLiquidity, EmberProtocolConfig, ERC20Token } from "../typechain-types";
import { deployBaseSetup } from "./helpers/atomicLiquidity";

// Direct coverage for AtomicLiquidity's OWN request-based withdrawal queue
// (deposit -> redeemShares -> processWithdrawalRequests, plus skip/cancel). This path had no
// prior tests; it guards the `_processRequest` settlement logic (and its later extraction).
describe("AtomicLiquidity - withdrawal queue (redeem/process)", function () {
  let vault: AtomicLiquidity;
  let protocolConfig: EmberProtocolConfig;
  let collateralToken: ERC20Token;

  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner; // withdrawal receiver

  const DEPOSIT = ethers.parseUnits("1000", 18);
  const REDEEM = ethers.parseUnits("400", 18); // rate 1:1 -> 400 collateral

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, alice, bob] = await ethers.getSigners();

    ({ vault, protocolConfig, collateralToken } = await deployBaseSetup({
      owner,
      feeRecipient,
      admin,
      operator,
      rateManager,
      fundUsers: [alice],
    }));

    // alice deposits collateral into AL and receives AL shares (rate 1:1, default).
    await vault.connect(alice).deposit(DEPOSIT, alice.address);
  });

  it("settles a request: pays the receiver, burns shares, clears bookkeeping", async function () {
    await vault.connect(alice).redeemShares(REDEEM, bob.address);

    // At redeem: alice's shares move into the pending-burn pool; totals not yet burned.
    expect(await vault.shareOf(alice.address)).to.equal(DEPOSIT - REDEEM);
    expect(await vault.pendingBurnShares()).to.equal(REDEEM);
    expect(await vault.totalShares()).to.equal(DEPOSIT);

    const bobBefore = await collateralToken.balanceOf(bob.address);
    await vault.connect(operator).processWithdrawalRequests(1);

    // Receiver paid the full amount (no validator => no withdrawal fee), shares burned.
    expect((await collateralToken.balanceOf(bob.address)) - bobBefore).to.equal(REDEEM);
    expect(await vault.totalShares()).to.equal(DEPOSIT - REDEEM);
    expect(await vault.pendingBurnShares()).to.equal(0n);

    const [pendingShares, pendingSeqs] = await vault.getAccountState(alice.address);
    expect(pendingShares).to.equal(0n);
    expect(pendingSeqs.length).to.equal(0);
  });

  it("skips a blacklisted receiver and returns the shares to the owner", async function () {
    await vault.connect(alice).redeemShares(REDEEM, bob.address);
    await protocolConfig.connect(owner).setBlacklistedAccount(bob.address, true);

    const bobBefore = await collateralToken.balanceOf(bob.address);
    await vault.connect(operator).processWithdrawalRequests(1);

    // Nothing paid; parked shares returned to the owner; total supply unchanged.
    expect(await collateralToken.balanceOf(bob.address)).to.equal(bobBefore);
    expect(await vault.shareOf(alice.address)).to.equal(DEPOSIT);
    expect(await vault.totalShares()).to.equal(DEPOSIT);
    expect(await vault.pendingBurnShares()).to.equal(0n);
    expect((await vault.getAccountState(alice.address))[0]).to.equal(0n);
  });

  it("skips a cancelled request and returns the shares to the owner", async function () {
    await vault.connect(alice).redeemShares(REDEEM, bob.address);

    // Cancel by the request's sequence number (read from the owner's pending list).
    const [, pendingSeqs] = await vault.getAccountState(alice.address);
    await vault.connect(alice).cancelPendingWithdrawalRequest(pendingSeqs[0]);

    const bobBefore = await collateralToken.balanceOf(bob.address);
    await vault.connect(operator).processWithdrawalRequests(1);

    expect(await collateralToken.balanceOf(bob.address)).to.equal(bobBefore);
    expect(await vault.shareOf(alice.address)).to.equal(DEPOSIT);
    expect(await vault.totalShares()).to.equal(DEPOSIT);
    expect(await vault.pendingBurnShares()).to.equal(0n);
    const [pendingShares, pendingSeqs2, cancelSeqs] = await vault.getAccountState(alice.address);
    expect(pendingShares).to.equal(0n);
    expect(pendingSeqs2.length).to.equal(0);
    expect(cancelSeqs.length).to.equal(0);
  });

  it("processes a FIFO batch of mixed requests in one call", async function () {
    const R = ethers.parseUnits("300", 18); // 3 * 300 = 900 <= 1000 deposit

    // Three requests: two to bob (will be skipped), one to alice (will settle).
    await vault.connect(alice).redeemShares(R, bob.address);
    await vault.connect(alice).redeemShares(R, alice.address);
    await vault.connect(alice).redeemShares(R, bob.address);

    expect(await vault.pendingBurnShares()).to.equal(R * 3n);

    // Blacklist bob, so both bob-receiver requests skip and only alice's settles.
    await protocolConfig.connect(owner).setBlacklistedAccount(bob.address, true);

    const bobBefore = await collateralToken.balanceOf(bob.address);
    const aliceCollBefore = await collateralToken.balanceOf(alice.address);

    await vault.connect(operator).processWithdrawalRequests(3);

    // Two bob requests skipped (no payout), alice request settled (paid R).
    expect(await collateralToken.balanceOf(bob.address)).to.equal(bobBefore);
    expect((await collateralToken.balanceOf(alice.address)) - aliceCollBefore).to.equal(R);

    // Only the settled request burned shares; the two skipped returned to alice.
    expect(await vault.totalShares()).to.equal(DEPOSIT - R);
    expect(await vault.pendingBurnShares()).to.equal(0n);
    // alice had DEPOSIT-3R after redeems; +2R returned (skipped) = DEPOSIT-R.
    expect(await vault.shareOf(alice.address)).to.equal(DEPOSIT - R);
  });
});
