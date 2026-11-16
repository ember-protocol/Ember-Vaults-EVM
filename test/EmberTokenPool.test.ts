import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ZeroAddress } from "ethers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * EmberTokenPool — CCIP burn/mint pool for Ember vault share tokens.
 *
 * Scenario set is ported from EmberVaultMintBurnOFTAdapter.test.ts (auth failures, amount
 * bounds, remote-pool checks) and extended with the two Ember-specific deltas: the blacklist
 * check on `originalSender`, and the events that carry the real user.
 *
 * Both `lockOrBurn` overloads are exercised. The single-argument (IPoolV1) one is the path CCIP
 * 1.6 ramps take; the three-argument (IPoolV2) one is what the production 2.0 ramps use, and is
 * the only one that can charge a pool fee or honour faster-than-finality.
 */

// Struct signatures, spelled out because both entrypoints are overloaded.
const LOCK_OR_BURN_V1 = "lockOrBurn((bytes,uint64,address,uint256,address))";
const LOCK_OR_BURN_V2 = "lockOrBurn((bytes,uint64,address,uint256,address),bytes4,bytes)";
const RELEASE_OR_MINT_V1 =
  "releaseOrMint((bytes,uint64,address,uint256,address,bytes,bytes,bytes))";

const REMOTE_CHAIN_SELECTOR = 16098325658947243212n; // pharos-atlantic-testnet
const UNCONFIGURED_SELECTOR = 5009297550715157269n; // ethereum-mainnet
const WAIT_FOR_FINALITY_FLAG = "0x00000000";
// Safe-tag flag in the high half, block depth in the low half. 0x00010001 allows both; a request
// must be one of the allowed shapes, and depth matching is a floor.
const ALLOW_SAFE_AND_DEPTH1 = "0x00010001";
const REQUEST_DEPTH_1 = "0x00000001";
const BPS_DIVIDER = 10_000n;
const SALT = ethers.id("ember.ccip.pool.v1");
const DECIMALS = 18n;

const toUnits = (n: string) => ethers.parseUnits(n, Number(DECIMALS));

