import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  EmberETHVault,
  EmberProtocolConfig,
  MockWETH,
  ConfigurableETHReceiver,
} from "../typechain-types";

// Regression coverage for the ETH-vault withdrawal-queue resilience fix: a payout to a
// receiver that rejects ETH must NOT revert the batch and wedge the FIFO tail. It is
// escrowed as a claimable ETH balance instead.
describe("EmberETHVault - withdrawal transfer deferral", function () {
  let vault: EmberETHVault;
  let protocolConfig: EmberProtocolConfig;
  let weth: MockWETH;
  let rejecter: ConfigurableETHReceiver;

  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  const ONE = ethers.parseUnits("1", 18);
  const REDEEM = ethers.parseUnits("2", 18); // rate 1:1, no fee -> 2 ETH owed

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, user] = await ethers.getSigners();

    const configFactory = await ethers.getContractFactory("EmberProtocolConfig");
    protocolConfig = (await upgrades.deployProxy(
      configFactory,
      [owner.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberProtocolConfig;
    await protocolConfig.waitForDeployment();

    const wethFactory = await ethers.getContractFactory("MockWETH");
    weth = (await wethFactory.deploy()) as unknown as MockWETH;
    await weth.waitForDeployment();

    const feeLib = await (await ethers.getContractFactory("VaultPlatformFeeLib")).deploy();
    await feeLib.waitForDeployment();
    const queueLib = await (await ethers.getContractFactory("WithdrawalQueueLib")).deploy();
    await queueLib.waitForDeployment();
    const vaultFactory = await ethers.getContractFactory("EmberETHVault", {
      libraries: {
        VaultPlatformFeeLib: await feeLib.getAddress(),
        WithdrawalQueueLib: await queueLib.getAddress(),
      },
    });
    const initParams = {
      name: "Ember ETH Vault",
      receiptTokenSymbol: "eETH",
      collateralToken: await weth.getAddress(),
      admin: admin.address,
      operator: operator.address,
      rateManager: rateManager.address,
      maxRateChangePerUpdate: ethers.parseUnits("0.1", 18),
      feePercentage: 0n,
      minWithdrawableShares: ONE,
      rateUpdateInterval: 2 * 60 * 60 * 1000,
      maxTVL: ethers.parseUnits("1000000", 18),
    };
    vault = (await upgrades.deployProxy(
      vaultFactory,
      [await protocolConfig.getAddress(), owner.address, initParams, []],
      { initializer: "initialize", kind: "uups", unsafeAllowLinkedLibraries: true }
    )) as unknown as EmberETHVault;
    await vault.waitForDeployment();

    // user deposits 5 ETH -> 5 shares (rate 1:1).
    await vault.connect(user).depositETH(user.address, { value: ethers.parseUnits("5", 18) });

    rejecter = (await (
      await ethers.getContractFactory("ConfigurableETHReceiver")
    ).deploy()) as unknown as ConfigurableETHReceiver;
    await rejecter.waitForDeployment();
    expect(await rejecter.accept()).to.equal(false); // starts rejecting ETH

    // user redeems 2 shares to the rejecting receiver.
    await vault.connect(user).approve(await vault.getAddress(), REDEEM);
    await vault.connect(user).redeemShares(REDEEM, await rejecter.getAddress());
  });

  it("escrows the payout and advances the queue instead of reverting", async function () {
    const rejAddr = await rejecter.getAddress();

    await expect(vault.connect(operator).processWithdrawalRequests(1))
      .to.emit(vault, "WithdrawalDeferred")
      .withArgs(rejAddr, anyValue, REDEEM);

    // Queue drained (head advanced past the request) — tail not wedged.
    expect(await vault.getPendingWithdrawalsLength()).to.equal(0n);
    expect(await vault.unclaimedWithdrawals(rejAddr)).to.equal(REDEEM);
  });

  it("delivers the escrowed ETH once the receiver accepts again", async function () {
    const rejAddr = await rejecter.getAddress();

    await vault.connect(operator).processWithdrawalRequests(1);

    // While still rejecting, the push reverts and the balance stays claimable.
    await expect(vault.connect(operator).claimWithdrawalFor(rejAddr)).to.be.revertedWithCustomError(
      vault,
      "ETHTransferFailed"
    );
    expect(await vault.unclaimedWithdrawals(rejAddr)).to.equal(REDEEM);

    // Receiver starts accepting; claim now delivers.
    await rejecter.setAccept(true);
    const before = await ethers.provider.getBalance(rejAddr);
    await expect(vault.connect(operator).claimWithdrawalFor(rejAddr))
      .to.emit(vault, "WithdrawalClaimed")
      .withArgs(rejAddr, rejAddr, REDEEM, anyValue, anyValue);

    expect((await ethers.provider.getBalance(rejAddr)) - before).to.equal(REDEEM);
    expect(await vault.unclaimedWithdrawals(rejAddr)).to.equal(0n);
  });

  it("reverts claimWithdrawal when nothing is owed", async function () {
    await expect(vault.connect(user).claimWithdrawal()).to.be.revertedWithCustomError(
      vault,
      "ZeroAmount"
    );
  });

  // A receiver that can transact but cannot RECEIVE ETH redirects its own escrow to a payable
  // address via claimWithdrawalTo — no privilege needed (it only moves its own balance).
  it("receiver redirects its own escrow to a payable address (claimWithdrawalTo)", async function () {
    const rejAddr = await rejecter.getAddress();
    await vault.connect(operator).processWithdrawalRequests(1); // -> escrowed to rejecter
    expect(await vault.unclaimedWithdrawals(rejAddr)).to.equal(REDEEM);

    const dest = ethers.Wallet.createRandom().address; // fresh payable EOA
    const before = await ethers.provider.getBalance(dest);

    // The rejecter (still rejecting ETH) calls claimWithdrawalTo(dest) on its own behalf.
    const data = vault.interface.encodeFunctionData("claimWithdrawalTo", [dest]);
    await expect(rejecter.callTarget(await vault.getAddress(), data))
      .to.emit(vault, "WithdrawalClaimed")
      .withArgs(rejAddr, dest, REDEEM, anyValue, anyValue);

    expect((await ethers.provider.getBalance(dest)) - before).to.equal(REDEEM);
    expect(await vault.unclaimedWithdrawals(rejAddr)).to.equal(0n);
  });

  it("claimWithdrawalTo rejects a zero destination", async function () {
    await vault.connect(operator).processWithdrawalRequests(1);
    const data = vault.interface.encodeFunctionData("claimWithdrawalTo", [ethers.ZeroAddress]);
    // The inner ZeroAddress revert bubbles up as the mock's "call failed".
    await expect(rejecter.callTarget(await vault.getAddress(), data)).to.be.reverted;
  });

  // A permanently-stuck escrow (receiver can neither receive ETH nor call claimWithdrawalTo) is
  // rescued by the owner (the timelock in production) to a good address — otherwise it'd be locked
  // forever, since the plain claim can only ever push back to the unpayable receiver.
  it("owner recovers a permanently-stuck escrow (recoverUnclaimedWithdrawal)", async function () {
    const rejAddr = await rejecter.getAddress();
    await vault.connect(operator).processWithdrawalRequests(1);
    expect(await vault.unclaimedWithdrawals(rejAddr)).to.equal(REDEEM);

    const dest = ethers.Wallet.createRandom().address;
    const before = await ethers.provider.getBalance(dest);

    await expect(vault.connect(owner).recoverUnclaimedWithdrawal(rejAddr, dest))
      .to.emit(vault, "WithdrawalClaimed")
      .withArgs(rejAddr, dest, REDEEM, anyValue, anyValue);

    expect((await ethers.provider.getBalance(dest)) - before).to.equal(REDEEM);
    expect(await vault.unclaimedWithdrawals(rejAddr)).to.equal(0n);
  });

  it("recoverUnclaimedWithdrawal is owner-only and validates inputs", async function () {
    const rejAddr = await rejecter.getAddress();
    await vault.connect(operator).processWithdrawalRequests(1);

    // Non-owner callers (operator, admin, user) are rejected.
    for (const caller of [operator, admin, user]) {
      await expect(
        vault.connect(caller).recoverUnclaimedWithdrawal(rejAddr, user.address)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    }
    // Zero destination rejected.
    await expect(
      vault.connect(owner).recoverUnclaimedWithdrawal(rejAddr, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    // Nothing owed for an address with no escrow.
    await expect(
      vault.connect(owner).recoverUnclaimedWithdrawal(user.address, user.address)
    ).to.be.revertedWithCustomError(vault, "ZeroAmount");
  });
});
