import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { ERC20Token } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const TOKEN_NAME = "Ember Token";
const TOKEN_SYMBOL = "EMBR";
const CUSTOM_DECIMALS = 6;
const INITIAL_SUPPLY = ethers.parseUnits("1000", CUSTOM_DECIMALS);
const MINT_AMOUNT = ethers.parseUnits("500", CUSTOM_DECIMALS);

describe("Upgradeable ERC20 Token", function () {
  let token: ERC20Token;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ERC20Token");
    token = (await upgrades.deployProxy(
      Factory,
      [owner.address, TOKEN_NAME, TOKEN_SYMBOL, CUSTOM_DECIMALS, INITIAL_SUPPLY],
      { initializer: "initialize", kind: "uups" }
    )) as ERC20Token;
    await token.waitForDeployment();
  });

  it("should deploy with correct metadata and supply", async function () {
    expect(await token.name()).to.equal(TOKEN_NAME);
    expect(await token.symbol()).to.equal(TOKEN_SYMBOL);
    expect(await token.decimals()).to.equal(CUSTOM_DECIMALS);
    expect(await token.owner()).to.equal(owner.address);
    expect(await token.version()).to.equal("1");
  });

  it("allows owner to mint additional tokens", async function () {
    await expect(token.connect(owner).mint(user.address, MINT_AMOUNT))
      .to.emit(token, "TokenMinted")
      .withArgs(user.address, MINT_AMOUNT);

    expect(await token.balanceOf(user.address)).to.equal(MINT_AMOUNT);
    expect(await token.totalSupply()).to.equal(INITIAL_SUPPLY + MINT_AMOUNT);
  });

  it("prevents non-owner from minting", async function () {
    await expect(token.connect(user).mint(user.address, MINT_AMOUNT)).to.be.revertedWithCustomError(
      token,
      "OwnableUnauthorizedAccount"
    );
  });
});
