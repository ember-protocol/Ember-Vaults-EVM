import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type {
  EmberVaultMintBurnOFTAdapter,
  EmberProtocolConfig,
  EmberVault,
  ERC20Token,
  LayerZeroEndpointStub,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmberVaultMintBurnOFTAdapter — guardian pause", function () {
  let adapter: EmberVaultMintBurnOFTAdapter;
  let protocolConfig: EmberProtocolConfig;
  let vault: EmberVault;
  let endpoint: LayerZeroEndpointStub;
  let collateralToken: ERC20Token;

  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let rateManager: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let delegate: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, admin, operator, rateManager, feeRecipient, guardian, stranger, delegate] =
      await ethers.getSigners();

    // Protocol config
    const PCFactory = await ethers.getContractFactory("EmberProtocolConfig");
    protocolConfig = (await upgrades.deployProxy(PCFactory, [owner.address, feeRecipient.address], {
      initializer: "initialize",
      kind: "uups",
    })) as unknown as EmberProtocolConfig;
    await protocolConfig.waitForDeployment();

    // Install guardian
    await protocolConfig.connect(owner).setGuardian(guardian.address);

    // Collateral token (only needed because EmberVault.initialize wants one)
    const ERC20Factory = await ethers.getContractFactory("ERC20Token");
    collateralToken = (await upgrades.deployProxy(
      ERC20Factory,
      [owner.address, "Collateral", "COLL", 6, ethers.parseUnits("1000000", 6)],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as ERC20Token;
    await collateralToken.waitForDeployment();

    // Vault — used as the IBridgeable token for the adapter's constructor.
    // Initializer rules require admin/operator/rateManager to be distinct.
    const vaultFactory = await ethers.getContractFactory("EmberVault");
    const vaultInit = {
      name: "Test Vault",
      receiptTokenSymbol: "tVLT",
      collateralToken: await collateralToken.getAddress(),
      admin: admin.address,
      operator: operator.address,
      rateManager: rateManager.address,
      maxRateChangePerUpdate: ethers.parseUnits("0.1", 18),
      feePercentage: ethers.parseUnits("0.05", 18),
      minWithdrawableShares: ethers.parseUnits("1", 18),
      rateUpdateInterval: 2 * 60 * 60 * 1000,
      maxTVL: ethers.parseUnits("1000000", 18),
    };
    vault = (await upgrades.deployProxy(
      vaultFactory,
      [await protocolConfig.getAddress(), owner.address, vaultInit, []],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as EmberVault;
    await vault.waitForDeployment();

    // Minimal LZ endpoint stub (OApp constructor only calls setDelegate)
    const StubFactory = await ethers.getContractFactory("LayerZeroEndpointStub");
    endpoint = (await StubFactory.deploy()) as unknown as LayerZeroEndpointStub;
    await endpoint.waitForDeployment();

    // Adapter under test
    const AdapterFactory = await ethers.getContractFactory("EmberVaultMintBurnOFTAdapter");
    adapter = (await AdapterFactory.deploy(
      await vault.getAddress(),
      await endpoint.getAddress(),
      delegate.address,
      await protocolConfig.getAddress()
    )) as unknown as EmberVaultMintBurnOFTAdapter;
    await adapter.waitForDeployment();
  });

  describe("Construction", function () {
    it("reverts when protocolConfig is the zero address", async function () {
      const StubFactory = await ethers.getContractFactory("LayerZeroEndpointStub");
      const stub = await StubFactory.deploy();
      await stub.waitForDeployment();

      const Factory = await ethers.getContractFactory("EmberVaultMintBurnOFTAdapter");
      await expect(
        Factory.deploy(
          await vault.getAddress(),
          await stub.getAddress(),
          delegate.address,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });

    it("records the protocolConfig address as immutable", async function () {
      expect(await adapter.protocolConfig()).to.equal(await protocolConfig.getAddress());
    });

    it("starts unpaused", async function () {
      expect(await adapter.paused()).to.equal(false);
    });
  });

  describe("Pause / unpause (guardian-only)", function () {
    it("guardian can pause and unpause", async function () {
      await adapter.connect(guardian).pause();
      expect(await adapter.paused()).to.equal(true);
      await adapter.connect(guardian).unpause();
      expect(await adapter.paused()).to.equal(false);
    });

    it("rejects owner — pause is guardian-only", async function () {
      await expect(adapter.connect(delegate).pause()).to.be.revertedWithCustomError(
        adapter,
        "Unauthorized"
      );
      // Even after the guardian pauses, owner can't unpause
      await adapter.connect(guardian).pause();
      await expect(adapter.connect(delegate).unpause()).to.be.revertedWithCustomError(
        adapter,
        "Unauthorized"
      );
    });

    it("rejects an arbitrary EOA", async function () {
      await expect(adapter.connect(stranger).pause()).to.be.revertedWithCustomError(
        adapter,
        "Unauthorized"
      );
      await expect(adapter.connect(stranger).unpause()).to.be.revertedWithCustomError(
        adapter,
        "Unauthorized"
      );
    });

    it("rejects the former guardian after rotation", async function () {
      await protocolConfig.connect(owner).setGuardian(stranger.address);
      await expect(adapter.connect(guardian).pause()).to.be.revertedWithCustomError(
        adapter,
        "Unauthorized"
      );
      // New guardian works
      await adapter.connect(stranger).pause();
      expect(await adapter.paused()).to.equal(true);
    });

    it("rejects every caller when guardian is cleared to address(0)", async function () {
      await protocolConfig.connect(owner).setGuardian(ethers.ZeroAddress);
      for (const s of [guardian, owner, delegate, stranger, admin]) {
        await expect(adapter.connect(s).pause()).to.be.revertedWithCustomError(
          adapter,
          "Unauthorized"
        );
      }
    });

    it("reverts pause when already paused", async function () {
      await adapter.connect(guardian).pause();
      await expect(adapter.connect(guardian).pause()).to.be.revertedWithCustomError(
        adapter,
        "EnforcedPause"
      );
    });

    it("reverts unpause when not paused", async function () {
      await expect(adapter.connect(guardian).unpause()).to.be.revertedWithCustomError(
        adapter,
        "ExpectedPause"
      );
    });
  });
});
