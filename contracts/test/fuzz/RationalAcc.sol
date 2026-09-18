// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice An exact-rational accumulator: a running sum of fractions `a / b`, kept as an integer part plus a
///         proper fraction `num / den` with `num < den`. Used by the fuzz suite as the reference model for
///         PRD 4.5 I5 ("total paid to a member <= the exactly-split stream"), which cannot be expressed with
///         integer arithmetic alone: a member's exact entitlement over an interval is `streamed * shares /
///         totalShares`, a fraction of a wad that the contract floors but the reference must not.
/// @dev The only inexactness is the overflow valve. Denominators are combined by lcm, which can grow without
///      bound over a long op sequence, so when the next lcm would pass `DEN_CAP` the accumulator gives up the
///      fraction and rounds *up* by 2 wad (a proper fraction plus a proper fraction is strictly less than 2).
///      Rounding up keeps the accumulator an upper bound on the exact sum, which is the direction I5 needs;
///      `flushes` counts how often it happened so a test can assert it stayed exact.
library RationalAcc {
    /// @dev Chosen so that `num * (L / den)` and `a * (L / b)` cannot overflow: both are `< L <= DEN_CAP`,
    ///      and every term numerator the fuzz suite feeds in is `<= 1e30` (see DripPoolFuzz bounds).
    uint256 internal constant DEN_CAP = 1e40;

    struct Acc {
        uint256 whole; // integer part
        uint256 num; // fractional numerator, always < den
        uint256 den; // fractional denominator, always >= 1
        uint256 flushes; // times the overflow valve rounded up
    }

    /// @notice acc += a / b (exactly, unless the overflow valve fires, which rounds up).
    function add(Acc storage acc, uint256 a, uint256 b) internal {
        if (b == 0 || a == 0) return;

        acc.whole += a / b;
        a %= b;
        if (a == 0) return;

        uint256 den = acc.den;
        if (den == 0) den = 1;

        uint256 g = _gcd(den, b);
        uint256 dq = den / g;
        if (dq > DEN_CAP / b) {
            // Cannot combine without risking overflow: round the whole fraction up. `acc.num / den < 1` and
            // `a / b < 1`, so `+2` is always an upper bound.
            acc.whole += 2;
            acc.num = 0;
            acc.den = 1;
            acc.flushes += 1;
            return;
        }

        uint256 L = dq * b;
        uint256 n = acc.num * (L / den) + a * (L / b);
        acc.whole += n / L;
        acc.num = n % L;
        acc.den = L;
    }

    /// @notice The greatest integer not above the accumulated value. An integer amount is `<=` the exact sum
    ///         if and only if it is `<= floor(sum)`, so this is what I5 compares against.
    function floorValue(Acc storage acc) internal view returns (uint256) {
        return acc.whole;
    }

    function _gcd(uint256 x, uint256 y) private pure returns (uint256) {
        while (y != 0) {
            (x, y) = (y, x % y);
        }
        return x == 0 ? 1 : x;
    }
}
