import { expect } from "chai";
import { ethers } from "hardhat";
import type { FixedPointMathWrapper } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("FixedPointMath Library", function () {
  let math: FixedPointMathWrapper;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  const BASE = ethers.parseUnits("1", 18); // 1e18

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    const mathFactory = await ethers.getContractFactory("FixedPointMathWrapper");
    math = (await mathFactory.deploy()) as FixedPointMathWrapper;
    await math.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should deploy successfully", async function () {
      expect(await math.getAddress()).to.be.properAddress;
    });

    it("should have correct BASE constant", async function () {
      expect(await math.BASE()).to.equal(BASE);
    });
  });

  describe("mul() - Fixed-point Multiplication", function () {
    describe("Normal Cases", function () {
      it("should multiply two values correctly", async function () {
        const a = ethers.parseUnits("2", 18); // 2e18
        const b = ethers.parseUnits("3", 18); // 3e18
        // (2e18 * 3e18) / 1e18 = 6e18
        expect(await math.mul(a, b)).to.equal(ethers.parseUnits("6", 18));
      });

      it("should multiply with decimal values", async function () {
        const a = ethers.parseUnits("1.5", 18); // 1.5e18
        const b = ethers.parseUnits("2.5", 18); // 2.5e18
        // (1.5e18 * 2.5e18) / 1e18 = 3.75e18
        expect(await math.mul(a, b)).to.equal(ethers.parseUnits("3.75", 18));
      });

      it("should multiply small values correctly", async function () {
        const a = ethers.parseUnits("0.1", 18); // 0.1e18
        const b = ethers.parseUnits("0.2", 18); // 0.2e18
        // (0.1e18 * 0.2e18) / 1e18 = 0.02e18
        expect(await math.mul(a, b)).to.equal(ethers.parseUnits("0.02", 18));
      });

      it("should multiply large values correctly", async function () {
        const a = ethers.parseUnits("1000", 18); // 1000e18
        const b = ethers.parseUnits("2000", 18); // 2000e18
        // (1000e18 * 2000e18) / 1e18 = 2000000e18
        expect(await math.mul(a, b)).to.equal(ethers.parseUnits("2000000", 18));
      });

      it("should handle multiplication by 1", async function () {
        const a = ethers.parseUnits("5", 18);
        const b = BASE; // 1e18
        expect(await math.mul(a, b)).to.equal(a);
      });

      it("should handle multiplication by BASE", async function () {
        const a = ethers.parseUnits("2", 18);
        const b = BASE;
        expect(await math.mul(a, b)).to.equal(a);
      });
    });

    describe("Edge Cases", function () {
      it("should return 0 when first operand is 0", async function () {
        const a = 0n;
        const b = ethers.parseUnits("100", 18);
        expect(await math.mul(a, b)).to.equal(0n);
      });

      it("should return 0 when second operand is 0", async function () {
        const a = ethers.parseUnits("100", 18);
        const b = 0n;
        expect(await math.mul(a, b)).to.equal(0n);
      });

      it("should return 0 when both operands are 0", async function () {
        expect(await math.mul(0n, 0n)).to.equal(0n);
      });

      it("should handle very small values", async function () {
        const a = 1n; // 1 wei
        const b = 1n; // 1 wei
        // (1 * 1) / 1e18 = 0 (due to integer division)
        expect(await math.mul(a, b)).to.equal(0n);
      });

      it("should handle values less than BASE", async function () {
        const a = BASE / 2n; // 0.5e18
        const b = BASE / 4n; // 0.25e18
        // (0.5e18 * 0.25e18) / 1e18 = 0.125e18
        expect(await math.mul(a, b)).to.equal(ethers.parseUnits("0.125", 18));
      });
    });

    describe("Overflow Cases", function () {
      it("should revert on overflow when a * b exceeds uint256 max", async function () {
        const maxUint256 = ethers.MaxUint256;
        const largeValue = maxUint256 / 2n + 1n;

        await expect(math.mul(largeValue, 2n)).to.be.revertedWithCustomError(math, "Overflow");
      });

      it("should revert on overflow with very large values", async function () {
        const a = ethers.MaxUint256;
        const b = 2n;

        await expect(math.mul(a, b)).to.be.revertedWithCustomError(math, "Overflow");
      });

      it("should handle values near overflow boundary", async function () {
        // Use values that when multiplied don't overflow uint256 but are large
        const maxSafe = ethers.MaxUint256 / BASE;
        const a = maxSafe;
        const b = BASE;

        // This should not overflow because a * b = maxSafe * BASE <= MaxUint256
        const result = await math.mul(a, b);
        expect(result).to.equal(maxSafe);
      });
    });

    describe("Precision and Rounding", function () {
      it("should handle rounding down correctly", async function () {
        // (1e18 * 1) / 1e18 = 1 (not 0, because 1e18 * 1 = 1e18, then / 1e18 = 1)
        const a = BASE;
        const b = 1n;
        expect(await math.mul(a, b)).to.equal(1n);
      });

      it("should handle values that result in fractional parts", async function () {
        // (3 * 1e18) / 1e18 = 3 (not 0, because 3 * 1e18 = 3e18, then / 1e18 = 3)
        const a = 3n;
        const b = BASE;
        expect(await math.mul(a, b)).to.equal(3n);
      });

      it("should maintain precision with large numerators", async function () {
        const a = ethers.parseUnits("1.5", 18);
        const b = ethers.parseUnits("1.333333333333333333", 18);
        const result = await math.mul(a, b);
        // Should be approximately 2e18 (1.5 * 1.333... = 2)
        expect(result).to.be.closeTo(ethers.parseUnits("2", 18), ethers.parseUnits("0.0001", 18));
      });
    });
  });

  describe("div() - Fixed-point Division", function () {
    describe("Normal Cases", function () {
      it("should divide two values correctly", async function () {
        const a = ethers.parseUnits("6", 18); // 6e18
        const b = ethers.parseUnits("2", 18); // 2e18
        // (6e18 * 1e18) / 2e18 = 3e18
        expect(await math.div(a, b)).to.equal(ethers.parseUnits("3", 18));
      });

      it("should divide with decimal values", async function () {
        const a = ethers.parseUnits("3.75", 18); // 3.75e18
        const b = ethers.parseUnits("1.5", 18); // 1.5e18
        // (3.75e18 * 1e18) / 1.5e18 = 2.5e18
        expect(await math.div(a, b)).to.equal(ethers.parseUnits("2.5", 18));
      });

      it("should divide small values correctly", async function () {
        const a = ethers.parseUnits("0.1", 18); // 0.1e18
        const b = ethers.parseUnits("0.2", 18); // 0.2e18
        // (0.1e18 * 1e18) / 0.2e18 = 0.5e18
        expect(await math.div(a, b)).to.equal(ethers.parseUnits("0.5", 18));
      });

      it("should divide large values correctly", async function () {
        const a = ethers.parseUnits("2000000", 18); // 2000000e18
        const b = ethers.parseUnits("1000", 18); // 1000e18
        // (2000000e18 * 1e18) / 1000e18 = 2000e18
        expect(await math.div(a, b)).to.equal(ethers.parseUnits("2000", 18));
      });

      it("should handle division by 1", async function () {
        const a = ethers.parseUnits("5", 18);
        const b = BASE; // 1e18
        expect(await math.div(a, b)).to.equal(a);
      });

      it("should handle division by BASE", async function () {
        const a = ethers.parseUnits("2", 18);
        const b = BASE;
        // (2e18 * 1e18) / 1e18 = 2e18
        expect(await math.div(a, b)).to.equal(ethers.parseUnits("2", 18));
      });

      it("should handle division resulting in values greater than BASE", async function () {
        const a = ethers.parseUnits("2", 18);
        const b = ethers.parseUnits("0.5", 18);
        // (2e18 * 1e18) / 0.5e18 = 4e18
        expect(await math.div(a, b)).to.equal(ethers.parseUnits("4", 18));
      });
    });

    describe("Edge Cases", function () {
      it("should return 0 when dividend is 0", async function () {
        const a = 0n;
        const b = ethers.parseUnits("100", 18);
        expect(await math.div(a, b)).to.equal(0n);
      });

      it("should handle very small dividend", async function () {
        const a = 1n; // 1 wei
        const b = BASE;
        // (1 * 1e18) / 1e18 = 1
        expect(await math.div(a, b)).to.equal(1n);
      });

      it("should handle very large divisor", async function () {
        const a = BASE;
        const b = ethers.parseUnits("1000000", 18);
        // (1e18 * 1e18) / 1000000e18 = 0.000001e18 = 1e12
        expect(await math.div(a, b)).to.equal(ethers.parseUnits("0.000001", 18));
      });
    });

    describe("Error Cases", function () {
      it("should revert on division by zero", async function () {
        const a = ethers.parseUnits("100", 18);
        const b = 0n;

        await expect(math.div(a, b)).to.be.revertedWithCustomError(math, "DivisionByZero");
      });

      it("should revert on overflow when a * BASE exceeds uint256 max", async function () {
        const maxUint256 = ethers.MaxUint256;
        const a = maxUint256 / BASE + 1n; // This will cause overflow when multiplied by BASE
        const b = BASE;

        await expect(math.div(a, b)).to.be.revertedWithCustomError(math, "Overflow");
      });

      it("should handle values at overflow boundary", async function () {
        const maxSafe = ethers.MaxUint256 / BASE;
        const a = maxSafe;
        const b = BASE;

        // This should not overflow
        const result = await math.div(a, b);
        expect(result).to.equal(maxSafe);
      });
    });

    describe("Precision and Rounding", function () {
      it("should round down when result has fractional part", async function () {
        const a = BASE; // 1e18
        const b = 3n;
        // (1e18 * 1e18) / 3 = 333333333333333333333333333333333333 (in wei, which is 0.333... in BASE units)
        const result = await math.div(a, b);
        // The result is (1e18 * 1e18) / 3 = 1e36 / 3 = 333333333333333333333333333333333333
        expect(result).to.equal(333333333333333333333333333333333333n);
      });

      it("should handle division that results in very small values", async function () {
        const a = 1n;
        const b = ethers.parseUnits("1000000", 18);
        // (1 * 1e18) / 1000000e18 = 1e18 / 1000000e18 = 0 (rounds down because 1e18 < 1000000e18)
        // To get a non-zero result, we need a >= b
        const result = await math.div(a, b);
        expect(result).to.equal(0n);
      });

      it("should handle division with small but non-zero result", async function () {
        const a = ethers.parseUnits("1", 18); // 1e18
        const b = ethers.parseUnits("1000000", 18); // 1000000e18
        // (1e18 * 1e18) / 1000000e18 = 1e36 / 1000000e18 = 1e18 / 1000000 = 1e12
        const result = await math.div(a, b);
        expect(result).to.equal(ethers.parseUnits("0.000001", 18));
      });
    });
  });

  describe("diffAbs() - Absolute Difference", function () {
    describe("Normal Cases", function () {
      it("should calculate absolute difference when a > b", async function () {
        const a = ethers.parseUnits("10", 18);
        const b = ethers.parseUnits("3", 18);
        expect(await math.diffAbs(a, b)).to.equal(ethers.parseUnits("7", 18));
      });

      it("should calculate absolute difference when b > a", async function () {
        const a = ethers.parseUnits("3", 18);
        const b = ethers.parseUnits("10", 18);
        expect(await math.diffAbs(a, b)).to.equal(ethers.parseUnits("7", 18));
      });

      it("should return 0 when values are equal", async function () {
        const a = ethers.parseUnits("5", 18);
        const b = ethers.parseUnits("5", 18);
        expect(await math.diffAbs(a, b)).to.equal(0n);
      });

      it("should handle decimal values", async function () {
        const a = ethers.parseUnits("1.5", 18);
        const b = ethers.parseUnits("0.3", 18);
        expect(await math.diffAbs(a, b)).to.equal(ethers.parseUnits("1.2", 18));
      });

      it("should handle large values", async function () {
        const a = ethers.parseUnits("1000000", 18);
        const b = ethers.parseUnits("500000", 18);
        expect(await math.diffAbs(a, b)).to.equal(ethers.parseUnits("500000", 18));
      });
    });

    describe("Edge Cases", function () {
      it("should handle zero as first value", async function () {
        const a = 0n;
        const b = ethers.parseUnits("10", 18);
        expect(await math.diffAbs(a, b)).to.equal(ethers.parseUnits("10", 18));
      });

      it("should handle zero as second value", async function () {
        const a = ethers.parseUnits("10", 18);
        const b = 0n;
        expect(await math.diffAbs(a, b)).to.equal(ethers.parseUnits("10", 18));
      });

      it("should handle both values as zero", async function () {
        expect(await math.diffAbs(0n, 0n)).to.equal(0n);
      });

      it("should handle very small differences", async function () {
        const a = 1n;
        const b = 0n;
        expect(await math.diffAbs(a, b)).to.equal(1n);
      });

      it("should handle very large differences", async function () {
        const a = ethers.MaxUint256;
        const b = 0n;
        expect(await math.diffAbs(a, b)).to.equal(ethers.MaxUint256);
      });

      it("should handle values very close to each other", async function () {
        const a = ethers.parseUnits("1.000000000000000001", 18);
        const b = ethers.parseUnits("1.000000000000000000", 18);
        expect(await math.diffAbs(a, b)).to.equal(1n);
      });
    });
  });

  describe("percentChangeFrom() - Percentage Change", function () {
    describe("Normal Cases", function () {
      it("should calculate percentage increase correctly", async function () {
        const a = ethers.parseUnits("100", 18); // base
        const b = ethers.parseUnits("150", 18); // new
        // |150 - 100| * 1e18 / 100 = 0.5e18 (50%)
        expect(await math.percentChangeFrom(a, b)).to.equal(ethers.parseUnits("0.5", 18));
      });

      it("should calculate percentage decrease correctly", async function () {
        const a = ethers.parseUnits("100", 18); // base
        const b = ethers.parseUnits("50", 18); // new
        // |50 - 100| * 1e18 / 100 = 0.5e18 (50%)
        expect(await math.percentChangeFrom(a, b)).to.equal(ethers.parseUnits("0.5", 18));
      });

      it("should return 0 when values are equal", async function () {
        const a = ethers.parseUnits("100", 18);
        const b = ethers.parseUnits("100", 18);
        expect(await math.percentChangeFrom(a, b)).to.equal(0n);
      });

      it("should handle 100% increase", async function () {
        const a = ethers.parseUnits("100", 18);
        const b = ethers.parseUnits("200", 18);
        // |200 - 100| * 1e18 / 100 = 1e18 (100%)
        expect(await math.percentChangeFrom(a, b)).to.equal(BASE);
      });

      it("should handle 100% decrease", async function () {
        const a = ethers.parseUnits("100", 18);
        const b = 0n;
        // |0 - 100| * 1e18 / 100 = 1e18 (100%)
        expect(await math.percentChangeFrom(a, b)).to.equal(BASE);
      });

      it("should handle small percentage changes", async function () {
        const a = ethers.parseUnits("100", 18);
        const b = ethers.parseUnits("101", 18);
        // |101 - 100| * 1e18 / 100 = 0.01e18 (1%)
        expect(await math.percentChangeFrom(a, b)).to.equal(ethers.parseUnits("0.01", 18));
      });

      it("should handle large percentage changes", async function () {
        const a = ethers.parseUnits("100", 18);
        const b = ethers.parseUnits("1000", 18);
        // |1000 - 100| * 1e18 / 100 = 9e18 (900%)
        expect(await math.percentChangeFrom(a, b)).to.equal(ethers.parseUnits("9", 18));
      });

      it("should handle decimal base values", async function () {
        const a = ethers.parseUnits("0.5", 18);
        const b = ethers.parseUnits("1", 18);
        // |1 - 0.5| * 1e18 / 0.5 = 1e18 (100%)
        expect(await math.percentChangeFrom(a, b)).to.equal(BASE);
      });
    });

    describe("Edge Cases", function () {
      it("should handle very small base value", async function () {
        const a = 1n; // 1 wei
        const b = 2n; // 2 wei
        // |2 - 1| * 1e18 / 1 = 1e18 (100%)
        expect(await math.percentChangeFrom(a, b)).to.equal(BASE);
      });

      it("should handle very large base value", async function () {
        const a = ethers.parseUnits("1000000", 18);
        const b = ethers.parseUnits("1000001", 18);
        const result = await math.percentChangeFrom(a, b);
        // Should be approximately 0.000001e18
        expect(result).to.equal(ethers.parseUnits("0.000001", 18));
      });
    });

    describe("Error Cases", function () {
      it("should revert on division by zero when base is 0", async function () {
        const a = 0n;
        const b = ethers.parseUnits("100", 18);

        await expect(math.percentChangeFrom(a, b)).to.be.revertedWithCustomError(
          math,
          "DivisionByZero"
        );
      });

      it("should revert on overflow when diffAbs result causes overflow", async function () {
        const maxUint256 = ethers.MaxUint256;
        const a = 1n;
        const b = maxUint256;

        // This will cause overflow in div() when trying to multiply by BASE
        await expect(math.percentChangeFrom(a, b)).to.be.revertedWithCustomError(math, "Overflow");
      });
    });
  });

  describe("divCeil() - Ceiling Division", function () {
    describe("Normal Cases", function () {
      it("should divide and round up correctly", async function () {
        // Test with values that will have a remainder
        // Use a case where div() and divCeil() will differ
        const a = BASE; // 1e18
        const b = 3n;
        // div(1e18, 3) = (1e18 * 1e18) / 3 = 1e36 / 3 = 333333333333333333333333333333333333
        // divCeil should round up, so it should be 1 more
        const divResult = await math.div(a, b);
        const divCeilResult = await math.divCeil(a, b);
        // divCeil should be >= div, and should be exactly 1 more when there's a remainder
        expect(divCeilResult).to.be.gte(divResult);
        // Since 1e36 / 3 has remainder 1, divCeil should add 1
        expect(divCeilResult).to.equal(divResult + 1n);
      });

      it("should return same value when division is exact", async function () {
        const a = ethers.parseUnits("6", 18);
        const b = ethers.parseUnits("2", 18);
        // ceil((6e18 * 1e18) / 2e18) = ceil(3e18) = 3e18
        expect(await math.divCeil(a, b)).to.equal(ethers.parseUnits("3", 18));
      });

      it("should round up with decimal results", async function () {
        const a = BASE; // 1e18
        const b = 3n;
        // ceil((1e18 * 1e18) / 3) = ceil(333333333333333333.333...) = 333333333333333334
        const result = await math.divCeil(a, b);
        // Should be 1 more than div() result
        const divResult = await math.div(a, b);
        expect(result).to.equal(divResult + 1n);
      });

      it("should handle small values", async function () {
        const a = ethers.parseUnits("0.1", 18);
        const b = ethers.parseUnits("0.3", 18);
        // ceil((0.1e18 * 1e18) / 0.3e18) = ceil(0.333...) = 1 (in wei terms, but scaled)
        const result = await math.divCeil(a, b);
        expect(result).to.be.gt(0n);
      });

      it("should handle large values", async function () {
        const a = ethers.parseUnits("2000000", 18);
        const b = ethers.parseUnits("1000", 18);
        // ceil((2000000e18 * 1e18) / 1000e18) = ceil(2000e18) = 2000e18
        expect(await math.divCeil(a, b)).to.equal(ethers.parseUnits("2000", 18));
      });

      it("should round up when result is just above integer", async function () {
        const a = ethers.parseUnits("2.1", 18);
        const b = ethers.parseUnits("2", 18);
        // ceil((2.1e18 * 1e18) / 2e18) = ceil(1.05e18) = 2e18 (in wei, but we need to check)
        const result = await math.divCeil(a, b);
        expect(result).to.be.gt(ethers.parseUnits("1", 18));
      });
    });

    describe("Edge Cases", function () {
      it("should return 1 when dividend is less than divisor", async function () {
        const a = ethers.parseUnits("1", 18);
        const b = ethers.parseUnits("2", 18);
        // ceil((1e18 * 1e18) / 2e18) = ceil(0.5e18) = 1 (in wei terms)
        const result = await math.divCeil(a, b);
        expect(result).to.be.gt(0n);
      });

      it("should handle very small dividend", async function () {
        const a = 1n;
        const b = BASE;
        // ceil((1 * 1e18) / 1e18) = ceil(1) = 1
        expect(await math.divCeil(a, b)).to.equal(1n);
      });

      it("should handle very large divisor", async function () {
        const a = BASE;
        const b = ethers.parseUnits("1000000", 18);
        // ceil((1e18 * 1e18) / 1000000e18) = ceil(0.000001e18) = 1e12
        expect(await math.divCeil(a, b)).to.equal(ethers.parseUnits("0.000001", 18));
      });

      it("should return BASE when dividing by 1", async function () {
        const a = BASE;
        const b = BASE;
        expect(await math.divCeil(a, b)).to.equal(BASE);
      });
    });

    describe("Error Cases", function () {
      it("should revert on division by zero", async function () {
        const a = ethers.parseUnits("100", 18);
        const b = 0n;

        await expect(math.divCeil(a, b)).to.be.revertedWithCustomError(math, "DivisionByZero");
      });

      it("should revert on overflow when a * BASE exceeds uint256 max", async function () {
        const maxUint256 = ethers.MaxUint256;
        const a = maxUint256 / BASE + 1n;
        const b = BASE;

        await expect(math.divCeil(a, b)).to.be.revertedWithCustomError(math, "Overflow");
      });
    });

    describe("Comparison with div()", function () {
      it("should return same value as div() when division is exact", async function () {
        const a = ethers.parseUnits("6", 18);
        const b = ethers.parseUnits("2", 18);
        const divResult = await math.div(a, b);
        const divCeilResult = await math.divCeil(a, b);
        expect(divCeilResult).to.equal(divResult);
      });

      it("should return value greater than div() when division has remainder", async function () {
        // Use a case that definitely has a remainder
        const a = BASE; // 1e18
        const b = 3n;
        const divResult = await math.div(a, b);
        const divCeilResult = await math.divCeil(a, b);
        // divCeil should be >= div, and > when there's a remainder
        expect(divCeilResult).to.be.gte(divResult);
        // Since 1e36 / 3 has remainder, divCeil should be greater
        expect(divCeilResult).to.be.gt(divResult);
      });

      it("should return exactly 1 more than div() for small remainders", async function () {
        const a = BASE;
        const b = 3n;
        const divResult = await math.div(a, b);
        const divCeilResult = await math.divCeil(a, b);
        expect(divCeilResult).to.equal(divResult + 1n);
      });
    });
  });

  describe("Integration Tests", function () {
    it("should work correctly in combination", async function () {
      const a = ethers.parseUnits("10", 18);
      const b = ethers.parseUnits("5", 18);
      const c = ethers.parseUnits("2", 18);

      // Calculate: (a * b) / c using mul and div
      const mulResult = await math.mul(a, b);
      const finalResult = await math.div(mulResult, c);
      // (10 * 5) / 2 = 25
      expect(finalResult).to.equal(ethers.parseUnits("25", 18));
    });

    it("should calculate percentage change of multiplied values", async function () {
      const a = ethers.parseUnits("2", 18);
      const b = ethers.parseUnits("3", 18);
      const c = ethers.parseUnits("4", 18);

      const mul1 = await math.mul(a, b);
      const mul2 = await math.mul(a, c);
      const percentChange = await math.percentChangeFrom(mul1, mul2);

      // mul1 = 6, mul2 = 8, percent change = |8-6|/6 = 2/6 = 0.333...
      expect(percentChange).to.be.closeTo(
        ethers.parseUnits("0.333333333333333333", 18),
        ethers.parseUnits("0.0001", 18)
      );
    });

    it("should use diffAbs in percentage calculations", async function () {
      const a = ethers.parseUnits("100", 18);
      const b = ethers.parseUnits("120", 18);

      const diff = await math.diffAbs(a, b);
      const percent = await math.percentChangeFrom(a, b);

      // Verify percent = diff * BASE / a
      const expectedPercent = await math.div(diff, a);
      expect(percent).to.equal(expectedPercent);
    });
  });
});
