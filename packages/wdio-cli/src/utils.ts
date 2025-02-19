import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { promisify } from 'node:util'

import ejs from 'ejs'
import path from 'node:path'
import inquirer from 'inquirer'
import pickBy from 'lodash.pickby'
import logger from '@wdio/logger'
import readDir from 'recursive-readdir'
import { resolve } from 'import-meta-resolve'
import { SevereServiceError } from 'webdriverio'
import { ConfigParser } from '@wdio/config'
import { CAPABILITY_KEYS } from '@wdio/protocols'
import type { Options, Capabilities, Services } from '@wdio/types'

import { EXCLUSIVE_SERVICES, ANDROID_CONFIG, IOS_CONFIG, QUESTIONNAIRE, COMMUNITY_PACKAGES_WITH_V8_SUPPORT } from './constants.js'
import type { ReplCommandArguments, Questionnair, SupportedPackage, OnCompleteResult, ParsedAnswers } from './types'

const log = logger('@wdio/cli:utils')
const __dirname = dirname(fileURLToPath(import.meta.url))

const VERSION_REGEXP = /(\d+)\.(\d+)\.(\d+)-(alpha|beta|)\.(\d+)\+(.+)/g
const TEMPLATE_ROOT_DIR = path.join(__dirname, 'templates', 'exampleFiles')
const renderFile = promisify(ejs.renderFile) as (path: string, data: Record<string, any>) => Promise<string>

export class HookError extends SevereServiceError {
    public origin: string
    constructor(message: string, origin: string) {
        super(message)
        this.origin = origin
    }
}

/**
 * run service launch sequences
 */
export async function runServiceHook(
    launcher: Services.ServiceInstance[],
    hookName: keyof Services.HookFunctions,
    ...args: any[]
) {
    const start = Date.now()
    return Promise.all(launcher.map(async (service: Services.ServiceInstance) => {
        try {
            if (typeof service[hookName] === 'function') {
                await (service[hookName] as Function)(...args)
            }
        } catch (err: any) {
            const message = `A service failed in the '${hookName}' hook\n${err.stack}\n\n`

            if (err instanceof SevereServiceError) {
                return { status: 'rejected', reason: message, origin: hookName }
            }

            log.error(`${message}Continue...`)
        }
    })).then(results => {
        if (launcher.length) {
            log.debug(`Finished to run "${hookName}" hook in ${Date.now() - start}ms`)
        }

        const rejectedHooks = results.filter(p => p && p.status === 'rejected')
        if (rejectedHooks.length) {
            return Promise.reject(new HookError(`\n${rejectedHooks.map(p => p && p.reason).join()}\n\nStopping runner...`, hookName))
        }
    })
}

/**
 * Run hook in service launcher
 * @param {Array|Function} hook - can be array of functions or single function
 * @param {Object} config
 * @param {Object} capabilities
 */
export async function runLauncherHook(hook: Function | Function[], ...args: any[]) {
    if (typeof hook === 'function') {
        hook = [hook]
    }

    const catchFn = (e: Error) => {
        log.error(`Error in hook: ${e.stack}`)
        if (e instanceof SevereServiceError) {
            throw new HookError(e.message, (hook as Function[])[0].name)
        }
    }

    return Promise.all(hook.map((hook) => {
        try {
            return hook(...args)
        } catch (err: any) {
            return catchFn(err)
        }
    })).catch(catchFn)
}

/**
 * Run onCompleteHook in Launcher
 * @param {Array|Function} onCompleteHook - can be array of functions or single function
 * @param {*} config
 * @param {*} capabilities
 * @param {*} exitCode
 * @param {*} results
 */
export async function runOnCompleteHook(
    onCompleteHook: Function | Function[],
    config: Options.Testrunner,
    capabilities: Capabilities.RemoteCapabilities,
    exitCode: number,
    results: OnCompleteResult
) {
    if (typeof onCompleteHook === 'function') {
        onCompleteHook = [onCompleteHook]
    }

    return Promise.all(onCompleteHook.map(async (hook) => {
        try {
            await hook(exitCode, config, capabilities, results)
            return 0
        } catch (err: any) {
            log.error(`Error in onCompleteHook: ${err.stack}`)
            if (err instanceof SevereServiceError) {
                throw new HookError(err.message, 'onComplete')
            }
            return 1
        }
    }))
}