describe("EmberTokenPool", () => {
  async function deployFixture() {
    const [deployer, poolOwner, user, receiver, onRamp, offRamp, other] = await ethers.getSigners();

    const config = await (await ethers.getContractFactory("EmberProtocolConfigStub")).deploy();
    const token = await (
      await ethers.getContractFactory("EmberVaultTokenStub")
    ).deploy("Ember pALPHA", "pALPHA", DECIMALS, await config.getAddress());

    const router = await (await ethers.getContractFactory("CCIPRouterStub")).deploy();
    const rmn = await (await ethers.getContractFactory("CCIPRMNStub")).deploy();
    const factory = await (await ethers.getContractFactory("EmberTokenPoolFactory")).deploy();

    const tokenAddress = await token.getAddress();
    const routerAddress = await router.getAddress();
    const rmnAddress = await rmn.getAddress();

    const predicted = await factory.predictPoolAddress(
      tokenAddress,
      DECIMALS,
      ZeroAddress,
      rmnAddress,
      routerAddress,
      deployer.address,
      SALT
    );

    await factory.deployPool(
      tokenAddress,
      DECIMALS,
      ZeroAddress,
      rmnAddress,
      routerAddress,
      poolOwner.address,
      SALT
    );

    const pool = await ethers.getContractAt("EmberTokenPool", predicted);
    await pool.connect(poolOwner).acceptOwnership();

    // The pool is the vault's authorized bridge adapter — this is the cutover step.
    await token.setBridgeAdapter(predicted);

    const remotePool = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [other.address]);
    const remoteToken = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [tokenAddress]);
    const noRateLimit = { isEnabled: false, capacity: 0n, rate: 0n };

    await pool.connect(poolOwner).applyChainUpdates(
      [],
      [
        {
          remoteChainSelector: REMOTE_CHAIN_SELECTOR,
          remotePoolAddresses: [remotePool],
          remoteTokenAddress: remoteToken,
          outboundRateLimiterConfig: noRateLimit,
          inboundRateLimiterConfig: noRateLimit,
        },
      ]
    );

    await router.setOnRamp(REMOTE_CHAIN_SELECTOR, onRamp.address);
    await router.setOffRamp(REMOTE_CHAIN_SELECTOR, offRamp.address, true);

    return {
      deployer,
      poolOwner,
      user,
      receiver,
      onRamp,
      offRamp,
      other,
      config,
      token,
      router,
      rmn,
      factory,
      pool,
      predicted,
      tokenAddress,
      routerAddress,
      rmnAddress,
      remotePool,
      remoteToken,
    };
  }

  /** Simulates what Router.ccipSend does before the onRamp calls lockOrBurn. */
  async function fundPoolFromUser(f: Awaited<ReturnType<typeof deployFixture>>, amount: bigint) {
    await f.token.mint(f.user.address, amount);
    await f.token.connect(f.user).transfer(f.predicted, amount);
  }

  function lockOrBurnIn(f: Awaited<ReturnType<typeof deployFixture>>, amount: bigint) {
    return {
      receiver: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [f.receiver.address]),
      remoteChainSelector: REMOTE_CHAIN_SELECTOR,
      originalSender: f.user.address,
      amount,
      localToken: f.tokenAddress,
    };
  }

  function releaseOrMintIn(f: Awaited<ReturnType<typeof deployFixture>>, amount: bigint) {
    return {
      originalSender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [f.user.address]),
      remoteChainSelector: REMOTE_CHAIN_SELECTOR,
      receiver: f.receiver.address,
      sourceDenominatedAmount: amount,
      localToken: f.tokenAddress,
      sourcePoolAddress: f.remotePool,
      sourcePoolData: "0x",
      offchainTokenData: "0x",
    };
  }

  describe("Deployment", () => {
    it("reports its type and version", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.pool.typeAndVersion()).to.equal("EmberBurnMintTokenPool 1.0.0");
    });

    it("deploys to the CREATE2 address the factory predicts", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.pool.getAddress()).to.equal(f.predicted);
      expect(await f.pool.getToken()).to.equal(f.tokenAddress);
    });

    it("hands ownership to poolOwner via two-step transfer", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.pool.owner()).to.equal(f.poolOwner.address);
    });

    it("is wired as the vault's bridge adapter", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.token.bridgeAdapter()).to.equal(f.predicted);
    });

    it("rejects a zero pool owner", async () => {
      const f = await loadFixture(deployFixture);
      await expect(
        f.factory.deployPool(
          f.tokenAddress,
          DECIMALS,
          ZeroAddress,
          f.rmnAddress,
          f.routerAddress,
          ZeroAddress,
          ethers.id("other")
        )
      ).to.be.revertedWithCustomError(f.factory, "ZeroAddressInvalid");
    });

    it("rejects a decimals mismatch against the token", async () => {
      const f = await loadFixture(deployFixture);
      await expect(
        f.factory.deployPool(
          f.tokenAddress,
          6,
          ZeroAddress,
          f.rmnAddress,
          f.routerAddress,
          f.poolOwner.address,
          ethers.id("wrong-decimals")
        )
      ).to.be.revertedWithCustomError(f.pool, "InvalidDecimalArgs");
    });

    it("namespaces the CREATE2 salt by caller so it cannot be squatted", async () => {
      const f = await loadFixture(deployFixture);
      const mine = await f.factory.predictPoolAddress(
        f.tokenAddress,
        DECIMALS,
        ZeroAddress,
        f.rmnAddress,
        f.routerAddress,
        f.deployer.address,
        SALT
      );
      const theirs = await f.factory.predictPoolAddress(
        f.tokenAddress,
        DECIMALS,
        ZeroAddress,
        f.rmnAddress,
        f.routerAddress,
        f.other.address,
        SALT
      );
      expect(mine).to.not.equal(theirs);
    });
  });

  describe("lockOrBurn — authorization", () => {
    it("rejects a caller that is not the router's onRamp for the lane", async () => {
      const f = await loadFixture(deployFixture);
      await fundPoolFromUser(f, toUnits("10"));
      await expect(
        f.pool.connect(f.other)[LOCK_OR_BURN_V1](lockOrBurnIn(f, toUnits("10")))
      ).to.be.revertedWithCustomError(f.pool, "CallerIsNotARampOnRouter");
    });

    it("rejects a chain that has not been configured", async () => {
      const f = await loadFixture(deployFixture);
      await fundPoolFromUser(f, toUnits("10"));
      const input = {
        ...lockOrBurnIn(f, toUnits("10")),
        remoteChainSelector: UNCONFIGURED_SELECTOR,
      };
      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](input)).to.be.revertedWithCustomError(
        f.pool,
        "ChainNotAllowed"
      );
    });

    it("rejects a token that is not this pool's token", async () => {
      const f = await loadFixture(deployFixture);
      await fundPoolFromUser(f, toUnits("10"));
      const input = { ...lockOrBurnIn(f, toUnits("10")), localToken: f.other.address };
      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](input)).to.be.revertedWithCustomError(
        f.pool,
        "InvalidToken"
      );
    });

    it("rejects when the lane is cursed by RMN", async () => {
      const f = await loadFixture(deployFixture);
      await fundPoolFromUser(f, toUnits("10"));
      await f.rmn.setCursedChain(REMOTE_CHAIN_SELECTOR, true);
      await expect(
        f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, toUnits("10")))
      ).to.be.revertedWithCustomError(f.pool, "CursedByRMN");
    });
  });

  describe("lockOrBurn — burn behaviour", () => {
    it("burns the pool's own balance and reduces total supply", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      expect(await f.token.balanceOf(f.predicted)).to.equal(amount);
      const supplyBefore = await f.token.totalSupply();

      await f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount));

      expect(await f.token.balanceOf(f.predicted)).to.equal(0n);
      expect(await f.token.totalSupply()).to.equal(supplyBefore - amount);
    });

    it("emits EmberBridgeSent carrying the real user, not the ramp", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount)))
        .to.emit(f.pool, "EmberBridgeSent")
        .withArgs(
          REMOTE_CHAIN_SELECTOR,
          f.user.address,
          ethers.AbiCoder.defaultAbiCoder().encode(["address"], [f.receiver.address]),
          amount,
          amount
        );
    });

    it("documents the attribution gap: the vault's BridgeBurn names the pool", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      // This is why indexers must not attribute bridge-outs from BridgeBurn.from — under
      // CCIP it is the pool, never the user. EmberBridgeSent above is the correct source.
      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount)))
        .to.emit(f.token, "BridgeBurn")
        .withArgs(f.tokenAddress, f.predicted, amount);
    });

    it("returns the remote token address for the lane", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      const out = await f.pool
        .connect(f.onRamp)
        [LOCK_OR_BURN_V1].staticCall(lockOrBurnIn(f, amount));
      expect(out.destTokenAddress).to.equal(f.remoteToken);
    });

    it("works through the IPoolV2 entrypoint too", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      await expect(
        f.pool
          .connect(f.onRamp)
          [LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), WAIT_FOR_FINALITY_FLAG, "0x")
      ).to.emit(f.pool, "EmberBridgeSent");

      expect(await f.token.totalSupply()).to.equal(0n);
    });

    it("honours the vault's min/max bridge amounts", async () => {
      const f = await loadFixture(deployFixture);
      await f.token.setBridgeLimits(toUnits("1"), toUnits("100"));

      await fundPoolFromUser(f, toUnits("0.5"));
      await expect(
        f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, toUnits("0.5")))
      ).to.be.revertedWithCustomError(f.token, "BridgeAmountTooSmall");

      await fundPoolFromUser(f, toUnits("200"));
      await expect(
        f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, toUnits("200")))
      ).to.be.revertedWithCustomError(f.token, "BridgeAmountTooLarge");
    });

    it("honours the protocol-level pause", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);
      await f.config.setProtocolPauseStatus(true);

      await expect(
        f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount))
      ).to.be.revertedWithCustomError(f.token, "ProtocolPaused");
    });
  });

  describe("lockOrBurn — blacklist (Ember delta)", () => {
    it("rejects a blacklisted originalSender", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);
      await f.config.setBlacklisted(f.user.address, true);

      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount)))
        .to.be.revertedWithCustomError(f.pool, "SenderBlacklisted")
        .withArgs(f.user.address);
    });

    it("rejects a blacklisted originalSender on the IPoolV2 entrypoint too", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);
      await f.config.setBlacklisted(f.user.address, true);

      await expect(
        f.pool
          .connect(f.onRamp)
          [LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), WAIT_FOR_FINALITY_FLAG, "0x")
      ).to.be.revertedWithCustomError(f.pool, "SenderBlacklisted");
    });

    it("the vault's own check would not have caught it, since `from` is the pool", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      // Blacklisting the pool is what the vault's bridgeBurn actually tests against. The user
      // being blacklisted is invisible to it — hence the pool-level check above.
      await f.config.setBlacklisted(f.predicted, true);
      await expect(
        f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount))
      ).to.be.revertedWithCustomError(f.token, "Blacklisted");
    });

    it("lets a non-blacklisted sender through", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);
      await f.config.setBlacklisted(f.other.address, true);

      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount))).to.not.be
        .reverted;
    });
  });

  describe("lockOrBurn — receiver blacklist (Ember delta)", () => {
    it("rejects a clean sender bridging to a blacklisted receiver", async () => {
      // The receive side applies no policy on purpose, so an unchecked receiver here means the
      // far side mints straight to a blacklisted address — and shares transfer freely from there.
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);
      await f.config.setBlacklisted(f.receiver.address, true);

      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount)))
        .to.be.revertedWithCustomError(f.pool, "ReceiverBlacklisted")
        .withArgs(f.receiver.address);
    });

    // The 2.0 OnRamp normalises `receiver` to the destination family's address width before the
    // pool sees it — 20 raw bytes for EVM — so this is the shape the production lanes actually
    // deliver. Checking only the 32-byte encoding left the blacklist dead on exactly those lanes.
    it("rejects a blacklisted receiver sent as a raw 20-byte address", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);
      await f.config.setBlacklisted(f.receiver.address, true);

      const input = { ...lockOrBurnIn(f, amount), receiver: f.receiver.address };
      expect(ethers.dataLength(input.receiver)).to.equal(20);

      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](input))
        .to.be.revertedWithCustomError(f.pool, "ReceiverBlacklisted")
        .withArgs(f.receiver.address);
    });

    it("rejects it on the IPoolV2 entrypoint too, which is where 20 bytes actually arrive", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);
      await f.config.setBlacklisted(f.receiver.address, true);

      const input = { ...lockOrBurnIn(f, amount), receiver: f.receiver.address };
      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V2](input, WAIT_FOR_FINALITY_FLAG, "0x"))
        .to.be.revertedWithCustomError(f.pool, "ReceiverBlacklisted")
        .withArgs(f.receiver.address);
    });

    it("lets a clean receiver through at 20 bytes", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      const input = { ...lockOrBurnIn(f, amount), receiver: f.receiver.address };
      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](input)).to.emit(
        f.pool,
        "EmberBridgeSent"
      );
    });

    it("ignores a receiver that is neither 20 nor 32 bytes", async () => {
      // A non-EVM destination's address space is not what this blacklist describes, so there is
      // nothing to check rather than something to reject.
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      const input = { ...lockOrBurnIn(f, amount), receiver: "0x1234" };
      await expect(f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](input)).to.emit(
        f.pool,
        "EmberBridgeSent"
      );
    });
  });

  describe("releaseOrMint", () => {
    it("rejects a caller that is not a registered offRamp", async () => {
      const f = await loadFixture(deployFixture);
      await expect(
        f.pool.connect(f.other)[RELEASE_OR_MINT_V1](releaseOrMintIn(f, toUnits("10")))
      ).to.be.revertedWithCustomError(f.pool, "CallerIsNotARampOnRouter");
    });

    it("rejects an unregistered source pool", async () => {
      const f = await loadFixture(deployFixture);
      const input = {
        ...releaseOrMintIn(f, toUnits("10")),
        sourcePoolAddress: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [f.user.address]),
      };
      await expect(
        f.pool.connect(f.offRamp)[RELEASE_OR_MINT_V1](input)
      ).to.be.revertedWithCustomError(f.pool, "InvalidSourcePoolAddress");
    });

    it("rejects when the lane is cursed by RMN", async () => {
      const f = await loadFixture(deployFixture);
      await f.rmn.setCursedChain(REMOTE_CHAIN_SELECTOR, true);
      await expect(
        f.pool.connect(f.offRamp)[RELEASE_OR_MINT_V1](releaseOrMintIn(f, toUnits("10")))
      ).to.be.revertedWithCustomError(f.pool, "CursedByRMN");
    });

    it("mints to the receiver", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");

      await f.pool.connect(f.offRamp)[RELEASE_OR_MINT_V1](releaseOrMintIn(f, amount));

      expect(await f.token.balanceOf(f.receiver.address)).to.equal(amount);
      expect(await f.token.totalSupply()).to.equal(amount);
    });

    it("emits EmberBridgeReceived with the source-chain sender", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");

      await expect(f.pool.connect(f.offRamp)[RELEASE_OR_MINT_V1](releaseOrMintIn(f, amount)))
        .to.emit(f.pool, "EmberBridgeReceived")
        .withArgs(
          REMOTE_CHAIN_SELECTOR,
          f.receiver.address,
          ethers.AbiCoder.defaultAbiCoder().encode(["address"], [f.user.address]),
          amount
        );
    });

    it("emits the vault's BridgeMint with the real receiver", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");

      // Unlike BridgeBurn, this one is correctly attributed — `to` is the user.
      await expect(f.pool.connect(f.offRamp)[RELEASE_OR_MINT_V1](releaseOrMintIn(f, amount)))
        .to.emit(f.token, "BridgeMint")
        .withArgs(f.tokenAddress, f.receiver.address, amount);
    });

    it("does not blacklist-gate the receive side, matching the vault", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await f.config.setBlacklisted(f.receiver.address, true);

      // Inbound must not revert or funds strand in flight; the redeem path gates at exit.
      await expect(f.pool.connect(f.offRamp)[RELEASE_OR_MINT_V1](releaseOrMintIn(f, amount))).to.not
        .be.reverted;
      expect(await f.token.balanceOf(f.receiver.address)).to.equal(amount);
    });
  });

  describe("Round trip", () => {
    it("conserves supply across a burn on one side and a mint on the other", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("25");

      await fundPoolFromUser(f, amount);
      await f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount));
      expect(await f.token.totalSupply()).to.equal(0n);
      expect(await f.token.balanceOf(f.user.address)).to.equal(0n);

      // Same pool standing in for the remote side.
      await f.pool.connect(f.offRamp)[RELEASE_OR_MINT_V1](releaseOrMintIn(f, amount));
      expect(await f.token.totalSupply()).to.equal(amount);
      expect(await f.token.balanceOf(f.receiver.address)).to.equal(amount);
    });
  });

  describe("Lane configuration", () => {
    it("only the owner can apply chain updates", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.pool.connect(f.other).applyChainUpdates([], [])).to.be.reverted;
    });

    it("removing the lane stops outbound transfers", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      await f.pool.connect(f.poolOwner).applyChainUpdates([REMOTE_CHAIN_SELECTOR], []);

      await expect(
        f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount))
      ).to.be.revertedWithCustomError(f.pool, "ChainNotAllowed");
    });

    it("reports the configured remote token and pool", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.pool.getRemoteToken(REMOTE_CHAIN_SELECTOR)).to.equal(f.remoteToken);
      expect(await f.pool.isRemotePool(REMOTE_CHAIN_SELECTOR, f.remotePool)).to.equal(true);
      expect(await f.pool.isSupportedChain(REMOTE_CHAIN_SELECTOR)).to.equal(true);
      expect(await f.pool.isSupportedToken(f.tokenAddress)).to.equal(true);
    });
  });

  // CCIP 2.0 adds two behaviours the 1.6 path cannot express: a pool fee deducted from the
  // transfer, and faster-than-finality. Both are configured off by default and the RFC commits
  // to keeping fees at zero, but "we intend to run at zero" is not the same as "nonzero is
  // untested" — these pin what happens when either is switched on.
  describe("CCIP 2.0 — pool fees", () => {
    const FEE_BPS = 100n; // 1%
    const FF_FEE_BPS = 250n; // 2.5%

    async function enableFees(f: Awaited<ReturnType<typeof deployFixture>>) {
      await f.pool.connect(f.poolOwner).applyTokenTransferFeeConfigUpdates(
        [
          {
            destChainSelector: REMOTE_CHAIN_SELECTOR,
            tokenTransferFeeConfig: {
              destGasOverhead: 90_000,
              destBytesOverhead: 32,
              finalityFeeUSDCents: 0,
              fastFinalityFeeUSDCents: 0,
              finalityTransferFeeBps: FEE_BPS,
              fastFinalityTransferFeeBps: FF_FEE_BPS,
              isEnabled: true,
            },
          },
        ],
        []
      );
    }

    it("emits EmberBridgeFeeRetained so the retained shares are reconcilable", async () => {
      // Nothing else records them: EmberBridgeSent reports gross and burned, the vault's
      // BridgeBurn reports only the burned part, and the eventual withdrawFeeTokens payout is a
      // plain ERC-20 Transfer the indexer cannot attribute to a bridge.
      const f = await loadFixture(deployFixture);
      await enableFees(f);

      const amount = toUnits("100");
      const fee = (amount * FEE_BPS) / BPS_DIVIDER;
      await fundPoolFromUser(f, amount);

      await expect(
        f.pool
          .connect(f.onRamp)
          [LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), WAIT_FOR_FINALITY_FLAG, "0x")
      )
        .to.emit(f.pool, "EmberBridgeFeeRetained")
        .withArgs(REMOTE_CHAIN_SELECTOR, fee);
    });

    it("does not emit a fee event when no fee is charged", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("100");
      await fundPoolFromUser(f, amount);

      await expect(
        f.pool
          .connect(f.onRamp)
          [LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), WAIT_FOR_FINALITY_FLAG, "0x")
      ).to.not.emit(f.pool, "EmberBridgeFeeRetained");
    });

    it("burns net of the fee and leaves the fee in the pool", async () => {
      const f = await loadFixture(deployFixture);
      await enableFees(f);

      const amount = toUnits("100");
      const fee = (amount * FEE_BPS) / BPS_DIVIDER;
      const net = amount - fee;
      await fundPoolFromUser(f, amount);

      await f.pool
        .connect(f.onRamp)
        [LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), WAIT_FOR_FINALITY_FLAG, "0x");

      // The onRamp moved the gross amount in; only the net is burned. The fee stays behind as
      // real vault shares held by the pool — they are not destroyed, and they are still counted
      // on this chain, which is what keeps the vault's share accounting whole.
      expect(await f.token.balanceOf(f.predicted)).to.equal(fee);
      expect(await f.token.totalSupply()).to.equal(fee);
    });

    it("reports gross and burned separately on EmberBridgeSent", async () => {
      const f = await loadFixture(deployFixture);
      await enableFees(f);

      const amount = toUnits("100");
      const net = amount - (amount * FEE_BPS) / BPS_DIVIDER;
      await fundPoolFromUser(f, amount);

      await expect(
        f.pool
          .connect(f.onRamp)
          [LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), WAIT_FOR_FINALITY_FLAG, "0x")
      )
        .to.emit(f.pool, "EmberBridgeSent")
        .withArgs(REMOTE_CHAIN_SELECTOR, f.user.address, anyValue, amount, net);
    });

    it("the vault's BridgeBurn records the net, not the gross", async () => {
      const f = await loadFixture(deployFixture);
      await enableFees(f);

      const amount = toUnits("100");
      const net = amount - (amount * FEE_BPS) / BPS_DIVIDER;
      await fundPoolFromUser(f, amount);

      await expect(
        f.pool
          .connect(f.onRamp)
          [LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), WAIT_FOR_FINALITY_FLAG, "0x")
      )
        .to.emit(f.token, "BridgeBurn")
        .withArgs(f.tokenAddress, f.predicted, net);
    });

    it("charges nothing when the fee config is left disabled — the configuration we ship", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("100");
      await fundPoolFromUser(f, amount);

      await f.pool
        .connect(f.onRamp)
        [LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), WAIT_FOR_FINALITY_FLAG, "0x");

      expect(await f.token.totalSupply()).to.equal(0n);
      expect(await f.token.balanceOf(f.predicted)).to.equal(0n);
    });

    it("the IPoolV1 path is never charged a fee, even with one configured", async () => {
      const f = await loadFixture(deployFixture);
      await enableFees(f);

      const amount = toUnits("100");
      await fundPoolFromUser(f, amount);

      await f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, amount));

      // 1.6 ramps pass feeAmount 0, so gross == burned and nothing is retained.
      expect(await f.token.totalSupply()).to.equal(0n);
    });
  });

  describe("CCIP 2.0 — faster than finality", () => {
    it("rejects a non-default finality request until the pool allows it", async () => {
      const f = await loadFixture(deployFixture);
      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      await expect(
        f.pool.connect(f.onRamp)[LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), REQUEST_DEPTH_1, "0x")
      ).to.be.reverted;
    });

    it("accepts the request once allowedFinality permits it", async () => {
      const f = await loadFixture(deployFixture);
      await f.pool.connect(f.poolOwner).setAllowedFinalityConfig(ALLOW_SAFE_AND_DEPTH1);
      expect(await f.pool.getAllowedFinalityConfig()).to.equal(ALLOW_SAFE_AND_DEPTH1);

      const amount = toUnits("10");
      await fundPoolFromUser(f, amount);

      await expect(
        f.pool.connect(f.onRamp)[LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), REQUEST_DEPTH_1, "0x")
      ).to.emit(f.pool, "EmberBridgeSent");
      expect(await f.token.totalSupply()).to.equal(0n);
    });

    it("an FTF transfer is charged the fast-finality rate, not the default one", async () => {
      const f = await loadFixture(deployFixture);
      await f.pool.connect(f.poolOwner).setAllowedFinalityConfig(ALLOW_SAFE_AND_DEPTH1);
      await f.pool.connect(f.poolOwner).applyTokenTransferFeeConfigUpdates(
        [
          {
            destChainSelector: REMOTE_CHAIN_SELECTOR,
            tokenTransferFeeConfig: {
              destGasOverhead: 90_000,
              destBytesOverhead: 32,
              finalityFeeUSDCents: 0,
              fastFinalityFeeUSDCents: 0,
              finalityTransferFeeBps: 100n, // 1%
              fastFinalityTransferFeeBps: 250n, // 2.5% — the one that must apply
              isEnabled: true,
            },
          },
        ],
        []
      );

      const amount = toUnits("100");
      const ffFee = (amount * 250n) / BPS_DIVIDER;
      await fundPoolFromUser(f, amount);

      await f.pool
        .connect(f.onRamp)
        [LOCK_OR_BURN_V2](lockOrBurnIn(f, amount), REQUEST_DEPTH_1, "0x");

      // 2.5% retained, not 1% — picking the wrong branch here would under- or over-deliver.
      expect(await f.token.balanceOf(f.predicted)).to.equal(ffFee);
    });

    it("rate limits for fast finality are a separate bucket from the default one", async () => {
      const f = await loadFixture(deployFixture);
      const limited = { isEnabled: true, capacity: toUnits("5"), rate: toUnits("1") };

      await f.pool.connect(f.poolOwner).setRateLimitConfig([
        {
          remoteChainSelector: REMOTE_CHAIN_SELECTOR,
          fastFinality: true,
          outboundRateLimiterConfig: limited,
          inboundRateLimiterConfig: limited,
        },
      ]);

      const [ffOut] = await f.pool.getCurrentRateLimiterState(REMOTE_CHAIN_SELECTOR, true);
      const [normalOut] = await f.pool.getCurrentRateLimiterState(REMOTE_CHAIN_SELECTOR, false);
      expect(ffOut.isEnabled).to.equal(true);
      expect(ffOut.capacity).to.equal(toUnits("5"));
      // Setting the FTF bucket must not have touched the default one.
      expect(normalOut.isEnabled).to.equal(false);
    });

    it("setRateLimitConfig refills the bucket even when the config is unchanged", async () => {
      const f = await loadFixture(deployFixture);
      const limited = { isEnabled: true, capacity: toUnits("5"), rate: toUnits("1") };
      const args = [
        {
          remoteChainSelector: REMOTE_CHAIN_SELECTOR,
          fastFinality: false,
          outboundRateLimiterConfig: limited,
          inboundRateLimiterConfig: limited,
        },
      ];
      await f.pool.connect(f.poolOwner).setRateLimitConfig(args);

      // Spend most of the bucket.
      const spend = toUnits("4");
      await fundPoolFromUser(f, spend);
      await f.pool.connect(f.onRamp)[LOCK_OR_BURN_V1](lockOrBurnIn(f, spend));
      const afterSpend = (await f.pool.getCurrentRateLimiterState(REMOTE_CHAIN_SELECTOR, false))[0];
      expect(afterSpend.tokens).to.be.lessThan(toUnits("5"));

      // Re-apply the SAME config. RateLimiter._setTokenBucketConfig assigns tokens = capacity
      // unconditionally, so this hands back a full bucket and permits another burst. That is why
      // apply-chain-updates.ts compares first and skips the write when nothing changed.
      await f.pool.connect(f.poolOwner).setRateLimitConfig(args);
      const afterRewrite = (
        await f.pool.getCurrentRateLimiterState(REMOTE_CHAIN_SELECTOR, false)
      )[0];
      expect(afterRewrite.tokens).to.equal(toUnits("5"));
    });

    it("applyChainUpdates removal wipes the FTF config — why the script never removes a live lane", async () => {
      const f = await loadFixture(deployFixture);
      const limited = { isEnabled: true, capacity: toUnits("5"), rate: toUnits("1") };
      await f.pool.connect(f.poolOwner).setRateLimitConfig([
        {
          remoteChainSelector: REMOTE_CHAIN_SELECTOR,
          fastFinality: true,
          outboundRateLimiterConfig: limited,
          inboundRateLimiterConfig: limited,
        },
      ]);
      expect(
        (await f.pool.getCurrentRateLimiterState(REMOTE_CHAIN_SELECTOR, true))[0].isEnabled
      ).to.equal(true);

      const noRateLimit = { isEnabled: false, capacity: 0n, rate: 0n };
      await f.pool.connect(f.poolOwner).applyChainUpdates(
        [REMOTE_CHAIN_SELECTOR],
        [
          {
            remoteChainSelector: REMOTE_CHAIN_SELECTOR,
            remotePoolAddresses: [f.remotePool],
            remoteTokenAddress: f.remoteToken,
            outboundRateLimiterConfig: noRateLimit,
            inboundRateLimiterConfig: noRateLimit,
          },
        ]
      );

      // Gone. This is the behaviour apply-chain-updates.ts now avoids by using
      // setRateLimitConfig / addRemotePool on a lane that already exists.
      expect(
        (await f.pool.getCurrentRateLimiterState(REMOTE_CHAIN_SELECTOR, true))[0].isEnabled
      ).to.equal(false);
    });
  });
});
