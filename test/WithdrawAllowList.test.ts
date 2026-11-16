import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { EmberVault, EmberProtocolConfig, ERC20Token } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// The deposit allow-list gated entry only: an allow-listed depositor could transfer their shares
// to anyone, and that address could redeem. The withdrawal allow-list closes the exit side, with
// the same rule as the deposit list — an empty list leaves the vault open.
describe("EmberVault - withdrawal allow-list", function () {
  let vault: EmberVault;
  let protocolConfig: EmberProtocolConfig;
  let validator: any;
  let collateralToken: ERC20Token;
  let vaultAddr: string;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  const DEPOSIT = ethers.parseUnits("1000", 18);
  const REDEEM = ethers.parseUnits("10", 18);

  async function redeem(from: HardhatEthersSigner, receiver: string, shares = REDEEM) {
    await vault.connect(from).approve(vaultAddr, shares);
    return vault.connect(from).redeemShares(shares, receiver);
  }

  async function allowWithdraw(user: string, status = true) {
    return protocolConfig.connect(operator).setVaultWithdrawAllowList(vaultAddr, user, status);
  }

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, alice, bob, carol] =
      await ethers.getSigners();

    protocolConfig = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberProtocolConfig"),
      [owner.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberProtocolConfig;

    collateralToken = (await upgrades.deployProxy(
      await ethers.getContractFactory("ERC20Token"),
      [owner.address, "Collateral Token", "COLL", 18, ethers.parseUnits("10000000", 18)],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as ERC20Token;

    vault = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberVault"),
      [
        await protocolConfig.getAddress(),
        owner.address,
        {
          name: "Allow-listed Vault",
          receiptTokenSymbol: "ALV",
          collateralToken: await collateralToken.getAddress(),
          admin: admin.address,
          operator: operator.address,
          rateManager: rateManager.address,
          maxRateChangePerUpdate: ethers.parseUnits("0.1", 18),
          feePercentage: 0n,
          minWithdrawableShares: ethers.parseUnits("1", 18),
          rateUpdateInterval: 2 * 60 * 60 * 1000,
          maxTVL: ethers.parseUnits("1000000", 18),
        },
        [],
      ],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberVault;
    vaultAddr = await vault.getAddress();

    validator = await upgrades.deployProxy(
      await ethers.getContractFactory("EmberVaultValidator"),
      [await protocolConfig.getAddress(), owner.address],
      { initializer: "initialize", kind: "uups" }
    );
    await protocolConfig.connect(admin).setVaultValidator(vaultAddr, await validator.getAddress());

    await collateralToken.connect(owner).transfer(alice.address, ethers.parseUnits("100000", 18));
    await collateralToken.connect(alice).approve(vaultAddr, DEPOSIT);
    await vault.connect(alice).deposit(DEPOSIT, alice.address);
  });

  it("leaves withdrawals open while the list is empty", async function () {
    expect(await validator.withdrawAllowListCount(vaultAddr)).to.equal(0n);
    await expect(redeem(alice, bob.address)).to.emit(vault, "RequestRedeemed");
  });

  it("lets a listed owner redeem to a listed receiver", async function () {
    await allowWithdraw(alice.address);
    await allowWithdraw(bob.address);
    await expect(redeem(alice, bob.address)).to.emit(vault, "RequestRedeemed");
  });

  it("rejects a listed owner paying out to an unlisted receiver", async function () {
    await allowWithdraw(alice.address);
    await expect(redeem(alice, bob.address)).to.be.revertedWithCustomError(
      vault,
      "WithdrawNotAllowed"
    );
  });

  // The bypass in the ticket: shares transferred to an unlisted address can no longer exit, even
  // to a listed receiver.
  it("rejects an unlisted holder who received shares by transfer", async function () {
    await allowWithdraw(alice.address);
    await vault.connect(alice).transfer(carol.address, REDEEM);

    await expect(redeem(carol, alice.address)).to.be.revertedWithCustomError(
      vault,
      "WithdrawNotAllowed"
    );
  });

  it("reopens withdrawals when the last entry is removed", async function () {
    await allowWithdraw(alice.address);
    await allowWithdraw(alice.address, false);
    expect(await validator.withdrawAllowListCount(vaultAddr)).to.equal(0n);
    await expect(redeem(alice, bob.address)).to.emit(vault, "RequestRedeemed");
  });

  it("is independent of the deposit allow-list", async function () {
    await protocolConfig.connect(operator).setVaultDepositAllowList(vaultAddr, carol.address, true);
    await expect(redeem(alice, bob.address)).to.emit(vault, "RequestRedeemed");
  });

  it("does nothing on a vault with no validator", async function () {
    await protocolConfig.connect(admin).setVaultValidator(vaultAddr, ethers.ZeroAddress);
    await expect(redeem(alice, bob.address)).to.emit(vault, "RequestRedeemed");
  });

  // The blacklist is re-checked when a queued request is processed, because an address can be
  // blacklisted after queuing. The allow-list has the same gap, so it is re-checked the same way.
  it("skips a queued request whose receiver was removed before processing", async function () {
    await allowWithdraw(alice.address);
    await allowWithdraw(bob.address);
    await redeem(alice, bob.address);
    const sharesBefore = await vault.balanceOf(alice.address);
    const bobCollateralBefore = await collateralToken.balanceOf(bob.address);

    await allowWithdraw(bob.address, false);
    await vault.connect(operator).processWithdrawalRequests(1);

    // Skipped like a blacklisted request: shares go back to the owner, nothing is paid out.
    expect(await vault.balanceOf(alice.address)).to.equal(sharesBefore + REDEEM);
    expect(await collateralToken.balanceOf(bob.address)).to.equal(bobCollateralBefore);
  });

  // A vault can be upgraded before its validator. The old validator has no validateWithdraw, so
  // the call reverts with no data; nothing can be listed on it, so redemptions must keep working.
  it("keeps redemptions open on a validator that predates the list", async function () {
    const legacy = await (await ethers.getContractFactory("PreWithdrawListValidatorStub")).deploy();
    await protocolConfig.connect(admin).setVaultValidator(vaultAddr, await legacy.getAddress());

    await expect(redeem(alice, bob.address)).to.emit(vault, "RequestRedeemed");
    await expect(vault.connect(operator).processWithdrawalRequests(1)).to.emit(
      vault,
      "RequestProcessed"
    );
  });

  it("fails closed when the validator address has no code", async function () {
    // A staticcall to a codeless address SUCCEEDS returning nothing, so reading that as "allowed"
    // would let a `vaultValidator` set to an EOA — or a proxy whose implementation is gone —
    // silently disable the list while it reads as populated. Blocking is loud and reversible;
    // silently opening is neither.
    await allowWithdraw(alice.address);
    await protocolConfig.connect(admin).setVaultValidator(vaultAddr, bob.address);

    await expect(redeem(alice, alice.address)).to.be.revertedWithCustomError(
      vault,
      "WithdrawNotAllowed"
    );
  });

  it("skips rather than wedges the queue when the validator loses its code", async function () {
    // Same misconfiguration reached from the processing path, where a revert would stall every
    // queued request behind it. Skipping returns the shares, which is recoverable once the
    // validator is pointed back at a contract.
    const sharesBefore = await vault.balanceOf(alice.address);
    await expect(redeem(alice, alice.address)).to.emit(vault, "RequestRedeemed");
    await protocolConfig.connect(admin).setVaultValidator(vaultAddr, bob.address);

    await expect(vault.connect(operator).processWithdrawalRequests(1)).to.not.be.reverted;
    expect(await vault.balanceOf(alice.address)).to.equal(sharesBefore);
  });

  describe("list management", function () {
    // The validator is shared by every vault type, but only EmberVault checks the list. Anywhere
    // else a list would change the count and emit events while withdrawals stayed open.
    it("refuses a list for a vault type that doesn't enforce it", async function () {
      const weth = await (await ethers.getContractFactory("MockWETH")).deploy();
      const feeLib = await (await ethers.getContractFactory("VaultPlatformFeeLib")).deploy();
      const queueLib = await (await ethers.getContractFactory("WithdrawalQueueLib")).deploy();
      const ethVault = (await upgrades.deployProxy(
        await ethers.getContractFactory("EmberETHVault", {
          libraries: {
            VaultPlatformFeeLib: await feeLib.getAddress(),
            WithdrawalQueueLib: await queueLib.getAddress(),
          },
        }),
        [
          await protocolConfig.getAddress(),
          owner.address,
          {
            name: "Ember ETH Vault",
            receiptTokenSymbol: "eETH",
            collateralToken: await weth.getAddress(),
            admin: admin.address,
            operator: operator.address,
            rateManager: rateManager.address,
            maxRateChangePerUpdate: ethers.parseUnits("0.1", 18),
            feePercentage: 0n,
            minWithdrawableShares: ethers.parseUnits("1", 18),
            rateUpdateInterval: 2 * 60 * 60 * 1000,
            maxTVL: ethers.parseUnits("1000", 18),
          },
          [],
        ],
        { initializer: "initialize", kind: "uups", unsafeAllowLinkedLibraries: true }
      )) as unknown as any;
      const ethAddr = await ethVault.getAddress();
      await protocolConfig.connect(admin).setVaultValidator(ethAddr, await validator.getAddress());

      await expect(
        protocolConfig.connect(operator).setVaultWithdrawAllowList(ethAddr, alice.address, true)
      ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
    });

    it("is operator-only", async function () {
      await expect(
        protocolConfig.connect(admin).setVaultWithdrawAllowList(vaultAddr, alice.address, true)
      ).to.be.revertedWithCustomError(validator, "Unauthorized");
    });

    it("emits the update with the vault sequence number", async function () {
      await expect(allowWithdraw(alice.address))
        .to.emit(validator, "VaultWithdrawAllowListUpdated")
        .withArgs(
          vaultAddr,
          alice.address,
          true,
          (t: bigint) => t > 0n,
          await vault.sequenceNumber()
        );
      expect(await validator.withdrawAllowList(vaultAddr, alice.address)).to.equal(true);
    });

    // The count only stays correct because the config rejects no-op updates before the validator.
    it("rejects setting the same value twice", async function () {
      await allowWithdraw(alice.address);
      await expect(allowWithdraw(alice.address)).to.be.revertedWithCustomError(
        protocolConfig,
        "SameValue"
      );
      await expect(allowWithdraw(bob.address, false)).to.be.revertedWithCustomError(
        protocolConfig,
        "SameValue"
      );
      expect(await validator.withdrawAllowListCount(vaultAddr)).to.equal(1n);
    });

    it("rejects the zero address and the vault's own roles", async function () {
      await expect(allowWithdraw(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        protocolConfig,
        "ZeroAddress"
      );
      for (const role of [admin, operator, rateManager]) {
        await expect(allowWithdraw(role.address)).to.be.revertedWithCustomError(
          protocolConfig,
          "InvalidValue"
        );
      }
    });

    it("rejects a blacklisted address", async function () {
      await protocolConfig.connect(owner).setBlacklistedAccount(carol.address, true);
      await expect(allowWithdraw(carol.address)).to.be.revertedWithCustomError(
        protocolConfig,
        "Blacklisted"
      );
    });
  });
});
