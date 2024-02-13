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
	const firstValue = `${record[keys[0]]}`.padEnd(10)
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
				const preData = pre ? pre() : null
				const elapsed = time(() => callback(preData))
				post && post(preData)

				if (elapsed * 10 <= timePerCase) {
					cases.push({ name, callback })
				} else {
					console.warn("WARN", 'too slow', { name })
				}
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

			// Warmup
			global.gc(true)
			for (let i = 0; i < 10; i++) { callback(preData) }

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

				const preData = pre ? pre(data) : null
				const elapsed = time(() => callback(data, preData))
				post && post(preData)

				if (elapsed * 10 <= timePerCase) {
					cases.push({ info, data })
				} else {
					console.warn("WARN", 'too slow', { data: info })
				}
			}

			const numCases = cases.length
			const totalTimeEstimate = timePerCase * numCases
			if (totalTimeEstimate > 10e3) {
				console.log(`Estimate: ${Math.floor(totalTimeEstimate / 1000)} seconds for ${numCases} cases`)
			}
		}

		if (numParameters > 1) {
			console.log(toTable(Object.keys(labels), labels))
		}

		for (const c of cases) {
			const { info, data } = c

			const preData = pre ? pre(data) : null

			// Warmup
			global.gc(true)
			for (let i = 0; i < 10; i++) { callback(data, preData) }

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
