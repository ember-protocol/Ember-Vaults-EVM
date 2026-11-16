import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  EmberVault,
  EmberDepositParkingLot,
  EmberProtocolConfig,
  ERC20Token,
} from "../typechain-types";

// Coverage for EmberVault's parking-lot deposit gate + the EmberDepositParkingLot async flow:
//  - parkingLot unset (default): deposits stay permissionless (backward compatible);
//  - parkingLot set (admin-only, via EmberProtocolConfig): only the parking lot may deposit directly;
//  - the operator forwards parked deposits into the vault (shares mint to the user);
//  - users can cancel for an immediate refund; vault-rejected entries are skipped + refunded.
describe("EmberVault parking-lot gate + EmberDepositParkingLot", function () {
  let vault: EmberVault;
  let parkingLot: EmberDepositParkingLot;
  let parkingLotAddr: string;
  let protocolConfig: EmberProtocolConfig;
  let collateral: ERC20Token;
  let vaultAddr: string;

  let owner: HardhatEthersSigner; // vault owner (sets the parking lot)
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;
  let alice: HardhatEthersSigner; // regular user (parks deposits)
  let bob: HardhatEthersSigner; // share receiver

  const ONE = ethers.parseUnits("1", 18);
  const MAX_TVL = ethers.parseUnits("1000000", 18);
  const DEPOSIT = ethers.parseUnits("1000", 18); // rate 1:1 -> 1000 shares

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, guardian, alice, bob] =
      await ethers.getSigners();

    protocolConfig = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberProtocolConfig"),
      [owner.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberProtocolConfig;
    await protocolConfig.waitForDeployment();
    await protocolConfig.connect(owner).setGuardian(guardian.address);

    collateral = (await upgrades.deployProxy(
      await ethers.getContractFactory("ERC20Token"),
      [owner.address, "USD Coin", "USDC", 18, ethers.parseUnits("100000000", 18)],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as ERC20Token;
    await collateral.waitForDeployment();

    const initParams = {
      name: "Ember Vault",
      receiptTokenSymbol: "eVLT",
      collateralToken: await collateral.getAddress(),
      admin: admin.address,
      operator: operator.address,
      rateManager: rateManager.address,
      maxRateChangePerUpdate: ethers.parseUnits("0.1", 18),
      feePercentage: 0n,
      minWithdrawableShares: ONE,
      rateUpdateInterval: 2 * 60 * 60 * 1000,
      maxTVL: MAX_TVL,
    };
    vault = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberVault"),
      [await protocolConfig.getAddress(), owner.address, initParams, []],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberVault;
    await vault.waitForDeployment();
    vaultAddr = await vault.getAddress();

    parkingLot = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberDepositParkingLot"),
      [await protocolConfig.getAddress(), vaultAddr, operator.address, owner.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberDepositParkingLot;
    await parkingLot.waitForDeployment();
    parkingLotAddr = await parkingLot.getAddress();

    await collateral.connect(owner).transfer(alice.address, ethers.parseUnits("1000000", 18));
    await collateral.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    await collateral.connect(alice).approve(parkingLotAddr, ethers.MaxUint256);
  });

  it("reports its version", async function () {
    expect(await parkingLot.version()).to.equal("v1.4.0");
  });

  it("gate unset by default: any address can deposit directly (backward compatible)", async function () {
    expect(await vault.parkingLot()).to.equal(ethers.ZeroAddress);
    await vault.connect(alice).deposit(DEPOSIT, alice.address);
    expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT);
  });

  it("setParkingLot is admin-only (via ProtocolConfig) and toggles the gate", async function () {
    // Direct calls to vault must be rejected — must go through ProtocolConfig
    await expect(
      vault.connect(admin).setParkingLot(admin.address, parkingLotAddr)
    ).to.be.revertedWithCustomError(vault, "Unauthorized");
    await expect(
      vault.connect(owner).setParkingLot(owner.address, parkingLotAddr)
    ).to.be.revertedWithCustomError(vault, "Unauthorized");

    // Through ProtocolConfig, non-admin callers are rejected by onlyAdmin(caller)
    await expect(
      protocolConfig.connect(owner).setVaultParkingLot(vaultAddr, parkingLotAddr)
    ).to.be.revertedWithCustomError(vault, "Unauthorized");
    await expect(
      protocolConfig.connect(alice).setVaultParkingLot(vaultAddr, parkingLotAddr)
    ).to.be.revertedWithCustomError(vault, "Unauthorized");

    // Admin, going through ProtocolConfig, succeeds
    await expect(
      protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr)
    ).to.emit(vault, "ParkingLotUpdated");
    expect(await vault.parkingLot()).to.equal(parkingLotAddr);
  });

  it("gate set: only the parking lot may deposit directly; others revert", async function () {
    await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);

    await expect(
      vault.connect(alice).deposit(DEPOSIT, alice.address)
    ).to.be.revertedWithCustomError(vault, "UseParkingLot");
    await expect(vault.connect(alice).mint(DEPOSIT, alice.address)).to.be.revertedWithCustomError(
      vault,
      "UseParkingLot"
    );
  });

  it("admin can clear the parking lot to re-open direct deposits", async function () {
    await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);
    await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, ethers.ZeroAddress);
    expect(await vault.parkingLot()).to.equal(ethers.ZeroAddress);
    await vault.connect(alice).deposit(DEPOSIT, alice.address); // open again
    expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT);
  });

  // setOperator is gated on the vault admin (not the parking lot owner) — consistent with how
  // every other operational role tied to the vault is managed.
  it("setOperator is vault-admin-only", async function () {
    // owner (of parking lot) cannot call — only vault admin can
    await expect(parkingLot.connect(owner).setOperator(bob.address)).to.be.revertedWithCustomError(
      parkingLot,
      "Unauthorized"
    );
    await expect(parkingLot.connect(alice).setOperator(bob.address)).to.be.revertedWithCustomError(
      parkingLot,
      "Unauthorized"
    );
    await expect(parkingLot.connect(admin).setOperator(bob.address))
      .to.emit(parkingLot, "OperatorUpdated")
      .withArgs(vaultAddr, operator.address, bob.address);
    expect(await parkingLot.operator()).to.equal(bob.address);
  });

  // F-14: setOperator rejects a protocol-blacklisted address, for consistency with the rest of
  // the system's role/allow-list setters.
  it("setOperator rejects a blacklisted address", async function () {
    await protocolConfig.connect(owner).setBlacklistedAccount(bob.address, true);
    await expect(parkingLot.connect(admin).setOperator(bob.address)).to.be.revertedWithCustomError(
      parkingLot,
      "Blacklisted"
    );
  });

  describe("parking lot (gate set)", function () {
    beforeEach(async function () {
      await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);
    });

    it("vault admin and guardian can pause/unpause async deposits; others cannot", async function () {
      // The protocol guardian (set in the outer beforeEach) can pause, mirroring its
      // emergency-pause authority over non-admin operations elsewhere.
      await expect(parkingLot.connect(guardian).setDepositsPaused(true))
        .to.emit(parkingLot, "DepositsPausedUpdated")
        .withArgs(vaultAddr, true);
      expect(await parkingLot.depositsPaused()).to.equal(true);

      // While paused, new parks revert.
      await expect(
        parkingLot.connect(alice).deposit(DEPOSIT, bob.address)
      ).to.be.revertedWithCustomError(parkingLot, "OperationPaused");

      // The guardian can also unpause.
      await parkingLot.connect(guardian).setDepositsPaused(false);
      expect(await parkingLot.depositsPaused()).to.equal(false);

      // The vault admin can also toggle the pause (mirrors setPausedStatus on the vault itself).
      await expect(parkingLot.connect(admin).setDepositsPaused(true))
        .to.emit(parkingLot, "DepositsPausedUpdated")
        .withArgs(vaultAddr, true);
      await parkingLot.connect(admin).setDepositsPaused(false);

      // Parking-lot owner (the UUPS upgrade key) has NO operational authority — cannot pause.
      await expect(parkingLot.connect(owner).setDepositsPaused(true)).to.be.revertedWithCustomError(
        parkingLot,
        "Unauthorized"
      );

      // An unrelated account cannot toggle the pause.
      await expect(parkingLot.connect(alice).setDepositsPaused(true)).to.be.revertedWithCustomError(
        parkingLot,
        "Unauthorized"
      );
    });

    it("rejects parking when the vault's own deposits are paused (fail fast)", async function () {
      // Guardian pauses the vault's deposit operation via the protocol config.
      await protocolConfig.connect(guardian).setVaultPausedStatus(vaultAddr, "deposits", true);

      await expect(
        parkingLot.connect(alice).deposit(DEPOSIT, bob.address)
      ).to.be.revertedWithCustomError(parkingLot, "OperationPaused");

      // Once the vault unpauses, parking works again.
      await protocolConfig.connect(guardian).setVaultPausedStatus(vaultAddr, "deposits", false);
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(1n);
    });

    it("parks a deposit: escrows collateral, mints nothing", async function () {
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);

      expect(await collateral.balanceOf(parkingLotAddr)).to.equal(DEPOSIT);
      expect(await parkingLot.totalPendingAssets()).to.equal(DEPOSIT);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(1n);
      expect(await vault.totalSupply()).to.equal(0n);
      expect(await collateral.balanceOf(vaultAddr)).to.equal(0n);
    });

    // F-7: a receiver with no redemption path (the lot, the vault, or the token) would have its
    // forwarded shares locked forever — reject at deposit time.
    it("rejects a receiver with no redemption path (self / vault / token)", async function () {
      for (const bad of [parkingLotAddr, vaultAddr, await collateral.getAddress()]) {
        await expect(parkingLot.connect(alice).deposit(DEPOSIT, bad)).to.be.revertedWithCustomError(
          parkingLot,
          "InvalidReceiver"
        );
      }
    });

    // Rejects receivers the vault itself would refuse to mint to (vault roles + sub-accounts).
    // Without this pre-check the request would be escrowed, forwarded, skipped by the vault, and
    // refunded — same result, but wastes the user's tx.
    it("rejects a receiver that the vault would refuse (roles + sub-accounts)", async function () {
      for (const bad of [admin.address, operator.address, rateManager.address]) {
        await expect(parkingLot.connect(alice).deposit(DEPOSIT, bad)).to.be.revertedWithCustomError(
          parkingLot,
          "InvalidReceiver"
        );
      }
      // sub-account
      await protocolConfig.connect(admin).setVaultSubAccount(vaultAddr, alice.address, true);
      await expect(
        parkingLot.connect(alice).deposit(DEPOSIT, alice.address)
      ).to.be.revertedWithCustomError(parkingLot, "InvalidReceiver");
    });

    // F-9: cancelling a head slot advances the head past it (and contiguous settled slots), so the
    // operator never iterates dead head slots — cancel queue-stuffing pays for its own skip cost.
    it("collapses the queue head as head slots are cancelled", async function () {
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address); // seq 1
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address); // seq 2
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address); // seq 3

      await parkingLot.connect(alice).cancelDeposit(1);
      expect(await parkingLot.queueStartIndex()).to.equal(1n);
      await parkingLot.connect(alice).cancelDeposit(2);
      expect(await parkingLot.queueStartIndex()).to.equal(2n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(1n);

      // Operator starts directly at seq 3 — zero dead slots to skip.
      await parkingLot.connect(operator).processDeposits(10);
      expect(await parkingLot.queueStartIndex()).to.equal(3n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
      expect(await vault.balanceOf(bob.address)).to.equal(DEPOSIT); // only seq 3 forwarded
    });

    it("a single head-cancel collapses all contiguous already-settled slots", async function () {
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address); // seq 1
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address); // seq 2
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address); // seq 3

      // Cancel tail-first: the head (seq 1, still live) is untouched.
      await parkingLot.connect(alice).cancelDeposit(3);
      await parkingLot.connect(alice).cancelDeposit(2);
      expect(await parkingLot.queueStartIndex()).to.equal(0n);

      // Cancelling the head now collapses seq 1, 2, 3 in one advance.
      await parkingLot.connect(alice).cancelDeposit(1);
      expect(await parkingLot.queueStartIndex()).to.equal(3n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
    });

    // F-11: a cancelled MIDDLE slot stays in the queue range until swept, so the raw length
    // over-counts; getLivePendingDepositsCount reports the real (live) backlog.
    it("getLivePendingDepositsCount excludes cancelled-but-unswept slots", async function () {
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address); // seq 1 (head, stays live)
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address); // seq 2 (cancelled below)
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address); // seq 3

      await parkingLot.connect(alice).cancelDeposit(2); // middle slot — no head collapse
      expect(await parkingLot.queueStartIndex()).to.equal(0n);

      // Raw slot count still includes the dead middle slot; live count excludes it.
      expect(await parkingLot.getPendingDepositsLength()).to.equal(3n);
      expect(await parkingLot.getLivePendingDepositsCount()).to.equal(2n);
    });

    it("operator forwards a parked deposit into the vault (shares mint to receiver)", async function () {
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      await parkingLot.connect(operator).processDeposits(1);

      expect(await vault.balanceOf(bob.address)).to.equal(DEPOSIT);
      expect(await vault.totalSupply()).to.equal(DEPOSIT);
      expect(await collateral.balanceOf(vaultAddr)).to.equal(DEPOSIT);
      expect(await parkingLot.totalPendingAssets()).to.equal(0n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
    });

    it("only the operator can process the queue", async function () {
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      await expect(parkingLot.connect(alice).processDeposits(1)).to.be.revertedWithCustomError(
        parkingLot,
        "Unauthorized"
      );
    });

    it("cancel refunds the escrow immediately; the slot is skipped on processing", async function () {
      const seq = await parkingLot.connect(alice).deposit.staticCall(DEPOSIT, bob.address);
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);

      const before = await collateral.balanceOf(alice.address);
      await expect(parkingLot.connect(alice).cancelDeposit(seq))
        .to.emit(parkingLot, "DepositCancelled")
        .withArgs(vaultAddr, alice.address, DEPOSIT, seq);
      expect((await collateral.balanceOf(alice.address)) - before).to.equal(DEPOSIT);
      expect(await parkingLot.totalPendingAssets()).to.equal(0n);

      await parkingLot.connect(operator).processDeposits(1);
      expect(await vault.totalSupply()).to.equal(0n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);

      await expect(parkingLot.connect(alice).cancelDeposit(seq)).to.be.revertedWithCustomError(
        parkingLot,
        "InvalidRequest"
      );
    });

    it("vault admin and guardian can pause/unpause cancellation; others cannot", async function () {
      await expect(parkingLot.connect(guardian).setCancellationsPaused(true))
        .to.emit(parkingLot, "CancellationsPausedUpdated")
        .withArgs(vaultAddr, true);
      expect(await parkingLot.cancellationsPaused()).to.equal(true);

      // No-op updates are rejected, as with the deposits pause.
      await expect(
        parkingLot.connect(guardian).setCancellationsPaused(true)
      ).to.be.revertedWithCustomError(parkingLot, "SameValue");

      await expect(parkingLot.connect(guardian).setCancellationsPaused(false))
        .to.emit(parkingLot, "CancellationsPausedUpdated")
        .withArgs(vaultAddr, false);
      expect(await parkingLot.cancellationsPaused()).to.equal(false);

      await expect(
        parkingLot.connect(guardian).setCancellationsPaused(false)
      ).to.be.revertedWithCustomError(parkingLot, "SameValue");

      // The vault admin can also toggle it.
      await parkingLot.connect(admin).setCancellationsPaused(true);
      await parkingLot.connect(admin).setCancellationsPaused(false);

      // Parking-lot owner (the UUPS upgrade key) has NO operational authority.
      await expect(
        parkingLot.connect(owner).setCancellationsPaused(true)
      ).to.be.revertedWithCustomError(parkingLot, "Unauthorized");
      await expect(
        parkingLot.connect(alice).setCancellationsPaused(true)
      ).to.be.revertedWithCustomError(parkingLot, "Unauthorized");
    });

    it("while paused depositors cannot withdraw from the queue, but parks and processing still work", async function () {
      const seq = await parkingLot.connect(alice).deposit.staticCall(DEPOSIT, bob.address);
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);

      await parkingLot.connect(guardian).setCancellationsPaused(true);
      const committed = await parkingLot.totalPendingAssets();
      expect(committed).to.equal(DEPOSIT);

      // Cannot shrink: escrow the curator has allocated against can't be pulled back out.
      await expect(parkingLot.connect(alice).cancelDeposit(seq)).to.be.revertedWithCustomError(
        parkingLot,
        "OperationPaused"
      );
      expect(await parkingLot.totalPendingAssets()).to.equal(committed);

      // Can still grow: new parks are unaffected and join the same commitment.
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      expect(await parkingLot.totalPendingAssets()).to.equal(committed + DEPOSIT);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(2n);

      // The whole committed amount lands in the vault — the point of the pause. Asserted
      // exactly (1:1 rate in this suite): a `> 0` check would also pass if one of the two
      // requests had been silently skipped + refunded via _forward's catch branch, which is
      // the failure this test exists to rule out.
      await parkingLot.connect(operator).processDeposits(2);
      expect(await parkingLot.totalPendingAssets()).to.equal(0n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
      expect(await vault.balanceOf(bob.address)).to.equal(committed + DEPOSIT);

      // Unpausing restores the cancel path.
      await parkingLot.connect(guardian).setCancellationsPaused(false);
      const seq2 = await parkingLot.connect(alice).deposit.staticCall(DEPOSIT, bob.address);
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      await expect(parkingLot.connect(alice).cancelDeposit(seq2))
        .to.emit(parkingLot, "DepositCancelled")
        .withArgs(vaultAddr, alice.address, DEPOSIT, seq2);
    });

    it("processDepositsUpTo settles through the named request and stops there", async function () {
      for (let i = 0; i < 4; i++) {
        await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      }
      expect(await parkingLot.sequenceNumber()).to.equal(4n);

      // Settle through seq 2 only.
      await parkingLot.connect(operator).processDepositsUpTo(2);
      expect(await parkingLot.queueStartIndex()).to.equal(2n);
      expect(await parkingLot.totalPendingAssets()).to.equal(DEPOSIT * 2n);
      expect(await vault.balanceOf(bob.address)).to.equal(DEPOSIT * 2n);

      // Seq 3 and 4 are untouched and still cancellable.
      await expect(parkingLot.connect(alice).cancelDeposit(3))
        .to.emit(parkingLot, "DepositCancelled")
        .withArgs(vaultAddr, alice.address, DEPOSIT, 3);

      await parkingLot.connect(operator).processDepositsUpTo(4);
      expect(await parkingLot.queueStartIndex()).to.equal(4n);
      expect(await parkingLot.totalPendingAssets()).to.equal(0n);
    });

    it("processDepositsUpTo takes the counting error off the caller: cancelled slots don't shift the target", async function () {
      for (let i = 0; i < 5; i++) {
        await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      }
      // Two holes inside the range we want to settle.
      await parkingLot.connect(alice).cancelDeposit(2);
      await parkingLot.connect(alice).cancelDeposit(4);

      // "Settle everything through request 5" — no need to know 2 of the 5 slots are dead.
      // processDeposits(3) would have stopped at seq 3, having forwarded only seq 1 and 3.
      await parkingLot.connect(operator).processDepositsUpTo(5);

      expect(await parkingLot.queueStartIndex()).to.equal(5n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
      expect(await parkingLot.totalPendingAssets()).to.equal(0n);
      // Only the three live ones forwarded (1, 3, 5); the two cancelled were already refunded.
      expect(await vault.balanceOf(bob.address)).to.equal(DEPOSIT * 3n);
    });

    it("processDepositsUpTo rejects a sequence number that isn't a pending request", async function () {
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);

      // Past the tail names a request that doesn't exist — a stale id, a shifted decimal, a
      // sentinel. Reverting stops a fat-finger from settling the whole queue, including deposits
      // parked seconds earlier that the curator hasn't committed to.
      await expect(
        parkingLot.connect(operator).processDepositsUpTo(999)
      ).to.be.revertedWithCustomError(parkingLot, "IndexOutOfBounds");
      await expect(
        parkingLot.connect(operator).processDepositsUpTo(ethers.MaxUint256)
      ).to.be.revertedWithCustomError(parkingLot, "IndexOutOfBounds");
      // Nothing settled.
      expect(await parkingLot.queueStartIndex()).to.equal(0n);
      expect(await parkingLot.totalPendingAssets()).to.equal(DEPOSIT * 2n);

      // The tail itself is valid — that is how you settle the whole queue by id.
      await parkingLot.connect(operator).processDepositsUpTo(2);
      expect(await parkingLot.queueStartIndex()).to.equal(2n);
      expect(await parkingLot.totalPendingAssets()).to.equal(0n);

      // At or below the head there is nothing left to settle.
      await expect(
        parkingLot.connect(operator).processDepositsUpTo(2)
      ).to.be.revertedWithCustomError(parkingLot, "InvalidRequest");
      await expect(
        parkingLot.connect(operator).processDepositsUpTo(0)
      ).to.be.revertedWithCustomError(parkingLot, "InvalidRequest");
    });

    it("processDepositsUpTo is operator-only and respects the protocol pause", async function () {
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);

      await expect(parkingLot.connect(alice).processDepositsUpTo(1)).to.be.revertedWithCustomError(
        parkingLot,
        "Unauthorized"
      );
      await expect(parkingLot.connect(admin).processDepositsUpTo(1)).to.be.revertedWithCustomError(
        parkingLot,
        "Unauthorized"
      );

      await protocolConfig.connect(guardian).guardianPauseNonAdminOperations(true);
      await expect(
        parkingLot.connect(operator).processDepositsUpTo(1)
      ).to.be.revertedWithCustomError(parkingLot, "OperationPaused");
    });

    it("skips + refunds a request the vault rejects (blacklisted receiver) without wedging the queue", async function () {
      const seq1 = await parkingLot.connect(alice).deposit.staticCall(DEPOSIT, bob.address);
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      await parkingLot.connect(alice).deposit(DEPOSIT, alice.address); // valid

      await protocolConfig.connect(owner).setBlacklistedAccount(bob.address, true);

      const aliceColBefore = await collateral.balanceOf(alice.address);
      await expect(parkingLot.connect(operator).processDeposits(2))
        .to.emit(parkingLot, "DepositSkipped")
        .withArgs(vaultAddr, alice.address, bob.address, DEPOSIT, seq1);

      expect(await vault.balanceOf(bob.address)).to.equal(0n);
      expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT); // valid one settled
      expect((await collateral.balanceOf(alice.address)) - aliceColBefore).to.equal(DEPOSIT); // refund
      expect(await parkingLot.totalPendingAssets()).to.equal(0n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
    });

    // Audit finding: processDeposits used to succeed even when the ORIGINAL depositor had been
    // blacklisted after parking, because the vault sees msg.sender == parkingLot (never
    // blacklisted). _forward now re-checks the depositor's blacklist status before calling
    // vault.deposit — the request is skipped + refunded, and the queue keeps moving.
    it("skips + refunds a forward if the original depositor was blacklisted after parking", async function () {
      const seq1 = await parkingLot.connect(alice).deposit.staticCall(DEPOSIT, alice.address);
      await parkingLot.connect(alice).deposit(DEPOSIT, alice.address);
      // Fund + approve bob BEFORE queuing so the staticCall can preview the deposit.
      await collateral.connect(owner).transfer(bob.address, DEPOSIT);
      await collateral.connect(bob).approve(parkingLotAddr, ethers.MaxUint256);
      // A second, unrelated deposit queued behind alice; it should still settle.
      const seq2 = await parkingLot.connect(bob).deposit.staticCall(DEPOSIT, bob.address);
      await parkingLot.connect(bob).deposit(DEPOSIT, bob.address);

      // Blacklist alice AFTER she has already parked. Vault would not catch this on
      // its own — it validates against msg.sender (the parking lot).
      await protocolConfig.connect(owner).setBlacklistedAccount(alice.address, true);

      const aliceColBefore = await collateral.balanceOf(alice.address);
      await expect(parkingLot.connect(operator).processDeposits(2))
        .to.emit(parkingLot, "DepositSkipped")
        .withArgs(vaultAddr, alice.address, alice.address, DEPOSIT, seq1)
        .and.to.emit(parkingLot, "DepositForwarded")
        .withArgs(vaultAddr, bob.address, bob.address, DEPOSIT, DEPOSIT, seq2);

      // Alice never received shares; her escrow is returned.
      expect(await vault.balanceOf(alice.address)).to.equal(0n);
      expect((await collateral.balanceOf(alice.address)) - aliceColBefore).to.equal(DEPOSIT);
      // Bob's deposit behind alice's still settled — the skip did NOT wedge the queue.
      expect(await vault.balanceOf(bob.address)).to.equal(DEPOSIT);
      expect(await parkingLot.totalPendingAssets()).to.equal(0n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
    });

    // F-6: the FIFO is driven by head (queueStartIndex) + tail (sequenceNumber) counters, not a
    // growing array. This exercises partial batches interleaved with new deposits (the queue is
    // never fully drained in one call) and asserts the head advances monotonically and FIFO is
    // preserved — the case that grew the old `pendingSeqs` array unboundedly.
    it("advances FIFO across partial batches + interleaved deposits without resetting the head", async function () {
      const receivers: string[] = [];
      for (let r = 0; r < 4; r++) {
        const w1 = ethers.Wallet.createRandom().address;
        const w2 = ethers.Wallet.createRandom().address;
        receivers.push(w1, w2);
        await parkingLot.connect(alice).deposit(DEPOSIT, w1);
        await parkingLot.connect(alice).deposit(DEPOSIT, w2);
        await parkingLot.connect(operator).processDeposits(1); // partial — backlog never clears
      }

      // 8 queued, 4 processed; head advanced monotonically (never reset to 0).
      expect(await parkingLot.queueStartIndex()).to.equal(4n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(4n);

      // Drain the remainder.
      await parkingLot.connect(operator).processDeposits(100);
      expect(await parkingLot.queueStartIndex()).to.equal(8n);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
      expect(await parkingLot.totalPendingAssets()).to.equal(0n);

      // Every receiver got exactly its shares, in order, none lost.
      for (const rcv of receivers) {
        expect(await vault.balanceOf(rcv)).to.equal(DEPOSIT);
      }
    });
  });

  describe("validator allow-listed direct deposits (gate set)", function () {
    it("lets a validator-allow-listed depositor deposit directly; others must park", async function () {
      // Wire a validator and allow-list alice.
      const validator = (await upgrades.deployProxy(
        await ethers.getContractFactory("EmberVaultValidator"),
        [await protocolConfig.getAddress(), owner.address],
        { initializer: "initialize", kind: "uups" }
      )) as unknown as any;
      await validator.waitForDeployment();
      await protocolConfig
        .connect(admin)
        .setVaultValidator(vaultAddr, await validator.getAddress());
      // The deposit allow-list is managed by the vault operator.
      await protocolConfig
        .connect(operator)
        .setVaultDepositAllowList(vaultAddr, alice.address, true);

      // Turn on the gate.
      await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);

      // alice is on the validator deposit allow list -> direct deposit succeeds despite the gate.
      await vault.connect(alice).deposit(DEPOSIT, alice.address);
      expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT);

      // bob is NOT allow-listed (the list is now active) -> must use the parking lot.
      await collateral.connect(owner).transfer(bob.address, DEPOSIT);
      await collateral.connect(bob).approve(vaultAddr, ethers.MaxUint256);
      await expect(vault.connect(bob).deposit(DEPOSIT, bob.address)).to.be.revertedWithCustomError(
        vault,
        "UseParkingLot"
      );
    });

    // F-2: a non-empty validator allow-list must NOT gate parking-lot forwards (depositor == lot),
    // or every forward silently bounces (skip + refund) and the async feature is dead.
    it("forwards still settle when the allow-list is non-empty and the lot isn't on it", async function () {
      const validator = (await upgrades.deployProxy(
        await ethers.getContractFactory("EmberVaultValidator"),
        [await protocolConfig.getAddress(), owner.address],
        { initializer: "initialize", kind: "uups" }
      )) as unknown as any;
      await validator.waitForDeployment();
      await protocolConfig
        .connect(admin)
        .setVaultValidator(vaultAddr, await validator.getAddress());

      // Activate the allow-list with a trusted DIRECT depositor (count -> 1). The parking lot is
      // deliberately NOT added — pre-fix this silently bounced every forward.
      await protocolConfig
        .connect(operator)
        .setVaultDepositAllowList(vaultAddr, owner.address, true);
      expect(await validator.depositAllowListCount(vaultAddr)).to.equal(1n);
      expect(await validator.depositAllowList(vaultAddr, parkingLotAddr)).to.equal(false);

      await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);

      // alice parks; operator forwards. The lot is implicitly allowed -> forward settles (no skip).
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      await expect(parkingLot.connect(operator).processDeposits(1)).to.not.emit(
        parkingLot,
        "DepositSkipped"
      );

      expect(await vault.balanceOf(bob.address)).to.equal(DEPOSIT);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
      expect(await parkingLot.totalPendingAssets()).to.equal(0n);
    });
  });

  // The lot<->vault binding is two-sided: the lot stores its vault, and the vault must separately
  // register the lot. Until it does, nothing parked here can settle.
  describe("registration with the vault", function () {
    it("rejects deposits before the vault has registered the lot", async function () {
      expect(await vault.parkingLot()).to.equal(ethers.ZeroAddress);
      await expect(
        parkingLot.connect(alice).deposit(DEPOSIT, bob.address)
      ).to.be.revertedWithCustomError(parkingLot, "NotRegisteredParkingLot");
    });

    it("rejects deposits when the vault registered a different lot", async function () {
      await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, bob.address);
      await expect(
        parkingLot.connect(alice).deposit(DEPOSIT, bob.address)
      ).to.be.revertedWithCustomError(parkingLot, "NotRegisteredParkingLot");
    });

    it("accepts deposits once registered", async function () {
      await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(1n);
    });

    // A queued request whose lot is later unset used to wedge the queue: the vault's gate is open
    // with no lot, so the forward minted, then recordDepositFor rejected the lot and reverted the
    // whole batch. It is now refunded before the vault is ever called.
    it("refunds queued requests instead of wedging when the lot is unregistered later", async function () {
      const validator = (await upgrades.deployProxy(
        await ethers.getContractFactory("EmberVaultValidator"),
        [await protocolConfig.getAddress(), owner.address],
        { initializer: "initialize", kind: "uups" }
      )) as unknown as any;
      await protocolConfig
        .connect(admin)
        .setVaultValidator(vaultAddr, await validator.getAddress());
      await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);

      await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, ethers.ZeroAddress);
      const before = await collateral.balanceOf(alice.address);

      await expect(parkingLot.connect(operator).processDeposits(1)).to.emit(
        parkingLot,
        "DepositSkipped"
      );
      expect(await vault.balanceOf(bob.address)).to.equal(0n);
      expect(await collateral.balanceOf(alice.address)).to.equal(before + DEPOSIT);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
    });

    it("refunds queued requests when the vault moved to a different lot", async function () {
      await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);
      await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
      await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, bob.address);

      await expect(parkingLot.connect(operator).processDeposits(1)).to.emit(
        parkingLot,
        "DepositSkipped"
      );
      expect(await vault.balanceOf(bob.address)).to.equal(0n);
    });
  });

  // Operator-managed deposit allow-list: empty list = open to everyone; non-empty = only listed
  // addresses may park. (Independent of the vault's parking-lot gate — this restricts who can
  // deposit INTO the parking lot.)
  describe("deposit allow-list", function () {
    beforeEach(async function () {
      // alice is funded/approved in the outer beforeEach; fund + approve bob too so both the
      // allowed and not-allowed paths are exercised on a fully-set-up depositor.
      await collateral.connect(owner).transfer(bob.address, ethers.parseUnits("1000000", 18));
      await collateral.connect(bob).approve(parkingLotAddr, ethers.MaxUint256);
      // The lot only accepts deposits once the vault points back at it.
      await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);
    });

    it("empty list: anyone may deposit (backward compatible)", async function () {
      expect(await parkingLot.depositAllowListCount()).to.equal(0n);
      expect(await parkingLot.isDepositAllowed(alice.address)).to.equal(true);
      expect(await parkingLot.isDepositAllowed(bob.address)).to.equal(true);

      await parkingLot.connect(alice).deposit(DEPOSIT, alice.address);
      await parkingLot.connect(bob).deposit(DEPOSIT, bob.address);
      expect(await parkingLot.getPendingDepositsLength()).to.equal(2n);
    });

    it("once an address is allow-listed, only listed depositors may park", async function () {
      await expect(parkingLot.connect(operator).setDepositAllowListStatus(alice.address, true))
        .to.emit(parkingLot, "DepositAllowListUpdated")
        .withArgs(vaultAddr, alice.address, true, 1n);

      expect(await parkingLot.depositAllowListCount()).to.equal(1n);
      expect(await parkingLot.isDepositAllowed(alice.address)).to.equal(true);
      expect(await parkingLot.isDepositAllowed(bob.address)).to.equal(false);

      // alice (listed) can park; bob (not listed) is rejected at the gate.
      await parkingLot.connect(alice).deposit(DEPOSIT, alice.address);
      await expect(
        parkingLot.connect(bob).deposit(DEPOSIT, bob.address)
      ).to.be.revertedWithCustomError(parkingLot, "DepositNotAllowed");
    });

    it("removing the last entry reopens deposits to everyone", async function () {
      await parkingLot.connect(operator).setDepositAllowListStatus(alice.address, true);
      await expect(
        parkingLot.connect(bob).deposit(DEPOSIT, bob.address)
      ).to.be.revertedWithCustomError(parkingLot, "DepositNotAllowed");

      await expect(parkingLot.connect(operator).setDepositAllowListStatus(alice.address, false))
        .to.emit(parkingLot, "DepositAllowListUpdated")
        .withArgs(vaultAddr, alice.address, false, 0n);

      expect(await parkingLot.depositAllowListCount()).to.equal(0n);
      await parkingLot.connect(bob).deposit(DEPOSIT, bob.address); // open again
      expect(await parkingLot.getPendingDepositsLength()).to.equal(1n);
    });

    it("setDepositAllowListStatus is operator-only", async function () {
      for (const caller of [owner, admin, alice]) {
        await expect(
          parkingLot.connect(caller).setDepositAllowListStatus(alice.address, true)
        ).to.be.revertedWithCustomError(parkingLot, "Unauthorized");
      }
    });

    it("rejects zero address, blacklisted account, and no-op updates", async function () {
      await expect(
        parkingLot.connect(operator).setDepositAllowListStatus(ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(parkingLot, "ZeroAddress");

      await protocolConfig.connect(owner).setBlacklistedAccount(bob.address, true);
      await expect(
        parkingLot.connect(operator).setDepositAllowListStatus(bob.address, true)
      ).to.be.revertedWithCustomError(parkingLot, "Blacklisted");
      await protocolConfig.connect(owner).setBlacklistedAccount(bob.address, false);

      // Removing an address that isn't listed is a no-op -> SameValue.
      await expect(
        parkingLot.connect(operator).setDepositAllowListStatus(alice.address, false)
      ).to.be.revertedWithCustomError(parkingLot, "SameValue");

      // Adding twice is also a no-op on the second call.
      await parkingLot.connect(operator).setDepositAllowListStatus(alice.address, true);
      await expect(
        parkingLot.connect(operator).setDepositAllowListStatus(alice.address, true)
      ).to.be.revertedWithCustomError(parkingLot, "SameValue");
    });

    it("count tracks multiple entries", async function () {
      await parkingLot.connect(operator).setDepositAllowListStatus(alice.address, true);
      await parkingLot.connect(operator).setDepositAllowListStatus(bob.address, true);
      expect(await parkingLot.depositAllowListCount()).to.equal(2n);
      await parkingLot.connect(operator).setDepositAllowListStatus(alice.address, false);
      expect(await parkingLot.depositAllowListCount()).to.equal(1n);
      // bob still listed -> still gated to bob only.
      expect(await parkingLot.isDepositAllowed(alice.address)).to.equal(false);
      expect(await parkingLot.isDepositAllowed(bob.address)).to.equal(true);
    });
  });
});

