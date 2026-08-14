import { expect } from "chai";
import { ethers } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  AtomicLiquidity,
  EmberProtocolConfig,
  EmberVault,
  ERC20Token,
  BlocklistableERC20,
} from "../typechain-types";
import { deployBaseSetup, deployEmberVault } from "./helpers/atomicLiquidity";

// Regression coverage for the holdback-release resilience fix: a holdback payout to a
// recipient that has become unpayable (e.g. a blocklisted USDC address) must NOT revert the
// batch and wedge the FIFO tail. It is escrowed as a claimable balance instead.
describe("AtomicLiquidity - holdback transfer deferral", function () {
  let vault: AtomicLiquidity;
  let protocolConfig: EmberProtocolConfig;
  let collateralToken: ERC20Token;
  let collateral: BlocklistableERC20;
  let emberVault: EmberVault;
  let configSigner: HardhatEthersSigner;

  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let blocked: HardhatEthersSigner;

  const ONE = ethers.parseUnits("1", 18);
  const HOLDBACK_PCT = ethers.parseUnits("0.05", 18); // 5%
  const SWAP_SHARES = ethers.parseUnits("100", 18); // gross 100 -> holdback 5
  const EXPECTED_HOLDBACK = ethers.parseUnits("5", 18);

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, alice, blocked] = await ethers.getSigners();

    ({ vault, protocolConfig, collateralToken, configSigner } = await deployBaseSetup({
      owner,
      feeRecipient,
      admin,
      operator,
      rateManager,
      fundUsers: [alice],
      collateralFactoryName: "BlocklistableERC20",
    }));

    collateral = (await ethers.getContractAt(
      "BlocklistableERC20",
      await collateralToken.getAddress()
    )) as unknown as BlocklistableERC20;

    emberVault = await deployEmberVault({
      owner,
      protocolConfig,
      collateralToken,
      admin,
      operator,
      rateManager,
    });

    await collateralToken
      .connect(alice)
      .approve(await emberVault.getAddress(), ethers.parseUnits("100000", 18));
    await emberVault.connect(alice).deposit(ethers.parseUnits("10000", 18), alice.address);

    // Seed AL with liquidity to front the swap net + holdback payouts.
    await vault.connect(alice).deposit(ethers.parseUnits("50000", 18), alice.address);
    await emberVault
      .connect(alice)
      .approve(await vault.getAddress(), ethers.parseUnits("100000", 18));

    await vault.connect(configSigner).setEmberShareWhitelist(
      admin.address,
      await emberVault.getAddress(),
      true,
      ethers.parseUnits("0.01", 18),
      ethers.parseUnits("0.2", 18),
      HOLDBACK_PCT,
      ONE,
      0, // minSwapGross (disabled) — added on this branch
      0 // maxHeldValueAbsolute (disabled) — added on this branch
    );

    // alice swaps, naming `blocked` as the holdback recipient (still payable at this point).
    await vault
      .connect(alice)
      .swapEmberShares(await emberVault.getAddress(), SWAP_SHARES, blocked.address, 0n);
  });

  it("escrows the payout and advances the queue instead of reverting", async function () {
    const shareAddr = await emberVault.getAddress();
    const entry = await vault.getHoldbackEntry(shareAddr, 0);
    expect(entry.amount).to.equal(EXPECTED_HOLDBACK);

    // Block the recipient: a real USDC transfer to it would now revert.
    await collateral.connect(owner).setBlocked(blocked.address, true);

    // Release at 100% must NOT revert; the undeliverable payout is escrowed.
    await expect(vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 10n))
      .to.emit(vault, "HoldbackTransferDeferred")
      .withArgs(
        await vault.getAddress(),
        shareAddr,
        blocked.address,
        0n,
        EXPECTED_HOLDBACK,
        // swapSequenceNumber links the deferral back to the swap that created the entry.
        entry.sequenceNumber,
        anyValue, // timestamp
        anyValue // release sequenceNumber
      );

    // Queue head advanced past the entry — the tail is not wedged.
    expect(await vault.holdbackQueueStartIndex(shareAddr)).to.equal(1n);
    expect(await vault.getPendingHoldbackEntries(shareAddr)).to.equal(0n);
    // Entry recorded as settled; funds are claimable.
    expect((await vault.getHoldbackEntry(shareAddr, 0)).released).to.equal(EXPECTED_HOLDBACK);
    expect(await vault.unclaimedHoldback(blocked.address)).to.equal(EXPECTED_HOLDBACK);
  });

  it("blocks the claim while the recipient is still unpayable", async function () {
    const shareAddr = await emberVault.getAddress();
    await collateral.connect(owner).setBlocked(blocked.address, true);
    await vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 10n);

    // Still blocked: pushing the claim reverts (balance stays claimable).
    await expect(
      vault.connect(operator).claimHoldbackFor(blocked.address)
    ).to.be.revertedWithCustomError(collateral, "AddressBlocked");
    expect(await vault.unclaimedHoldback(blocked.address)).to.equal(EXPECTED_HOLDBACK);
  });

  it("delivers the escrowed payout once the recipient is payable again", async function () {
    const shareAddr = await emberVault.getAddress();
    await collateral.connect(owner).setBlocked(blocked.address, true);
    await vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 10n);

    await collateral.connect(owner).setBlocked(blocked.address, false);
    const before = await collateralToken.balanceOf(blocked.address);

    await expect(vault.connect(operator).claimHoldbackFor(blocked.address))
      .to.emit(vault, "HoldbackClaimed")
      .withArgs(
        await vault.getAddress(),
        blocked.address,
        blocked.address, // to == recipient for a normal claim
        EXPECTED_HOLDBACK,
        anyValue, // timestamp
        anyValue // sequenceNumber
      );

    expect((await collateralToken.balanceOf(blocked.address)) - before).to.equal(EXPECTED_HOLDBACK);
    expect(await vault.unclaimedHoldback(blocked.address)).to.equal(0n);
  });

  it("reverts claimHoldback when nothing is owed", async function () {
    await expect(vault.connect(alice).claimHoldback()).to.be.revertedWithCustomError(
      vault,
      "ZeroAmount"
    );
  });

  // A recipient that can transact but can't receive the collateral token redirects its own
  // escrow to a payable address — no privilege needed (only moves its own balance).
  it("recipient redirects its own escrow via claimHoldbackTo", async function () {
    const shareAddr = await emberVault.getAddress();
    await collateral.connect(owner).setBlocked(blocked.address, true);
    await vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 10n);
    expect(await vault.unclaimedHoldback(blocked.address)).to.equal(EXPECTED_HOLDBACK);

    const before = await collateralToken.balanceOf(alice.address); // alice is not blocked
    await expect(vault.connect(blocked).claimHoldbackTo(alice.address))
      .to.emit(vault, "HoldbackClaimed")
      .withArgs(
        await vault.getAddress(),
        blocked.address,
        alice.address,
        EXPECTED_HOLDBACK,
        anyValue,
        anyValue
      );

    expect((await collateralToken.balanceOf(alice.address)) - before).to.equal(EXPECTED_HOLDBACK);
    expect(await vault.unclaimedHoldback(blocked.address)).to.equal(0n);
  });

  // A permanently-stuck escrow (recipient can neither receive the token nor call claimHoldbackTo)
  // is rescued by the owner (the timelock in production) — otherwise it'd be locked forever.
  it("owner recovers a permanently-stuck escrow via recoverUnclaimedHoldback", async function () {
    const shareAddr = await emberVault.getAddress();
    await collateral.connect(owner).setBlocked(blocked.address, true);
    await vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 10n);

    const before = await collateralToken.balanceOf(alice.address);
    await expect(vault.connect(owner).recoverUnclaimedHoldback(blocked.address, alice.address))
      .to.emit(vault, "HoldbackClaimed")
      .withArgs(
        await vault.getAddress(),
        blocked.address,
        alice.address,
        EXPECTED_HOLDBACK,
        anyValue,
        anyValue
      );

    expect((await collateralToken.balanceOf(alice.address)) - before).to.equal(EXPECTED_HOLDBACK);
    expect(await vault.unclaimedHoldback(blocked.address)).to.equal(0n);
  });

  it("recoverUnclaimedHoldback is owner-only and validates inputs", async function () {
    const shareAddr = await emberVault.getAddress();
    await collateral.connect(owner).setBlocked(blocked.address, true);
    await vault.connect(operator).releaseUsersHoldback(shareAddr, ONE, 10n);

    for (const caller of [operator, admin, alice]) {
      await expect(
        vault.connect(caller).recoverUnclaimedHoldback(blocked.address, alice.address)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    }
    await expect(
      vault.connect(owner).recoverUnclaimedHoldback(blocked.address, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    await expect(
      vault.connect(owner).recoverUnclaimedHoldback(alice.address, alice.address)
    ).to.be.revertedWithCustomError(vault, "ZeroAmount");
  });
});
