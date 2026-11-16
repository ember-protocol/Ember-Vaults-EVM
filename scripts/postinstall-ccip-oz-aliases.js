/*
 * Chainlink's CCIP contracts import OpenZeppelin through version-pinned aliases:
 *
 *   import {IERC20} from "@openzeppelin/contracts@5.3.0/token/ERC20/IERC20.sol";
 *
 * In their repo that resolves through a foundry remapping. Hardhat has no remappings — it
 * resolves imports as node module paths — so it looks for a package literally named
 * `@openzeppelin/contracts@5.3.0` and fails with HH411.
 *
 * `@chainlink/contracts-ccip` already depends on the aliased packages, so yarn installs the
 * real directories (`@openzeppelin/contracts-5.3.0`). All that's missing is a name hardhat
 * can resolve, which is what this script provides. It is idempotent and safe to re-run;
 * missing sources are skipped so a partial install doesn't fail the whole postinstall.
 */
const fs = require("fs");
const path = require("path");

const OZ_DIR = path.join(__dirname, "..", "node_modules", "@openzeppelin");

// alias name -> actual installed directory
const ALIASES = {
  "contracts@5.3.0": "contracts-5.3.0",
  "contracts@4.8.3": "contracts-4.8.3",
};

function main() {
  if (!fs.existsSync(OZ_DIR)) return; // deps not installed yet, nothing to do

  for (const [alias, target] of Object.entries(ALIASES)) {
    const targetPath = path.join(OZ_DIR, target);
    const linkPath = path.join(OZ_DIR, alias);

    if (!fs.existsSync(targetPath)) continue;

    try {
      // Replace anything already sitting at the alias path so a changed target is picked up.
      if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
        fs.rmSync(linkPath, { recursive: true, force: true });
      }
      fs.symlinkSync(target, linkPath, "junction");
      console.log(`linked @openzeppelin/${alias} -> ${target}`);
    } catch (err) {
      console.warn(`could not link @openzeppelin/${alias}: ${err.message}`);
    }
  }
}

main();
