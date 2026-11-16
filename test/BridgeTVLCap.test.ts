import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { EmberVault, EmberProtocolConfig, ERC20Token } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

// maxTVL used to be checked against totalAssets(), i.e. shares currently on this chain.
// Bridging shares out lowered that, so the same capacity could be deposited again and again.
// The cap now counts shares bridged out as still here, and never gates an inbound mint.
describe("EmberVault - maxTVL vs bridging", function () {
  let vault: EmberVault;
  let protocolConfig: EmberProtocolConfig;
  let collateralToken: ERC20Token;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let bridge: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  const MAX_TVL = ethers.parseUnits("1000", 18);

  async function deposit(user: HardhatEthersSigner, assets: bigint) {
    await collateralToken.connect(user).approve(await vault.getAddress(), assets);
    return vault.connect(user).deposit(assets, user.address);
  }

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, bridge, user1, user2] =
      await ethers.getSigners();

    const configFactory = await ethers.getContractFactory("EmberProtocolConfig");
    protocolConfig = (await upgrades.deployProxy(
      configFactory,
      [owner.address, feeRecipient.address],
      { initializer: "initialize", kind: "uups" }
    )) as EmberProtocolConfig;

    const collateralFactory = await ethers.getContractFactory("ERC20Token");
    collateralToken = (await upgrades.deployProxy(
      collateralFactory,
      [owner.address, "Collateral Token", "COLL", 18, ethers.parseUnits("10000000", 18)],
      { initializer: "initialize", kind: "uups" }
    )) as ERC20Token;

    const vaultFactory = await ethers.getContractFactory("EmberVault");
    vault = (await upgrades.deployProxy(
      vaultFactory,
      [
        await protocolConfig.getAddress(),
        owner.address,
        {
          name: "Bridged Vault",
          receiptTokenSymbol: "BVLT",
          collateralToken: await collateralToken.getAddress(),
          admin: admin.address,
          operator: operator.address,
          rateManager: rateManager.address,
          maxRateChangePerUpdate: ethers.parseUnits("0.1", 18),
          feePercentage: 0n,
          minWithdrawableShares: ethers.parseUnits("1", 18),
          rateUpdateInterval: 2 * 60 * 60 * 1000,
          maxTVL: MAX_TVL,
        },
        [],
      ],
      { initializer: "initialize", kind: "uups" }
    )) as EmberVault;

    // An EOA stands in for the CCIP token pool: it is the only caller of bridgeMint/bridgeBurn.
    await protocolConfig
      .connect(admin)
      .setVaultBridgeAdapter(await vault.getAddress(), bridge.address);

    for (const user of [user1, user2]) {
      await collateralToken.connect(owner).transfer(user.address, ethers.parseUnits("100000", 18));
    }
  });

  describe("the bypass", function () {
    it("does not let bridging shares out free cap room for another deposit", async function () {
      await deposit(user1, MAX_TVL);
      await vault.connect(bridge).bridgeBurn(user1.address, await vault.balanceOf(user1.address));

      // Local supply is back to zero, which is what used to reopen the full cap.
      expect(await vault.totalSupply()).to.equal(0n);
      expect(await vault.maxDeposit(user1.address)).to.equal(0n);
      expect(await vault.maxMint(user1.address)).to.equal(0n);

      await expect(deposit(user1, ethers.parseUnits("1", 18))).to.be.revertedWithCustomError(
        vault,
        "MaxTVLReached"
      );
    });

    it("closes the mint path too, not just deposit", async function () {
      await deposit(user1, MAX_TVL);
      await vault.connect(bridge).bridgeBurn(user1.address, await vault.balanceOf(user1.address));

      const shares = await vault.convertToShares(ethers.parseUnits("1", 18));
      await collateralToken
        .connect(user1)
        .approve(await vault.getAddress(), ethers.parseUnits("2", 18));
      await expect(vault.connect(user1).mint(shares, user1.address)).to.be.revertedWithCustomError(
        vault,
        "MaxTVLReached"
      );
    });

    it("tracks the counter in shares on both bridge legs", async function () {
      await deposit(user1, MAX_TVL);
      const shares = await vault.balanceOf(user1.address);

      await vault.connect(bridge).bridgeBurn(user1.address, shares);
      expect(await vault.netBridgedOutShares()).to.equal(shares);

      await vault.connect(bridge).bridgeMint(user1.address, shares);
      expect(await vault.netBridgedOutShares()).to.equal(0n);
    });
  });

  describe("inbound mints", function () {
    // The shares were already burned on the source chain; reverting here would strand them.
    it("never reverts, even when it takes local supply over the cap", async function () {
      await deposit(user1, MAX_TVL);
      const extra = await vault.convertToShares(ethers.parseUnits("500", 18));

      await expect(vault.connect(bridge).bridgeMint(user2.address, extra)).to.emit(
        vault,
        "BridgeMint"
      );
      expect(await vault.totalAssets()).to.be.greaterThan(MAX_TVL);
    });

    it("do not eat the room local depositors are entitled to", async function () {
      await vault
        .connect(bridge)
        .bridgeMint(user2.address, await vault.convertToShares(ethers.parseUnits("600", 18)));

      expect(await vault.maxDeposit(user1.address)).to.equal(MAX_TVL);
      await expect(deposit(user1, MAX_TVL)).to.emit(vault, "VaultDeposit");
    });

    it("returning home leaves the cap exactly as full as before the round trip", async function () {
      await deposit(user1, MAX_TVL);
      const shares = await vault.balanceOf(user1.address);

      await vault.connect(bridge).bridgeBurn(user1.address, shares);
      await vault.connect(bridge).bridgeMint(user1.address, shares);

      expect(await vault.maxDeposit(user1.address)).to.equal(0n);
      await expect(deposit(user1, ethers.parseUnits("1", 18))).to.be.revertedWithCustomError(
        vault,
        "MaxTVLReached"
      );
    });
  });

  describe("a net importer", function () {
    // Redeeming imported shares here destroys them, so the cap gives that room back: supply
    // across every chain still cannot exceed the sum of their caps.
    it("regains exactly the room its redemptions took out of circulation", async function () {
      const imported = await vault.convertToShares(ethers.parseUnits("500", 18));
      await vault.connect(bridge).bridgeMint(user2.address, imported);

      // The assets backing imported shares arrive out of band, as the operator rebalances.
      await collateralToken
        .connect(owner)
        .transfer(await vault.getAddress(), ethers.parseUnits("500", 18));
      await vault.connect(user2).approve(await vault.getAddress(), imported);
      await vault.connect(user2).redeemShares(imported, user2.address);
      await vault.connect(operator).processWithdrawalRequests(1);

      expect(await vault.totalSupply()).to.equal(0n);
      expect(await vault.netBridgedOutShares()).to.equal(-imported);
      // The view reads a negative sum as zero, so it under-reports here — never over-reports.
      expect(await vault.maxDeposit(user1.address)).to.equal(MAX_TVL);

      await expect(deposit(user1, ethers.parseUnits("1500", 18))).to.emit(vault, "VaultDeposit");
      await expect(deposit(user1, ethers.parseUnits("1", 18))).to.be.revertedWithCustomError(
        vault,
        "MaxTVLReached"
      );
    });
  });

  // The config refuses a new cap below the vault's current TVL. It has to measure TVL the way the
  // deposit cap now does, or bridging out makes room to set a cap below what the vault counts.
  describe("updateVaultMaxTVL guard", function () {
    it("rejects a cap below what the vault counts after bridging out", async function () {
      await deposit(user1, MAX_TVL);
      await vault.connect(bridge).bridgeBurn(user1.address, await vault.balanceOf(user1.address));
      expect(await vault.totalAssets()).to.equal(0n);

      await expect(
        protocolConfig
          .connect(admin)
          .updateVaultMaxTVL(await vault.getAddress(), ethers.parseUnits("500", 18))
      ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
    });

    it("still accepts a cap at or above that", async function () {
      await deposit(user1, MAX_TVL);
      await vault.connect(bridge).bridgeBurn(user1.address, await vault.balanceOf(user1.address));

      await protocolConfig
        .connect(admin)
        .updateVaultMaxTVL(await vault.getAddress(), ethers.parseUnits("2000", 18));
      expect(await vault.maxTVL()).to.equal(ethers.parseUnits("2000", 18));
    });

    // updateVaultMaxTVL serves every vault type. One without the counter must keep working, on
    // the old totalAssets measure, rather than revert on the missing getter.
    it("keeps the old measure for a vault without the counter", async function () {
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
      await ethVault
        .connect(user1)
        .depositETH(user1.address, { value: ethers.parseUnits("5", 18) });
      const ethAddr = await ethVault.getAddress();

      await expect(
        protocolConfig.connect(admin).updateVaultMaxTVL(ethAddr, ethers.parseUnits("4", 18))
      ).to.be.revertedWithCustomError(protocolConfig, "InvalidValue");
      await protocolConfig.connect(admin).updateVaultMaxTVL(ethAddr, ethers.parseUnits("10", 18));
      expect(await ethVault.maxTVL()).to.equal(ethers.parseUnits("10", 18));
    });
  });

  // The counter is normally driven only by bridgeBurn/bridgeMint. The admin override exists for
  // the three states those two cannot reach: an un-seeded upgrade, a burn whose inbound mint can
  // never execute, and cap room that migrated to another chain via redemption of imported shares.
  describe("admin override of the counter", function () {
    it("is gated on admin through the protocol config, not on the operator", async function () {
      const addr = await vault.getAddress();
      await expect(
        protocolConfig.connect(operator).updateVaultNetBridgedOutShares(addr, 0n, 100n)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
      await expect(
        protocolConfig.connect(user1).updateVaultNetBridgedOutShares(addr, 0n, 100n)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
      // and the vault refuses a direct call that bypasses the config entirely
      await expect(
        (vault as any).connect(admin).setNetBridgedOutShares(admin.address, 0n, 100n)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("seeds a vault that bridged before it was upgraded", async function () {
      // Nothing local, but 400 shares left this chain under the old implementation.
      const seeded = ethers.parseUnits("400", 18);
      expect(await vault.maxDeposit(user1.address)).to.equal(MAX_TVL);

      await protocolConfig
        .connect(admin)
        .updateVaultNetBridgedOutShares(await vault.getAddress(), 0n, seeded);

      expect(await vault.netBridgedOutShares()).to.equal(seeded);
      expect(await vault.maxDeposit(user1.address)).to.equal(MAX_TVL - seeded);
      await deposit(user1, MAX_TVL - seeded);
      await expect(deposit(user1, ethers.parseUnits("1", 18))).to.be.revertedWithCustomError(
        vault,
        "MaxTVLReached"
      );
    });

    it("writes off a burn whose inbound mint can never execute", async function () {
      await deposit(user1, MAX_TVL);
      const stuck = ethers.parseUnits("250", 18);
      await vault.connect(bridge).bridgeBurn(user1.address, stuck);
      expect(await vault.netBridgedOutShares()).to.equal(stuck);
      expect(await vault.maxDeposit(user1.address)).to.equal(0n);

      // The destination can never mint, so those shares are gone for good. Releasing the cap
      // room they hold is only safe because no other chain will ever count them.
      await protocolConfig
        .connect(admin)
        .updateVaultNetBridgedOutShares(await vault.getAddress(), stuck, 0n);

      expect(await vault.maxDeposit(user1.address)).to.equal(stuck);
    });

    it("rejects a stale expected value, so a racing bridge message is never overwritten", async function () {
      await deposit(user1, MAX_TVL);
      const seen = await vault.netBridgedOutShares(); // admin reads 0 off-chain
      // a bridge message lands before the admin transaction is mined
      await vault.connect(bridge).bridgeBurn(user1.address, ethers.parseUnits("100", 18));

      await expect(
        protocolConfig
          .connect(admin)
          .updateVaultNetBridgedOutShares(
            await vault.getAddress(),
            seen,
            ethers.parseUnits("50", 18)
          )
      ).to.be.revertedWithCustomError(vault, "UnexpectedNetBridgedOutShares");

      // re-reading and retrying succeeds
      const fresh = await vault.netBridgedOutShares();
      await protocolConfig
        .connect(admin)
        .updateVaultNetBridgedOutShares(
          await vault.getAddress(),
          fresh,
          ethers.parseUnits("50", 18)
        );
      expect(await vault.netBridgedOutShares()).to.equal(ethers.parseUnits("50", 18));
    });

    it("rejects a no-op write and emits the old and new value", async function () {
      await expect(
        protocolConfig
          .connect(admin)
          .updateVaultNetBridgedOutShares(await vault.getAddress(), 0n, 0n)
      ).to.be.revertedWithCustomError(vault, "SameValue");

      await expect(
        protocolConfig
          .connect(admin)
          .updateVaultNetBridgedOutShares(await vault.getAddress(), 0n, -99n)
      )
        .to.emit(vault, "VaultNetBridgedOutSharesUpdated")
        .withArgs(await vault.getAddress(), 0n, -99n, anyValue, anyValue);
    });
  });
});
