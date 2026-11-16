import { ethers } from "hardhat";
import * as fs from "fs";
import { getCcipConfig, getRemoteConfig, poolKeyForVault } from "../../config/ccip.config";

/**
 * Bridges vault shares through CCIP.
 *
 * The user interacts with the ROUTER, never the pool — `lockOrBurn` is gated on the caller
 * being the router's onRamp for the lane. The Router pulls the shares from the sender straight
 * into the pool and then calls the pool, which is why the approval target is the Router.
 *
 * Fees are paid at send time, in LINK or the chain's native token. This is the UX change from
 * LayerZero, where the adapter billed a MessagingFee internally. Note the Router keeps the
 * whole msg.value when paying in native, so quote first and send exactly — do not pad.
 *
 * Required ENV:
 *   VAULT_KEY   Key of the vault in the deployment file
 *   AMOUNT      Human-readable amount, e.g. "1.5" (scaled by the token's decimals)
 *
 * Optional ENV:
 *   RECEIVER        Destination address. Defaults to the sender.
 *   REMOTE_NETWORK  Override the lane partner
 *   FEE_TOKEN       ERC-20 fee token (e.g. LINK). Defaults to native.
 *   GAS_LIMIT       ccipReceive gas limit. Defaults to 0 — correct for a transfer to an EOA.
 *   FINALITY        Requested finality as bytes4, e.g. 0x00010000 for the `safe` tag or
 *                   0x0000000A for a 10-block depth. Omit for full finality. Setting this
 *                   switches the message to ExtraArgsV3, which is the only version that carries
 *                   the field. Must encode exactly one mode (INV-FIN-ENC-1), and every layer —
 *                   pool, executor and CCV — must permit it or the send reverts.
 *   DRY_RUN         "true" to quote only, without sending
 */

const ROUTER_ABI = [
  "function getFee(uint64 destinationChainSelector, (bytes receiver, bytes data, (address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) view returns (uint256)",
  "function ccipSend(uint64 destinationChainSelector, (bytes receiver, bytes data, (address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) payable returns (bytes32)",
  "function isChainSupported(uint64 chainSelector) view returns (bool)",
];

/** GenericExtraArgsV2: tag ++ abi.encode(gasLimit, allowOutOfOrderExecution). */
function encodeExtraArgsV2(gasLimit: bigint, allowOutOfOrder: boolean): string {
  const tag = "0x181dcf10";
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "bool"],
    [gasLimit, allowOutOfOrder]
  );
  return ethers.concat([tag, encoded]);
}

/**
 * GenericExtraArgsV3, the only extra-args version carrying a finality field — V2 has none, so a
 * V2 message always means "wait for full finality" (INV-FIN-ENC-4).
 *
 * Packed, not ABI-encoded: tag(4) ++ gasLimit(uint32) ++ requestedFinalityConfig(bytes4) ++
 * bytes7(0). The trailing seven zero bytes are the length prefixes for the variable-length
 * fields — CCVs, executor, executorArgs, tokenReceiver, tokenArgs — all empty, matching
 * ExtraArgsCodec._getBasicEncodedExtraArgsV3.
 */
function encodeExtraArgsV3(gasLimit: bigint, requestedFinalityConfig: string): string {
  return ethers.concat([
    "0xa69dd4aa",
    ethers.zeroPadValue(ethers.toBeHex(gasLimit), 4),
    requestedFinalityConfig,
    "0x00000000000000",
  ]);
}

/** Human-readable finality mode, for the transfer summary. */
function describeFinality(value: string): string {
  const n = Number(BigInt(value));
  if (n === 0) return "wait for full finality (default)";
  const depth = n & 0xffff;
  if (n & 0x00010000) return "WAIT_FOR_SAFE_FLAG — faster than finality";
  if (depth > 0) return `block depth ${depth} — faster than finality`;
  return "unrecognised";
}

