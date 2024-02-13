if (!global.gc) {
	throw new Error("speedtest requires the `--expose-gc` flag")
}

{
	const { execSync } = require('child_process')
	const output = execSync(`taskset -cp ${process.pid}`).toString().trim()
	if (output.match(/\d+-\d+$/u)) {
		throw new Error("speedtest must be launched with `taskset 01 <cmd>`")
	}
}

const Path = require('path')
const Util = require('util')
const { amrap } = require('@kmamal/util/function/async/amrap')
const { time } = require('@kmamal/util/function/async/time')
const { product } = require('@kmamal/util/array/combinatorics/product')
const { map } = require('@kmamal/util/array/map')
const { every } = require('@kmamal/util/array/every')
const { zip: zipObject } = require('@kmamal/util/object/zip')

const makeOption = (x) => ({ name: x, value: x })

const toTable = (keys, record) => {
	const { length } = keys
	const firstValue = `${record[keys[0]]} `.padStart(10)
	const otherValues = new Array(length - 1)
	for (let i = 1; i < length; i++) {
		otherValues[i - 1] = record[keys[i]]
	}
	return firstValue + otherValues.join(', ')
}


class BenchmarkRunner {
	constructor () {
		this.countFiles = 0
		this.countBenchmarks = 0
		this.countFailed = 0

		this.stack = []
		this.running = false
		this.filesDone = false
	}

	appendSimpleBenchmark (name, description) {
		this.stack.push({ name, description })

		if (this.running) { return }
		this.running = true

		process.nextTick(() => this.runBenchmarks())
	}

	appendComplexBenchmark (name, description) {
		this.stack.push({ name, description, complex: true })

		if (this.running) { return }
		this.running = true

		process.nextTick(() => this.runBenchmarks())
	}

	async runSimpleBenchmark (description) {
		this.countBenchmarks += 1

		const {
			cases: _c,
			pre,
			post,
			time: timePerCase = 1e3,
		} = description

		const cases = []
		{
			for (const [ name, callback ] of Object.entries(_c)) {
				cases.push({ name, callback })
			}

			const numCases = cases.length
			const totalTimeEstimate = timePerCase * numCases
			if (totalTimeEstimate > 10e3) {
				console.log(`Estimate: ${Math.floor(totalTimeEstimate / 1000)} seconds for ${numCases} cases`)
			}
		}

		const labels = {
			result: "Result",
			case: "Case",
		}

		for (const { name, callback } of cases) {
			const preData = pre ? pre() : null

			// Prepare
			global.gc(true)

			// Warmup
			const warmupTime = time(() => callback(preData))

			if (warmupTime > timePerCase) {
				console.log(toTable(Object.keys(labels), { case: name, result: 0 }))
				post && post(preData)
				continue
			}

			if (warmupTime * 2 > timePerCase) {
				console.log(toTable(Object.keys(labels), { case: name, result: 1 }))
				post && post(preData)
				continue
			}

			// Measure
			const { elapsed, reps } = await amrap((n) => {
				for (let i = 0; i < n; i++) {
					callback(preData)
				}
			}, timePerCase)

			post && post(preData)

			const correctionFactor = timePerCase / elapsed
			const result = Math.floor(reps * correctionFactor)
			console.log(toTable(Object.keys(labels), { case: name, result }))
		}
	}

	async runComplexBenchmark (description) {
		this.countBenchmarks += 1

		const {
			parameters: _p,
			pre,
			post,
			callback,
			time: timePerCase = 1e3,
		} = description

		const parameters = Object.entries(_p)
		const numParameters = parameters.length
		const parameterKeys = new Array(numParameters)
		const parameterOptions = new Array(numParameters)

		const labels = { result: "" }
		{
			for (let i = 0; i < numParameters; i++) {
				const [ key, { name, options, values } ] = parameters[i]
				labels[key] = name
				parameterKeys[i] = key
				parameterOptions[i] = options ?? map(values, makeOption)
			}
		}

		const cases = []
		{
			for (const options of product(parameterOptions)) {
				const names = map(options, ({ name }) => name)
				const info = zipObject(parameterKeys, names)

				const filters = map(options, ({ filter }) => filter).filter(Boolean)
				if (!every(filters, (filter) => filter(info))) {
					continue
				}

				const values = map(options, ({ value }) => value)
				const data = zipObject(parameterKeys, values)
				cases.push({ info, data })
			}

			const numCases = cases.length
			const totalTimeEstimate = timePerCase * numCases
			if (totalTimeEstimate > 10e3) {
				console.log(`Estimate: ${Math.floor(totalTimeEstimate / 1000)} seconds for ${numCases} cases`)
			}
		}


		const lastKey = parameterKeys.at(-1)
		const lastValue = parameterOptions.at(-1).at(-1).value

		for (const c of cases) {
			const { info, data } = c

			const preData = pre ? pre(data) : null

			// Prepare
			global.gc(true)

			// Warmup
			const warmupTime = time(() => callback(data, preData))

			if (warmupTime > timePerCase) {
				console.log(toTable(Object.keys(labels), { ...info, result: 0 }))
				post && post(preData)
				continue
			}

			if (warmupTime * 2 > timePerCase) {
				console.log(toTable(Object.keys(labels), { ...info, result: 1 }))
				post && post(preData)
				continue
			}

			// Measure
			const { elapsed, reps } = await amrap((n) => {
				for (let i = 0; i < n; i++) {
					callback(data, preData)
				}
			}, timePerCase)

			post && post(preData)

			const correctionFactor = timePerCase / elapsed
			const result = Math.floor(reps * correctionFactor)
			console.log(toTable(Object.keys(labels), { ...info, result }))

			// Separate cases
			if (numParameters > 1 && data[lastKey] === lastValue) {
				console.log()
			}
		}
	}

	async runBenchmarks () {
		while (this.stack.length > 0) {
			const item = this.stack.shift()

			if (typeof item === 'string') {
				console.group(item)
				continue
			}

			if (item === null) {
				console.groupEnd()
				console.log()
				continue
			}

			const { name, description, complex } = item

			console.group(name)

			let error = null
			try {
				complex
					? await this.runComplexBenchmark(description)
					: await this.runSimpleBenchmark(description)
			} catch (_error) {
				error = _error
			}

			if (error) {
				console.error("->", Util.inspect(error, {
					depth: Infinity,
					colors: true,
					breakLength: process.stdout.columns,
				}))
				this.countFailed += 1
			}

			console.groupEnd()
		}

		if (this.filesDone) {
			console.log(`files: ${this.countFiles}`)
			console.log(`benchmarks: ${this.countBenchmarks}`)
			console.log(`failed: ${this.countFailed}`)

			process.exit(this.countFailed > 0 ? 1 : 0)
		}

		this.running = false
	}

	async appendFile (path) {
		this.countFiles += 1

		this.stack.push(path)

		const resolved = Path.resolve(path)
		try {
			require(resolved)
		} catch (error) {
			if (error.code === 'ERR_REQUIRE_ESM') {
				await import(resolved)
			} else {
				throw error
			}
		}

		this.stack.push(null)
	}

	finish () {
		this.filesDone = true
		this.runBenchmarks()
	}
}

const defaultRunner = new BenchmarkRunner()

module.exports = {
	BenchmarkRunner,
	defaultRunner,
}
