export const withCleanup = async (body, cleanup) => {
	const failures = []
	let result
	try {
		result = await body()
	} catch (error) {
		failures.push(error)
	}
	try {
		await cleanup()
	} catch (error) {
		failures.push(error)
	}
	if (failures.length === 1) throw failures[0]
	if (failures.length > 1)
		throw new AggregateError(failures, "Benchmark work and cleanup failed")
	return result
}
