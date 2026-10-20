"""Small exact statistics for calibration, with no dependencies.

Created by Shashikant. https://github.com/shashikantdev3/twosystems
"""

from __future__ import annotations

import math
from functools import lru_cache


def binomial_cdf(k: int, n: int, p: float) -> float:
    """P(X <= k) for X ~ Binomial(n, p), summed in log space so large n stays accurate."""
    if k >= n:
        return 1.0
    if k < 0:
        return 0.0
    if p <= 0:
        return 1.0
    if p >= 1:
        return 0.0
    log_p, log_q = math.log(p), math.log1p(-p)
    log_n = math.lgamma(n + 1)
    total = 0.0
    for i in range(k + 1):
        total += math.exp(
            log_n - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * log_p + (n - i) * log_q
        )
    return min(1.0, total)


@lru_cache(maxsize=65_536)
def upper_bound(k: int, n: int, confidence: float = 0.95) -> float:
    """One-sided Clopper-Pearson upper bound on a rate seen k times in n tries.

    The true rate is below this value with the given confidence. With no tries
    nothing is known, so the bound is 1.
    """
    if n <= 0:
        return 1.0
    if k >= n:
        return 1.0
    alpha = 1.0 - confidence
    low, high = k / n, 1.0
    for _ in range(100):
        middle = (low + high) / 2
        if binomial_cdf(k, n, middle) > alpha:
            low = middle
        else:
            high = middle
    return high


def fewest_tries(target: float, confidence: float = 0.95) -> int:
    """Smallest number of tries with no failures whose upper bound is at most target."""
    n = 1
    while upper_bound(0, n, confidence) > target:
        n += 1
    return n
