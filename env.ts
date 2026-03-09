import { config } from "dotenv";
config({ path: ".env" });

export const ENV = {
  ENV: process.env.ENV,
  DEPLOY_ON: process.env.DEPLOY_ON,
  MAINNET_RPC_URL: process.env.MAINNET_RPC_URL,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  REPORT_GAS: process.env.REPORT_GAS,
};