// F-1: an undeliverable refund inside processDeposits/_forward must NOT revert the batch — it
// would otherwise wedge the FIFO queue forever. Uses a collateral token that can block transfers
// to a specific address (simulating a USDC/USDT-style blacklist) so the refund transfer fails.
describe("EmberDepositParkingLot — undeliverable refunds (F-1)", function () {
  let vault: EmberVault;
  let parkingLot: EmberDepositParkingLot;
  let parkingLotAddr: string;
  let protocolConfig: EmberProtocolConfig;
  let collateral: any; // BlockableERC20
  let vaultAddr: string;

  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let alice: HardhatEthersSigner; // depositor whose refund will be undeliverable
  let bob: HardhatEthersSigner; // protocol-blacklisted share receiver (makes the vault deposit fail)
  let carol: HardhatEthersSigner; // a valid depositor queued behind alice

  const ONE = ethers.parseUnits("1", 18);
  const MAX_TVL = ethers.parseUnits("1000000", 18);
  const DEPOSIT = ethers.parseUnits("1000", 18);

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, , alice, bob, carol] =
      await ethers.getSigners();

    protocolConfig = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberProtocolConfig"),
      [owner.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberProtocolConfig;
    await protocolConfig.waitForDeployment();

    collateral = await (
      await ethers.getContractFactory("BlockableERC20")
    ).deploy("Blockable USD", "bUSD");
    await collateral.waitForDeployment();

    const initParams = {
      name: "Ember Vault",
      receiptTokenSymbol: "eVLT",
      collateralToken: await collateral.getAddress(),
      admin: admin.address,
      operator: operator.address,
      rateManager: rateManager.address,
      maxRateChangePerUpdate: ethers.parseUnits("0.1", 18),
      feePercentage: 0n,
      minWithdrawableShares: ONE,
      rateUpdateInterval: 2 * 60 * 60 * 1000,
      maxTVL: MAX_TVL,
    };
    vault = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberVault"),
      [await protocolConfig.getAddress(), owner.address, initParams, []],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberVault;
    await vault.waitForDeployment();
    vaultAddr = await vault.getAddress();

    parkingLot = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberDepositParkingLot"),
      [await protocolConfig.getAddress(), vaultAddr, operator.address, owner.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberDepositParkingLot;
    await parkingLot.waitForDeployment();
    parkingLotAddr = await parkingLot.getAddress();
    await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);

    for (const u of [alice, carol]) {
      await collateral.mint(u.address, ethers.parseUnits("1000000", 18));
      await collateral.connect(u).approve(parkingLotAddr, ethers.MaxUint256);
    }
  });

  it("credits claimable instead of reverting when a refund is undeliverable; queue still advances", async function () {
    // seq1: receiver bob (will be protocol-blacklisted -> vault deposit fails -> refund to alice).
    const seq1 = await parkingLot.connect(alice).deposit.staticCall(DEPOSIT, bob.address);
    await parkingLot.connect(alice).deposit(DEPOSIT, bob.address);
    // seq2: a valid request queued BEHIND the bad one — it must still settle.
    await parkingLot.connect(carol).deposit(DEPOSIT, carol.address);

    // Make the vault reject seq1 (blacklisted receiver) AND make alice's refund undeliverable.
    await protocolConfig.connect(owner).setBlacklistedAccount(bob.address, true);
    await collateral.setBlocked(alice.address, true);

    // Must NOT revert (pre-fix this wedged the queue). Refund is credited, not paid.
    await expect(parkingLot.connect(operator).processDeposits(2))
      .to.emit(parkingLot, "DepositSkipped")
      .withArgs(vaultAddr, alice.address, bob.address, DEPOSIT, seq1)
      .and.to.emit(parkingLot, "RefundCredited")
      .withArgs(vaultAddr, alice.address, DEPOSIT);

    // Undeliverable refund parked as a pull-payment; escrow stays in the contract.
    expect(await parkingLot.claimable(alice.address)).to.equal(DEPOSIT);
    // The request queued behind the wedge still settled — queue advanced past the bad entry.
    expect(await vault.balanceOf(carol.address)).to.equal(DEPOSIT);
    expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
    expect(await parkingLot.totalPendingAssets()).to.equal(0n);

    // Once deliverable again, alice pulls her refund.
    await collateral.setBlocked(alice.address, false);
    const before = await collateral.balanceOf(alice.address);
    await expect(parkingLot.connect(alice).claim())
      .to.emit(parkingLot, "Claimed")
      .withArgs(vaultAddr, alice.address, DEPOSIT);
    expect((await collateral.balanceOf(alice.address)) - before).to.equal(DEPOSIT);
    expect(await parkingLot.claimable(alice.address)).to.equal(0n);
  });

  it("cancelDeposit credits claimable when the refund is undeliverable (escrow not stuck)", async function () {
    const seq = await parkingLot.connect(carol).deposit.staticCall(DEPOSIT, carol.address);
    await parkingLot.connect(carol).deposit(DEPOSIT, carol.address);

    await collateral.setBlocked(carol.address, true);

    // Cancel still succeeds — the undeliverable refund becomes a claim rather than reverting.
    await expect(parkingLot.connect(carol).cancelDeposit(seq))
      .to.emit(parkingLot, "DepositCancelled")
      .withArgs(vaultAddr, carol.address, DEPOSIT, seq)
      .and.to.emit(parkingLot, "RefundCredited")
      .withArgs(vaultAddr, carol.address, DEPOSIT);
    expect(await parkingLot.claimable(carol.address)).to.equal(DEPOSIT);
    expect(await parkingLot.totalPendingAssets()).to.equal(0n);

    await collateral.setBlocked(carol.address, false);
    await parkingLot.connect(carol).claim();
    expect(await parkingLot.claimable(carol.address)).to.equal(0n);
  });

  it("claim reverts when there is nothing to claim", async function () {
    await expect(parkingLot.connect(alice).claim()).to.be.revertedWithCustomError(
      parkingLot,
      "ZeroAmount"
    );
  });
});

