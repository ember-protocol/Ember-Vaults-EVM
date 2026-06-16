import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { EmberProtocolConfig } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmberProtocolConfig", function () {
  let config: EmberProtocolConfig;
  let owner: HardhatEthersSigner;
  let unauthorized: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;

  const MIN_RATE = ethers.parseUnits("0.25", 18);
  const MAX_RATE = ethers.parseUnits("5", 18);
  const DEFAULT_RATE = ethers.parseUnits("1", 18);
  const MIN_RATE_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
  const MAX_RATE_INTERVAL = 24 * 60 * 60 * 1000; // 1 day in milliseconds
  const MAX_FEE_PERCENTAGE = ethers.parseUnits("0.1", 18);

  beforeEach(async function () {
    [owner, unauthorized, feeRecipient, guardian] = await ethers.getSigners();

    const configFactory = await ethers.getContractFactory("EmberProtocolConfig");
    config = (await upgrades.deployProxy(configFactory, [owner.address, feeRecipient.address], {
      initializer: "initialize",
      kind: "uups",
    })) as EmberProtocolConfig;

    await config.waitForDeployment();
  });

  describe("Deployment and initialization", function () {
    it("sets owner and version defaults", async function () {
      expect(await config.owner()).to.equal(owner.address);
      expect(await config.version()).to.equal("v2.1.0");
    });

    it("initializes defaults correctly", async function () {
      expect(await config.getProtocolPauseStatus()).to.be.false;
      expect(await config.getPlatformFeeRecipient()).to.equal(feeRecipient.address);
      expect(await config.getMinRate()).to.equal(MIN_RATE);
      expect(await config.getMaxRate()).to.equal(MAX_RATE);
      expect(await config.getDefaultRate()).to.equal(DEFAULT_RATE);
      expect(await config.getMinRateInterval()).to.equal(MIN_RATE_INTERVAL);
      expect(await config.getMaxRateInterval()).to.equal(MAX_RATE_INTERVAL);
      expect(await config.getMaxAllowedFeePercentage()).to.equal(MAX_FEE_PERCENTAGE);
    });

    it("prevents reinitialization", async function () {
      await expect(
        config.initialize(owner.address, feeRecipient.address)
      ).to.be.revertedWithCustomError(config, "InvalidInitialization");
    });

    it("does not allow zero platform fee recipient", async function () {
      const configFactory = await ethers.getContractFactory("EmberProtocolConfig");
      await expect(
        upgrades.deployProxy(configFactory, [owner.address, ethers.ZeroAddress], {
          initializer: "initialize",
          kind: "uups",
        })
      ).to.be.revertedWithCustomError(config, "ZeroAddress");
    });
  });

  describe("Access control", function () {
    it("blocks non-owner from pausing", async function () {
      await expect(config.connect(unauthorized).pauseNonAdminOperations(true))
        .to.be.revertedWithCustomError(config, "OwnableUnauthorizedAccount")
        .withArgs(unauthorized.address);
    });

    it("blocks non-owner from updating the fee recipient", async function () {
      await expect(config.connect(unauthorized).updatePlatformFeeRecipient(unauthorized.address))
        .to.be.revertedWithCustomError(config, "OwnableUnauthorizedAccount")
        .withArgs(unauthorized.address);
    });

    it("blocks non-owner from changing the min rate", async function () {
      await expect(config.connect(unauthorized).updateMinRate(ethers.parseUnits("2", 18)))
        .to.be.revertedWithCustomError(config, "OwnableUnauthorizedAccount")
        .withArgs(unauthorized.address);
    });
  });

  describe("Blacklist control", function () {
    const victimAddress = ethers.Wallet.createRandom().address;

    it("allows owner to toggle blacklist status", async function () {
      expect(await config.isAccountBlacklisted(victimAddress)).to.be.false;

      await expect(config.setBlacklistedAccount(victimAddress, true))
        .to.emit(config, "BlacklistedAccountUpdated")
        .withArgs(victimAddress, true);
      expect(await config.isAccountBlacklisted(victimAddress)).to.be.true;

      await expect(config.setBlacklistedAccount(victimAddress, false))
        .to.emit(config, "BlacklistedAccountUpdated")
        .withArgs(victimAddress, false);
      expect(await config.isAccountBlacklisted(victimAddress)).to.be.false;
    });

    it("reverts when owner tries to reapply same state", async function () {
      await config.setBlacklistedAccount(victimAddress, true);

      await expect(config.setBlacklistedAccount(victimAddress, true)).to.be.revertedWithCustomError(
        config,
        "SameValue"
      );
    });

    it("blocks non-owner from updating blacklist", async function () {
      await expect(config.connect(unauthorized).setBlacklistedAccount(victimAddress, true))
        .to.be.revertedWithCustomError(config, "OwnableUnauthorizedAccount")
        .withArgs(unauthorized.address);
    });
  });

  describe("Pause controls", function () {
    it("allows owner to toggle pause state", async function () {
      await expect(config.pauseNonAdminOperations(true))
        .to.emit(config, "PauseNonAdminOperations")
        .withArgs(true);
      expect(await config.getProtocolPauseStatus()).to.be.true;

      await expect(config.pauseNonAdminOperations(false))
        .to.emit(config, "PauseNonAdminOperations")
        .withArgs(false);
      expect(await config.getProtocolPauseStatus()).to.be.false;
    });

    it("reverts when pausing with same value", async function () {
      await config.pauseNonAdminOperations(true);
      await expect(config.pauseNonAdminOperations(true)).to.be.revertedWithCustomError(
        config,
        "SameValue"
      );
    });

    it("reverts verifyProtocolNotPaused when paused", async function () {
      await config.pauseNonAdminOperations(true);
      await expect(config.verifyProtocolNotPaused()).to.be.revertedWithCustomError(
        config,
        "ProtocolPaused"
      );
    });
  });

  describe("Guardian role", function () {
    const victim = ethers.Wallet.createRandom().address;

    describe("setGuardian", function () {
      it("starts unset (address(0))", async function () {
        expect(await config.guardian()).to.equal(ethers.ZeroAddress);
      });

      it("owner can set the guardian and emits GuardianUpdated", async function () {
        await expect(config.setGuardian(guardian.address))
          .to.emit(config, "GuardianUpdated")
          .withArgs(ethers.ZeroAddress, guardian.address);
        expect(await config.guardian()).to.equal(guardian.address);
      });

      it("owner can rotate the guardian", async function () {
        await config.setGuardian(guardian.address);
        await expect(config.setGuardian(unauthorized.address))
          .to.emit(config, "GuardianUpdated")
          .withArgs(guardian.address, unauthorized.address);
        expect(await config.guardian()).to.equal(unauthorized.address);
      });

      it("owner can clear the guardian (address(0)) to disable fast paths", async function () {
        await config.setGuardian(guardian.address);
        await expect(config.setGuardian(ethers.ZeroAddress))
          .to.emit(config, "GuardianUpdated")
          .withArgs(guardian.address, ethers.ZeroAddress);
        expect(await config.guardian()).to.equal(ethers.ZeroAddress);
      });

      it("reverts when setting same value", async function () {
        await config.setGuardian(guardian.address);
        await expect(config.setGuardian(guardian.address)).to.be.revertedWithCustomError(
          config,
          "SameValue"
        );
      });

      it("reverts when setting same value (still unset)", async function () {
        await expect(config.setGuardian(ethers.ZeroAddress)).to.be.revertedWithCustomError(
          config,
          "SameValue"
        );
      });

      it("blocks non-owner from setting the guardian", async function () {
        await expect(config.connect(unauthorized).setGuardian(guardian.address))
          .to.be.revertedWithCustomError(config, "OwnableUnauthorizedAccount")
          .withArgs(unauthorized.address);
      });
    });

    describe("guardianPauseNonAdminOperations", function () {
      it("reverts when guardian is unset (zero address)", async function () {
        // Sanity: guardian unset by default; even passing-from-anyone reverts.
        await expect(
          config.connect(unauthorized).guardianPauseNonAdminOperations(true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
        await expect(
          config.connect(owner).guardianPauseNonAdminOperations(true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
      });

      it("rejects non-guardian (including owner) once guardian is set", async function () {
        await config.setGuardian(guardian.address);
        await expect(
          config.connect(owner).guardianPauseNonAdminOperations(true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
        await expect(
          config.connect(unauthorized).guardianPauseNonAdminOperations(true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
      });

      it("guardian can toggle pause and emits PauseNonAdminOperations", async function () {
        await config.setGuardian(guardian.address);

        await expect(config.connect(guardian).guardianPauseNonAdminOperations(true))
          .to.emit(config, "PauseNonAdminOperations")
          .withArgs(true);
        expect(await config.getProtocolPauseStatus()).to.be.true;

        await expect(config.connect(guardian).guardianPauseNonAdminOperations(false))
          .to.emit(config, "PauseNonAdminOperations")
          .withArgs(false);
        expect(await config.getProtocolPauseStatus()).to.be.false;
      });

      it("reverts when toggling to same value", async function () {
        await config.setGuardian(guardian.address);
        await config.connect(guardian).guardianPauseNonAdminOperations(true);
        await expect(
          config.connect(guardian).guardianPauseNonAdminOperations(true)
        ).to.be.revertedWithCustomError(config, "SameValue");
      });

      it("guardian state is shared with owner pause: owner sees guardian's pause", async function () {
        await config.setGuardian(guardian.address);
        await config.connect(guardian).guardianPauseNonAdminOperations(true);
        // Owner's onlyOwner version sees the same flag and rejects no-op.
        await expect(config.pauseNonAdminOperations(true)).to.be.revertedWithCustomError(
          config,
          "SameValue"
        );
        // Owner can unpause what the guardian paused.
        await expect(config.pauseNonAdminOperations(false))
          .to.emit(config, "PauseNonAdminOperations")
          .withArgs(false);
      });

      it("rejects former guardian after rotation", async function () {
        await config.setGuardian(guardian.address);
        await config.setGuardian(unauthorized.address);
        await expect(
          config.connect(guardian).guardianPauseNonAdminOperations(true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
      });

      it("rejects guardian after being cleared to address(0)", async function () {
        await config.setGuardian(guardian.address);
        await config.setGuardian(ethers.ZeroAddress);
        await expect(
          config.connect(guardian).guardianPauseNonAdminOperations(true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
      });
    });

    describe("guardianSetBlacklistedAccount", function () {
      it("reverts when guardian is unset", async function () {
        await expect(
          config.connect(unauthorized).guardianSetBlacklistedAccount(victim, true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
        await expect(
          config.connect(owner).guardianSetBlacklistedAccount(victim, true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
      });

      it("rejects non-guardian (including owner) once guardian is set", async function () {
        await config.setGuardian(guardian.address);
        await expect(
          config.connect(owner).guardianSetBlacklistedAccount(victim, true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
        await expect(
          config.connect(unauthorized).guardianSetBlacklistedAccount(victim, true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
      });

      it("guardian can toggle blacklist and emits BlacklistedAccountUpdated", async function () {
        await config.setGuardian(guardian.address);

        await expect(config.connect(guardian).guardianSetBlacklistedAccount(victim, true))
          .to.emit(config, "BlacklistedAccountUpdated")
          .withArgs(victim, true);
        expect(await config.isAccountBlacklisted(victim)).to.be.true;

        await expect(config.connect(guardian).guardianSetBlacklistedAccount(victim, false))
          .to.emit(config, "BlacklistedAccountUpdated")
          .withArgs(victim, false);
        expect(await config.isAccountBlacklisted(victim)).to.be.false;
      });

      it("reverts on zero account", async function () {
        await config.setGuardian(guardian.address);
        await expect(
          config.connect(guardian).guardianSetBlacklistedAccount(ethers.ZeroAddress, true)
        ).to.be.revertedWithCustomError(config, "ZeroAddress");
      });

      it("reverts on same value", async function () {
        await config.setGuardian(guardian.address);
        await config.connect(guardian).guardianSetBlacklistedAccount(victim, true);
        await expect(
          config.connect(guardian).guardianSetBlacklistedAccount(victim, true)
        ).to.be.revertedWithCustomError(config, "SameValue");
      });

      it("guardian and owner share the same blacklist storage", async function () {
        await config.setGuardian(guardian.address);
        await config.connect(guardian).guardianSetBlacklistedAccount(victim, true);
        // Owner's onlyOwner version sees the same flag and rejects no-op.
        await expect(config.setBlacklistedAccount(victim, true)).to.be.revertedWithCustomError(
          config,
          "SameValue"
        );
        // Owner can unblacklist what the guardian blacklisted.
        await expect(config.setBlacklistedAccount(victim, false))
          .to.emit(config, "BlacklistedAccountUpdated")
          .withArgs(victim, false);
      });

      it("rejects former guardian after rotation", async function () {
        await config.setGuardian(guardian.address);
        await config.setGuardian(unauthorized.address);
        await expect(
          config.connect(guardian).guardianSetBlacklistedAccount(victim, true)
        ).to.be.revertedWithCustomError(config, "Unauthorized");
      });
    });
  });

  describe("Platform fee recipient updates", function () {
    it("changes recipient and emits event", async function () {
      const newRecipient = unauthorized.address;
      await expect(config.updatePlatformFeeRecipient(newRecipient))
        .to.emit(config, "PlatformFeeRecipientUpdated")
        .withArgs(feeRecipient.address, newRecipient);
      expect(await config.getPlatformFeeRecipient()).to.equal(newRecipient);
    });

    it("rejects invalid recipients", async function () {
      await expect(
        config.updatePlatformFeeRecipient(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(config, "ZeroAddress");
      await expect(
        config.updatePlatformFeeRecipient(feeRecipient.address)
      ).to.be.revertedWithCustomError(config, "SameValue");
    });
  });

  describe("Rate configuration", function () {
    it("rejects zero min rate", async function () {
      await expect(config.updateMinRate(0)).to.be.revertedWithCustomError(config, "InvalidRate");
    });

    it("rejects min rate above default rate", async function () {
      const newMinRate = ethers.parseUnits("2", 18); // 2 > default (1)
      await expect(config.updateMinRate(newMinRate)).to.be.revertedWithCustomError(
        config,
        "InvalidRate"
      );
    });

    it("rejects min rate above max rate", async function () {
      const newMinRate = ethers.parseUnits("6", 18); // 6 > max (5)
      await expect(config.updateMinRate(newMinRate)).to.be.revertedWithCustomError(
        config,
        "InvalidRate"
      );
    });

    it("allows min rate that is > 0 and <= default and <= max", async function () {
      const newMinRate = ethers.parseUnits("0.5", 18); // 0.5 > 0, <= default (1), <= max (5)
      const previous = await config.getMinRate();
      await expect(config.updateMinRate(newMinRate))
        .to.emit(config, "MinRateUpdated")
        .withArgs(previous, newMinRate);
      expect(await config.getMinRate()).to.equal(newMinRate);
    });

    it("rejects min rate equal to current min rate", async function () {
      const currentMinRate = await config.getMinRate();
      await expect(config.updateMinRate(currentMinRate)).to.be.revertedWithCustomError(
        config,
        "SameValue"
      );
    });

    it("updates max rate and enforces bounds", async function () {
      // First update min rate to a valid value (must be <= default and <= max)
      const chosenMin = ethers.parseUnits("0.3", 18); // 0.3 <= default (1) and <= max (5)
      await config.updateMinRate(chosenMin);

      await expect(
        config.updateMaxRate(ethers.parseUnits("0.2", 18))
      ).to.be.revertedWithCustomError(config, "InvalidRate");

      const newMaxRate = ethers.parseUnits("7", 18);
      const previous = await config.getMaxRate();
      await expect(config.updateMaxRate(newMaxRate))
        .to.emit(config, "MaxRateUpdated")
        .withArgs(previous, newMaxRate);
      expect(await config.getMaxRate()).to.equal(newMaxRate);
    });

    it("updates default rate within bounds", async function () {
      // First update min rate to a valid value (must be <= default and <= max)
      const chosenMin = ethers.parseUnits("0.3", 18); // 0.3 <= default (1) and <= max (5)
      await config.updateMinRate(chosenMin);

      const maxRate = ethers.parseUnits("6", 18);
      await config.updateMaxRate(maxRate);

      // Cannot update default to same value
      await expect(config.updateDefaultRate(DEFAULT_RATE)).to.be.revertedWithCustomError(
        config,
        "SameValue"
      );

      // Update default to a value between min and max
      const newDefault = ethers.parseUnits("2", 18);
      const previous = await config.getDefaultRate();
      await expect(config.updateDefaultRate(newDefault))
        .to.emit(config, "DefaultRateUpdated")
        .withArgs(previous, newDefault);
      expect(await config.getDefaultRate()).to.equal(newDefault);
    });
  });

  describe("Fee and interval configuration", function () {
    it("updates max fee percentage within limit", async function () {
      const newFee = MAX_FEE_PERCENTAGE - 1n;
      const previous = await config.getMaxAllowedFeePercentage();
      await expect(config.updateMaxFeePercentage(newFee))
        .to.emit(config, "MaxAllowedFeePercentageUpdated")
        .withArgs(previous, newFee);
      expect(await config.getMaxAllowedFeePercentage()).to.equal(newFee);
    });

    it("rejects fee percentages greater than the max", async function () {
      await expect(
        config.updateMaxFeePercentage(MAX_FEE_PERCENTAGE + 1n)
      ).to.be.revertedWithCustomError(config, "InvalidFeePercentage");
    });

    it("updates min rate interval and enforces bounds", async function () {
      // Use 2 hours in milliseconds (valid: between 1 hour and 1 day)
      const newInterval = 2 * 60 * 60 * 1000;
      const previous = await config.getMinRateInterval();
      await expect(config.updateMinRateInterval(newInterval))
        .to.emit(config, "MinRateIntervalUpdated")
        .withArgs(previous, newInterval);
      expect(await config.getMinRateInterval()).to.equal(newInterval);

      // Test with value less than minimum (30,000 ms = 30 seconds, but min is 60,000 ms = 1 minute)
      await expect(config.updateMinRateInterval(30 * 1000)).to.be.revertedWithCustomError(
        config,
        "InvalidInterval"
      );
      // Test with value greater than max rate interval
      await expect(
        config.updateMinRateInterval(MAX_RATE_INTERVAL + 1)
      ).to.be.revertedWithCustomError(config, "InvalidInterval");
    });

    it("updates max rate interval and enforces bounds", async function () {
      // Use 12 hours in milliseconds (valid: between current min and max)
      const newInterval = 12 * 60 * 60 * 1000;
      const previous = await config.getMaxRateInterval();
      await expect(config.updateMaxRateInterval(newInterval))
        .to.emit(config, "MaxRateIntervalUpdated")
        .withArgs(previous, newInterval);
      expect(await config.getMaxRateInterval()).to.equal(newInterval);

      // Test with value less than min rate interval (1 hour)
      await expect(
        config.updateMaxRateInterval(30 * 60 * 1000) // 30 minutes
      ).to.be.revertedWithCustomError(config, "InvalidInterval");
      // Test with value greater than MAX_RATE_INTERVAL
      await expect(
        config.updateMaxRateInterval(MAX_RATE_INTERVAL + 1)
      ).to.be.revertedWithCustomError(config, "InvalidInterval");
    });
  });
});