async function main() {
  console.log("\n🚀 Sending vault shares over CCIP...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const local = getCcipConfig(networkName);
  const remote = getRemoteConfig(networkName, process.env.REMOTE_NETWORK);
  const dryRun = process.env.DRY_RUN === "true";

  const vaultKey = process.env.VAULT_KEY;
  const amountRaw = process.env.AMOUNT;
  if (!vaultKey || !amountRaw) {
    console.error("❌ Error: VAULT_KEY and AMOUNT are both required.");
    process.exit(1);
  }

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  const poolInfo = deploymentInfo.contracts.ccipTokenPools?.[poolKeyForVault(vaultKey)];
  if (!poolInfo) {
    console.error(`❌ Error: no CCIP pool recorded for '${vaultKey}' on ${networkName}.`);
    process.exit(1);
  }

  const tokenAddress: string = poolInfo.vaultAddress;
  const token = await ethers.getContractAt("IEmberVaultToken", tokenAddress);
  const erc20 = await ethers.getContractAt(
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
    tokenAddress
  );
  const decimals = await token.decimals();
  const amount = ethers.parseUnits(amountRaw, Number(decimals));
  const receiver = process.env.RECEIVER || signer.address;
  const feeToken = process.env.FEE_TOKEN || ethers.ZeroAddress;
  const gasLimit = BigInt(process.env.GAS_LIMIT || "0");

  console.log("Transfer:");
  console.log("  From chain:", local.label);
  console.log("  To chain:  ", remote.label, `(selector ${remote.chainSelector})`);
  console.log("  Token:     ", tokenAddress, `(${await erc20.symbol()}, ${decimals} decimals)`);
  console.log("  Amount:    ", amountRaw, `(${amount} base units)`);
  console.log("  Sender:    ", signer.address);
  console.log("  Receiver:  ", receiver);
  console.log("  Fee token: ", feeToken === ethers.ZeroAddress ? "native" : feeToken);
  console.log("  Router:    ", local.router);
  console.log();

  // ---- preflight -----------------------------------------------------------------
  const balance = await erc20.balanceOf(signer.address);
  if (balance < amount) {
    console.error(`❌ Error: insufficient balance. Have ${balance}, need ${amount}.`);
    console.log("   Deposit into the vault first so there are shares to bridge.");
    process.exit(1);
  }

  const configuredAdapter = await token.bridgeAdapter();
  if (configuredAdapter.toLowerCase() !== poolInfo.address.toLowerCase()) {
    console.error("❌ Error: the pool is not the vault's bridge adapter — the burn would revert.");
    console.log("   vault.bridgeAdapter():", configuredAdapter);
    console.log("   expected pool:        ", poolInfo.address);
    process.exit(1);
  }

  const router = new ethers.Contract(local.router, ROUTER_ABI, signer);
  if (!(await router.isChainSupported(remote.chainSelector))) {
    console.error("❌ Error: the router does not support this destination chain.");
    process.exit(1);
  }

  const finality = process.env.FINALITY?.toLowerCase();
  if (finality && !/^0x[0-9a-f]{8}$/.test(finality)) {
    console.error(`❌ Error: FINALITY must be a bytes4 hex value, got '${finality}'.`);
    process.exit(1);
  }

  const message = {
    receiver: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [receiver]),
    data: "0x",
    tokenAmounts: [{ token: tokenAddress, amount }],
    feeToken,
    extraArgs: finality ? encodeExtraArgsV3(gasLimit, finality) : encodeExtraArgsV2(gasLimit, true),
  };

  if (finality) {
    console.log("  Finality:  ", finality, "-", describeFinality(finality));
    console.log("             (ExtraArgsV3; a revert here means a layer rejected the mode)");
    console.log();
  }

  // ---- quote ---------------------------------------------------------------------
  const fee: bigint = await router.getFee(remote.chainSelector, message);
  console.log(
    "💰 Quoted fee:",
    ethers.formatEther(fee),
    feeToken === ethers.ZeroAddress ? "native" : ""
  );

  if (feeToken === ethers.ZeroAddress) {
    const nativeBalance = await ethers.provider.getBalance(signer.address);
    if (nativeBalance < fee) {
      console.error(`❌ Error: insufficient native balance for the fee. Have ${nativeBalance}.`);
      process.exit(1);
    }
  }

  if (dryRun) {
    console.log("\nDRY RUN — not sending.\n");
    return;
  }

  // ---- approvals -----------------------------------------------------------------
  const shareAllowance = await erc20.allowance(signer.address, local.router);
  if (shareAllowance < amount) {
    console.log("\nApproving the Router to pull shares...");
    await (await erc20.approve(local.router, amount)).wait();
    console.log("✅ Approved");
  }

  if (feeToken !== ethers.ZeroAddress) {
    const feeErc20 = await ethers.getContractAt(
      "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
      feeToken
    );
    const feeAllowance = await feeErc20.allowance(signer.address, local.router);
    if (feeAllowance < fee) {
      console.log("Approving the Router for the fee token...");
      await (await feeErc20.approve(local.router, fee)).wait();
      console.log("✅ Approved");
    }
  }

  // ---- send ----------------------------------------------------------------------
  console.log("\nCalling Router.ccipSend...");
  const tx = await router.ccipSend(remote.chainSelector, message, {
    value: feeToken === ethers.ZeroAddress ? fee : 0n,
  });
  const receipt = await tx.wait();
  console.log("✅ Sent in block", receipt?.blockNumber);
  console.log("   tx:", receipt?.hash);

  // The messageId is emitted by the OnRamp, not the pool. Surface whatever we can find.
  const poolContract = await ethers.getContractAt("EmberTokenPool", poolInfo.address);
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = poolContract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "EmberBridgeSent") {
        console.log("\n📤 EmberBridgeSent:");
        console.log("   originalSender:", parsed.args.originalSender);
        console.log("   amountGross:   ", parsed.args.amountGross.toString());
        console.log("   amountBurned:  ", parsed.args.amountBurned.toString());
      }
    } catch {
      /* not one of ours */
    }
  }

  console.log("\n💡 Track delivery:");
  console.log(`   https://ccip.chain.link/tx/${receipt?.hash}`);
  console.log("   Delivery lands as ExecutionStateChanged on the destination OffRamp.");
  console.log("   State FAILURE is replayable — execute is permissionless in 2.0, and the");
  console.log("   CCIP Explorer offers manual execution.\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