// Audit finding: EmberVault mints shares against the argument passed to `deposit()`, not against
// what it actually receives, so a fee-on-transfer collateral would silently over-mint on forward.
// The parking lot rejects FoT collateral up front (measures the balance diff around
// safeTransferFrom and reverts FeeOnTransferNotSupported if received != assets) so that the
// combined system has a clear "we do not support FoT" contract instead of misaccounting.
describe("EmberDepositParkingLot — fee-on-transfer collateral (rejected)", function () {
  let vault: EmberVault;
  let parkingLot: EmberDepositParkingLot;
  let parkingLotAddr: string;
  let protocolConfig: EmberProtocolConfig;
  let collateral: any; // FeeOnTransferERC20 (1% fee)
  let vaultAddr: string;

  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner; // share receiver

  const ONE = ethers.parseUnits("1", 18);
  const MAX_TVL = ethers.parseUnits("1000000", 18);
  const DEPOSIT = ethers.parseUnits("1000", 18);
  const FEE_BPS = 100n; // 1%

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, , alice, bob] = await ethers.getSigners();

    protocolConfig = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberProtocolConfig"),
      [owner.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberProtocolConfig;
    await protocolConfig.waitForDeployment();

    collateral = await (
      await ethers.getContractFactory("FeeOnTransferERC20")
    ).deploy("Fee USD", "fUSD", FEE_BPS);
    await collateral.waitForDeployment();

    const initParams = {
      name: "Ember Vault",
      receiptTokenSymbol: "eVLT",
      collateralToken: await collateral.getAddress(),
      admin: admin.address,
      operator: operator.address,
      rateManager: rateManager.address,
      maxRateChangePerUpdate: ethers.parseUnits("0.1", 18),
      feePercentage: 0n,
      minWithdrawableShares: ONE,
      rateUpdateInterval: 2 * 60 * 60 * 1000,
      maxTVL: MAX_TVL,
    };
    vault = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberVault"),
      [await protocolConfig.getAddress(), owner.address, initParams, []],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberVault;
    await vault.waitForDeployment();
    vaultAddr = await vault.getAddress();

    parkingLot = (await upgrades.deployProxy(
      await ethers.getContractFactory("EmberDepositParkingLot"),
      [await protocolConfig.getAddress(), vaultAddr, operator.address, owner.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberDepositParkingLot;
    await parkingLot.waitForDeployment();
    parkingLotAddr = await parkingLot.getAddress();
    await protocolConfig.connect(admin).setVaultParkingLot(vaultAddr, parkingLotAddr);

    await collateral.mint(alice.address, ethers.parseUnits("1000000", 18));
    await collateral.connect(alice).approve(parkingLotAddr, ethers.MaxUint256);
  });

  it("reverts with FeeOnTransferNotSupported when the collateral charges a fee on transfer", async function () {
    await expect(
      parkingLot.connect(alice).deposit(DEPOSIT, bob.address)
    ).to.be.revertedWithCustomError(parkingLot, "FeeOnTransferNotSupported");
    // No slot was queued and no escrow was retained.
    expect(await parkingLot.getPendingDepositsLength()).to.equal(0n);
    expect(await parkingLot.totalPendingAssets()).to.equal(0n);
  });
});
