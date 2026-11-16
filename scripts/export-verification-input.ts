import { artifacts } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Exports a contract's Solidity Standard JSON Input, for verifying by hand through an
 * explorer's UI when the API path is unavailable.
 *
 * Needed because SocialScan (used for pharos / atlantic) returns Etherscan-shaped responses
 * with the payload in `message` rather than `result`. hardhat-verify reads `response.result`
 * into `this.message`, so on any SocialScan error it ends up calling `.startsWith` on
 * undefined and throws a TypeError — masking whatever the explorer actually said. Until the
 * plugin handles that shape, exporting the standard input and pasting it into the explorer's
 * "Standard JSON Input" verification form is the reliable route.
 *
 * The build-info `input` field IS the standard JSON input — exactly what the compiler was
 * given — so this is byte-accurate rather than a reconstruction.
 *
 * Required ENV:
 *   CONTRACT   Contract name, or fully-qualified "path/to/File.sol:Name" when ambiguous.
 *
 * Optional ENV:
 *   OUT_DIR    Output directory. Defaults to ./verification.
 */
async function main() {
  const contract = process.env.CONTRACT;
  if (!contract) {
    console.error("❌ Error: CONTRACT is required, e.g. CONTRACT=EmberVault");
    console.log("\nUse a fully-qualified name if the short name is ambiguous:");
    console.log('  CONTRACT="contracts/ccip/EmberTokenPool.sol:EmberTokenPool"');
    process.exit(1);
  }

  const outDir = process.env.OUT_DIR || "./verification";

  // A bare name can match several fully-qualified artifacts — far more likely now that the CCIP
  // imports bring in their own OpenZeppelin copies — so taking the first match silently exports
  // the wrong compiler input. Name the candidates and make the caller choose.
  let fqn: string | undefined;
  if (contract.includes(":")) {
    fqn = contract;
  } else {
    const matches = (await artifacts.getAllFullyQualifiedNames()).filter((n) =>
      n.endsWith(`:${contract}`)
    );
    if (matches.length > 1) {
      console.error(`❌ Error: '${contract}' is ambiguous — ${matches.length} artifacts match:`);
      matches.forEach((m) => console.error(`     ${m}`));
      console.error("   Re-run with the fully-qualified name.");
      process.exit(1);
    }
    fqn = matches[0];
  }

  if (!fqn) {
    console.error(`❌ Error: no artifact found for '${contract}'. Has it been compiled?`);
    process.exit(1);
  }

  const buildInfo = await artifacts.getBuildInfo(fqn);
  if (!buildInfo) {
    console.error(`❌ Error: no build info for '${fqn}'. Run 'yarn compile' first.`);
    process.exit(1);
  }

  const [sourceName, contractName] = fqn.split(":");
  const settings = buildInfo.input.settings as Record<string, unknown>;

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${contractName}.standard-input.json`);
  fs.writeFileSync(outFile, JSON.stringify(buildInfo.input, null, 2) + "\n");

  console.log(`\n✅ Standard JSON Input written to ${outFile}\n`);
  console.log("Paste that file into the explorer's");
  console.log('  "Solidity (Standard JSON Input)" verification form,');
  console.log("with these settings — they must match exactly:\n");
  console.log("  Contract name:      ", `${sourceName}:${contractName}`);
  console.log("  Compiler version:   ", `v${buildInfo.solcLongVersion}`);
  console.log("  Optimization:       ", (settings.optimizer as any)?.enabled ? "Yes" : "No");
  console.log("  Optimizer runs:     ", (settings.optimizer as any)?.runs ?? "n/a");
  console.log("  EVM version:        ", settings.evmVersion ?? "default");
  console.log("  viaIR:              ", settings.viaIR ? "true" : "false");
  console.log(
    "\nConstructor arguments are entered separately, ABI-encoded without the 0x prefix.\n"
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