/**
 * get runner identification by caps
 */
export function getRunnerName (caps: Capabilities.DesiredCapabilities = {}) {
    let runner =
        caps.browserName ||
        caps.appPackage ||
        caps.appWaitActivity ||
        caps.app ||
        caps.platformName ||
        caps['appium:platformName'] ||
        caps['appium:appPackage'] ||
        caps['appium:appWaitActivity'] ||
        caps['appium:app']

    // MultiRemote
    if (!runner) {
        runner = Object.values(caps).length === 0 || Object.values(caps).some(cap => !cap.capabilities) ? 'undefined' : 'MultiRemote'
    }

    return runner
}

function buildNewConfigArray (str: string, type: string, change: string) {
    const newStr = str
        .split(`${type}s: `)[1]
        .replace(/'/g, '')

    let newArray = newStr.match(/(\w*)/gmi)?.filter(e => !!e).concat([change]) || []

    return str
        .replace('// ', '')
        .replace(
            new RegExp(`(${type}s: )((.*\\s*)*)`), `$1[${newArray.map(e => `'${e}'`)}]`
        )
}

function buildNewConfigString (str: string, type: string, change: string) {
    return str.replace(new RegExp(`(${type}: )('\\w*')`), `$1'${change}'`)
}

export function findInConfig (config: string, type: string) {
    let regexStr = `[\\/\\/]*[\\s]*${type}s: [\\s]*\\[([\\s]*['|"]\\w*['|"],*)*[\\s]*\\]`

    if (type === 'framework') {
        regexStr = `[\\/\\/]*[\\s]*${type}: ([\\s]*['|"]\\w*['|"])`
    }

    const regex = new RegExp(regexStr, 'gmi')
    return config.match(regex)
}

export function replaceConfig (config: string, type: string, name: string) {
    if (type === 'framework') {
        return buildNewConfigString(config, type, name)
    }

    const match = findInConfig(config, type)
    if (!match || match.length === 0) {
        return
    }

    const text = match.pop() || ''
    return config.replace(text, buildNewConfigArray(text, type, name))
}

export function addServiceDeps(names: SupportedPackage[], packages: string[], update = false) {
    /**
     * automatically install latest Chromedriver if `wdio-chromedriver-service`
     * was selected for install
     */
    if (names.some(({ short }) => short === 'chromedriver')) {
        packages.push('chromedriver')
        if (update) {
            // eslint-disable-next-line no-console
            console.log(
                '\n=======',
                '\nPlease change path to / in your wdio.conf.js:',
                "\npath: '/'",
                '\n=======\n')
        }
    }

    /**
     * install Appium if it is not installed globally if `@wdio/appium-service`
     * was selected for install
     */
    if (names.some(({ short }) => short === 'appium')) {
        const result = execSync('appium --version || echo APPIUM_MISSING').toString().trim()
        if (result === 'APPIUM_MISSING') {
            packages.push('appium')
        } else if (update) {
            // eslint-disable-next-line no-console
            console.log(
                '\n=======',
                '\nUsing globally installed appium', result,
                '\nPlease add the following to your wdio.conf.js:',
                "\nappium: { command: 'appium' }",
                '\n=======\n')
        }
    }
}

/**
 * @todo add JSComments
 */
export function convertPackageHashToObject(pkg: string, hash = '$--$'): SupportedPackage {
    const splitHash = pkg.split(hash)
    return {
        package: splitHash[0],
        short: splitHash[1]
    }
}

export async function renderConfigurationFile (answers: ParsedAnswers) {
    const tplPath = path.join(__dirname, 'templates/wdio.conf.tpl.ejs')
    const filename = `wdio.conf.${answers.isUsingTypeScript ? 'ts' : 'js'}`
    const renderedTpl = await renderFile(tplPath, { answers })
    return fs.writeFile(
        path.join(
            process.cwd(),
            answers.isUsingTypeScript ? 'test' : '', filename
        ),
        renderedTpl
    )
}

export const validateServiceAnswers = (answers: string[]): Boolean | string => {
    let result: boolean | string = true

    Object.entries(EXCLUSIVE_SERVICES).forEach(([name, { services, message }]) => {
        const exists = answers.some(answer => answer.includes(name))

        const hasExclusive = services.some(service =>
            answers.some(answer => answer.includes(service))
        )

        if (exists && hasExclusive) {
            result = `${name} cannot work together with ${services.join(', ')}\n${message}\nPlease uncheck one of them.`
        }
    })

    return result
}

export async function getCapabilities(arg: ReplCommandArguments) {
    const optionalCapabilites = {
        platformVersion: arg.platformVersion,
        udid: arg.udid,
        ...(arg.deviceName && { deviceName: arg.deviceName })
    }
    /**
     * Parsing of option property and constructing desiredCapabilities
     * for Appium session. Could be application(1) or browser(2-3) session.
     */
    if (/.*\.(apk|app|ipa)$/.test(arg.option)) {
        return {
            capabilities: {
                app: arg.option,
                ...(arg.option.endsWith('apk') ? ANDROID_CONFIG : IOS_CONFIG),
                ...optionalCapabilites,
            }
        }
    } else if (/android/.test(arg.option)) {
        return { capabilities: { browserName: 'Chrome', ...ANDROID_CONFIG, ...optionalCapabilites } }
    } else if (/ios/.test(arg.option)) {
        return { capabilities: { browserName: 'Safari', ...IOS_CONFIG, ...optionalCapabilites } }
    } else if (/(js|ts)$/.test(arg.option)) {
        const config = new ConfigParser(arg.option)
        try {
            await config.initialize()
        } catch (e) {
            throw Error((e as any).code === 'MODULE_NOT_FOUND' ? `Config File not found: ${arg.option}`:
                `Could not parse ${arg.option}, failed with error : ${(e as Error).message}`)
        }
        if (typeof arg.capabilities === 'undefined') {
            throw Error('Please provide index/named property of capability to use from the capabilities array/object in wdio config file')
        }
        let requiredCaps = config.getCapabilities()
        requiredCaps = (
            // multi capabilities
            (requiredCaps as (Capabilities.DesiredCapabilities | Capabilities.W3CCapabilities)[])[parseInt(arg.capabilities, 10)] ||
            // multiremote
            (requiredCaps as Capabilities.MultiRemoteCapabilities)[arg.capabilities]
        )
        const requiredW3CCaps = pickBy(requiredCaps, (_, key) => CAPABILITY_KEYS.includes(key) || key.includes(':'))
        if (!Object.keys(requiredW3CCaps).length) {
            throw Error(`No capability found in given config file with the provided capability indexed/named property: ${arg.capabilities}. Please check the capability in your wdio config file.`)
        }
        return { capabilities: { ...(requiredW3CCaps as Capabilities.W3CCapabilities) } }
    }
    return { capabilities: { browserName: arg.option } }
}

/**
 * Check if file exists in current work directory
 * @param {string} filename to check existance for
 */
export function hasFile (filename: string) {
    try {
        fsSync.accessSync(path.join(process.cwd(), filename))
        return true
    } catch (err: any) {
        return false
    }
}

/**
 * Check if package is installed
 * @param {string} package to check existance for
 */
export async function hasPackage (pkg: string) {
    try {
        await resolve(pkg, import.meta.url)
        return true
    } catch (err: any) {
        return false
    }
}

/**
 * generate test files based on CLI answers
 */
export async function generateTestFiles (answers: ParsedAnswers) {
    const testFiles = answers.framework === 'cucumber'
        ? [path.join(TEMPLATE_ROOT_DIR, 'cucumber')]
        : (answers.framework === 'mocha'
            ? [path.join(TEMPLATE_ROOT_DIR, 'mocha')]
            : [path.join(TEMPLATE_ROOT_DIR, 'jasmine')])

    if (answers.usePageObjects) {
        testFiles.push(path.join(TEMPLATE_ROOT_DIR, 'pageobjects'))
    }

    const files = (await Promise.all(testFiles.map((dirPath) => readDir(
        dirPath,
        [(file, stats) => !stats.isDirectory() && !(file.endsWith('.ejs') || file.endsWith('.feature'))]
    )))).reduce((cur, acc) => [...acc, ...(cur)], [])

    for (const file of files) {
        const renderedTpl = await renderFile(file, answers)
        let destPath = (
            file.endsWith('page.js.ejs')
                ? `${answers.destPageObjectRootPath}/${path.basename(file)}`
                : file.includes('step_definition')
                    ? `${answers.stepDefinitions}`
                    : `${answers.destSpecRootPath}/${path.basename(file)}`
        ).replace(/\.ejs$/, '').replace(/\.js$/, answers.isUsingTypeScript ? '.ts' : '.js')

        await fs.mkdir(path.dirname(destPath), { recursive: true })
        await fs.writeFile(destPath, renderedTpl)
    }
}

export async function getAnswers(yes: boolean): Promise<Questionnair> {
    return yes
        ? QUESTIONNAIRE.reduce((answers, question) => Object.assign(
            answers,
            question.when && !question.when(answers)
                /**
                 * set nothing if question doesn't apply
                 */
                ? {}
                : { [question.name]: typeof question.default !== 'undefined'
                    /**
                     * set default value if existing
                     */
                    ? typeof question.default === 'function'
                        ? question.default(answers)
                        : question.default
                    : question.choices && question.choices.length
                    /**
                     * pick first choice, select value if it exists
                     */
                        ? typeof question.choices === 'function'
                            ? (question.choices(answers)[0] as any as { value: any }).value
                                ? (question.choices(answers)[0] as any as { value: any }).value
                                : question.choices(answers)[0]
                            : (question.choices[0] as { value: any }).value
                                ? (question.choices[0] as { value: any }).value
                                : question.choices[0]
                        : {}
                }
        ), {} as Questionnair)
        : await inquirer.prompt(QUESTIONNAIRE)
}

export function getPathForFileGeneration (answers: Questionnair) {
    const destSpecRootPath = path.join(
        process.cwd(),
        path.dirname(answers.specs || '').replace(/\*\*$/, ''))

    const destStepRootPath = path.join(process.cwd(), path.dirname(answers.stepDefinitions || ''))

    const destPageObjectRootPath = answers.usePageObjects
        ?  path.join(
            process.cwd(),
            path.dirname(answers.pages || '').replace(/\*\*$/, ''))
        : ''
    let relativePath = (answers.generateTestFiles && answers.usePageObjects)
        ? !(convertPackageHashToObject(answers.framework).short === 'cucumber')
            ? path.relative(destSpecRootPath, destPageObjectRootPath)
            : path.relative(destStepRootPath, destPageObjectRootPath)
        : ''

    /**
    * On Windows, path.relative can return backslashes that could be interpreted as espace sequences in strings
    */
    if (process.platform === 'win32') {
        relativePath = relativePath.replace(/\\/g, '/')
    }

    return {
        destSpecRootPath : destSpecRootPath,
        destStepRootPath : destStepRootPath,
        destPageObjectRootPath : destPageObjectRootPath,
        relativePath : relativePath
    }
}

export function getDefaultFiles (answers: Partial<Questionnair>, filePath: string) {
    return answers?.isUsingCompiler?.toString().includes('TypeScript')
        ? `${filePath}.ts`
        : `${filePath}.js`
}

/**
 * Ensure core WebdriverIO packages have the same version as cli so that if someone
 * installs `@wdio/cli@next` and runs the wizard, all related packages have the same version.
 * running `matchAll` to a version like "8.0.0-alpha.249+4bc237701", results in:
 * ['8.0.0-alpha.249+4bc237701', '8', '0', '0', 'alpha', '249', '4bc237701']
 */
export function specifyVersionIfNeeded (packagesToInstall: string[], version: string) {
    const { value } = version.matchAll(VERSION_REGEXP).next()
    if (value) {
        const [major, minor, patch, tagName, build] = value.slice(1, -1) // drop commit bit
        return packagesToInstall.map((p) => {
            if (p.startsWith('@wdio') || ['devtools', 'webdriver', 'webdriverio'].includes(p)) {
                return `${p}@^${major}.${minor}.${patch}-${tagName}.${build}`
            }
            if (COMMUNITY_PACKAGES_WITH_V8_SUPPORT.includes(p)) {
                return `${p}@next`
            }
            return p
        })
    }

    return packagesToInstall
}
