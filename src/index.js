const { defaultRunner } = require('./runner')

const benchmark = (...args) => {
	defaultRunner.appendSimpleBenchmark(...args)
}

benchmark.complex = (...args) => {
	defaultRunner.appendComplexBenchmark(...args)
}

module.exports = { benchmark }
