// Used for heap deltas and independent-process imports. Timing tasks use tinybench statistics.
export const statistics = (values) => {
	if (values.length < 2 || values.some((value) => !Number.isFinite(value)))
		throw new Error("At least two finite samples are required")
	const sorted = [...values].sort((a, b) => a - b)
	const n = sorted.length
	const mean = sorted.reduce((sum, value) => sum + value, 0) / n
	const variance =
		sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
	// Two-sided 95% critical values, using conservative buckets after df=3.
	// NIST: https://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm
	const critical =
		n === 2
			? 12.706
			: n === 3
				? 4.303
				: n <= 10
					? 3.182
					: n <= 20
						? 2.262
						: n <= 30
							? 2.093
							: 2.045
	const margin = critical * Math.sqrt(variance / n)
	const quantile = (p) => {
		const position = (n - 1) * p
		const lower = Math.floor(position)
		return (
			sorted[lower] +
			(sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
		)
	}
	return {
		mean,
		p50: quantile(0.5),
		p99: quantile(0.99),
		p999: quantile(0.999),
		rme: mean === 0 ? null : (margin / Math.abs(mean)) * 100,
		margin,
		samplesCount: n,
		samples: values,
	}
}
