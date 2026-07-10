import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

export const DEPLOYMENTS_DIR = path.join(__dirname, "..", "..", "deployments");

/** ANSI colours for terminal output (no extra deps). */
export const c = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

export const ok = (s: string) => `${c.green}${s}${c.reset}`;
export const bad = (s: string) => `${c.red}${s}${c.reset}`;
export const warn = (s: string) => `${c.yellow}${s}${c.reset}`;
export const dim = (s: string) => `${c.gray}${s}${c.reset}`;

/** Case-insensitive address equality (tolerant of mixed checksums / undefined). */
export function addrEq(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Normalises a value to a checksum address, or returns it unchanged if not an address. */
export function fmtAddr(a?: string | null): string {
  if (a && ethers.isAddress(a)) return ethers.getAddress(a);
  return String(a);
}

export interface DeploymentFile {
  path: string;
  networkName: string;
  data: any;
}

/**
 * Resolves and loads the deployment file for the currently selected hardhat
 * network (e.g. `--network mainnet` -> deployments/mainnet-deployment.json).
 */
export function loadDeployment(): DeploymentFile {
  const networkName = network.name;
  const filePath = path.join(DEPLOYMENTS_DIR, `${networkName}-deployment.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Deployment file not found: ${filePath}\n` +
        `Run with --network <mainnet|pharos|base|...> matching a deployments/*-deployment.json file.`
    );
  }
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return { path: filePath, networkName, data };
}

export function saveDeployment(file: DeploymentFile): void {
  fs.writeFileSync(file.path, JSON.stringify(file.data, null, 2) + "\n");
}

/**
 * True when update/write mode is requested via UPDATE=true / WRITE=true env var.
 *
 * Use an env var rather than a CLI flag: `hardhat run` parses argv itself and
 * errors (HH305) on any flag it doesn't recognise, so `--update` never reaches
 * the script. The `--update`/`--write` argv fallback only works when a script
 * is run directly via ts-node.
 */
export function isUpdateMode(): boolean {
  if (process.env.UPDATE === "true" || process.env.WRITE === "true") return true;
  return process.argv.includes("--update") || process.argv.includes("--write");
}
