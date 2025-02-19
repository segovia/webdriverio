import fs from 'node:fs/promises'
import path from 'node:path'
import util from 'node:util'
import inquirer from 'inquirer'
import yarnInstall from 'yarn-install'
import type { Argv } from 'yargs'

import {
    CONFIG_HELPER_INTRO, CLI_EPILOGUE, COMPILER_OPTIONS,
    CONFIG_HELPER_SUCCESS_MESSAGE, TESTING_LIBRARY_PACKAGES,
    DEPENDENCIES_INSTALLATION_MESSAGE, SUPPORTED_PACKAGES,
    pkg
} from '../constants.js'
import {
    addServiceDeps, convertPackageHashToObject, renderConfigurationFile,
    hasFile, generateTestFiles, getAnswers, getPathForFileGeneration,
    hasPackage, specifyVersionIfNeeded
} from '../utils.js'
import type { ConfigCommandArguments, ParsedAnswers } from '../types'

export const command = 'config'
export const desc = 'Initialize WebdriverIO and setup configuration in your current project.'

export const cmdArgs = {
    yarn: {
        type: 'boolean',
        desc: 'Install packages via yarn package manager.',
        default: hasFile('yarn.lock')
    },
    yes: {
        alias: 'y',
        desc: 'will fill in all config defaults without prompting',
        type: 'boolean',
        default: false
    }
} as const

export const builder = (yargs: Argv) => {
    return yargs
        .options(cmdArgs)
        .epilogue(CLI_EPILOGUE)
        .help()
}

const runConfig = async function (useYarn: boolean, yes: boolean, exit = false) {
    console.log(CONFIG_HELPER_INTRO)
    const answers = await getAnswers(yes)
    const frameworkPackage = convertPackageHashToObject(answers.framework)
    const runnerPackage = convertPackageHashToObject(answers.runner || SUPPORTED_PACKAGES.runner[0].value)
    const servicePackages = answers.services.map((service) => convertPackageHashToObject(service))
    const pluginPackages = answers.plugins.map((plugin)=> convertPackageHashToObject(plugin))
    const reporterPackages = answers.reporters.map((reporter) => convertPackageHashToObject(reporter))
    const presetPackage = convertPackageHashToObject(answers.preset || '')

    let packagesToInstall: string[] = [
        runnerPackage.package,
        frameworkPackage.package,
        presetPackage.package,
        ...reporterPackages.map(reporter => reporter.package),
        ...pluginPackages.map(plugin => plugin.package),
        ...servicePackages.map(service => service.package)
    ].filter(Boolean)

    /**
     * find relative paths between tests and pages
     */
    const parsedPaths = getPathForFileGeneration(answers)
    const parsedAnswers: ParsedAnswers = {
        // default values required in templates
        ...({
            usePageObjects: false,
            installTestingLibrary: false
        }),
        ...answers,
        runner: runnerPackage.short as 'local' | 'browser',
        preset: presetPackage.short,
        framework: frameworkPackage.short,
        reporters: reporterPackages.map(({ short }) => short),
        plugins: pluginPackages.map(({ short }) => short),
        services: servicePackages.map(({ short }) => short),
        packagesToInstall,
        isUsingTypeScript: answers.isUsingCompiler === COMPILER_OPTIONS.ts,
        isUsingBabel: answers.isUsingCompiler === COMPILER_OPTIONS.babel,
        isSync: false,
        _async: 'async ',
        _await: 'await ',
        destSpecRootPath: parsedPaths.destSpecRootPath,
        destPageObjectRootPath: parsedPaths.destPageObjectRootPath,
        relativePath : parsedPaths.relativePath,
        tsConfigFilePath : path.join(process.cwd(), 'test', 'tsconfig.json')
    }

    /**
     * add ts-node if TypeScript is desired but not installed
     */
    if (parsedAnswers.isUsingTypeScript) {
        if (!await hasPackage('ts-node')) {
            packagesToInstall.push('ts-node', 'typescript')
        }

        const types = [
            'node',
            '@wdio/globals/types',
            'expect-webdriverio',
            frameworkPackage.package,
            ...(parsedAnswers.runner === 'browser' ? ['@wdio/browser-runner'] : []),
            ...servicePackages
                .map(service => service.package)
                /**
                 * given that we know that all "offical" services have
                 * typescript support we only include them
                 */
                .filter(service => service.startsWith('@wdio'))
        ]

        const config = {
            compilerOptions: {
                moduleResolution: 'node',
                types,
                target: 'es2022',
            }
        }

        await fs.mkdir(path.join(process.cwd(), 'test'), { recursive: true })
        await fs.writeFile(
            parsedAnswers.tsConfigFilePath,
            JSON.stringify(config, null, 4)
        )

    }

    /**
     * install Testing Library dependency if desired
     */
    if (answers.installTestingLibrary) {
        packagesToInstall.push(
            TESTING_LIBRARY_PACKAGES[presetPackage.short],
            '@testing-library/jest-dom'
        )
    }

    /**
     * add @babel/register package if not installed
     */
    if (parsedAnswers.isUsingBabel) {
        if (!await hasPackage('@babel/register')) {
            packagesToInstall.push('@babel/register')
        }

        /**
         * setup Babel if no config file exists
         */
        if (!hasFile('babel.config.js')) {
            if (!await hasPackage('@babel/core')) {
                packagesToInstall.push('@babel/core')
            }
            if (!await hasPackage('@babel/preset-env')) {
                packagesToInstall.push('@babel/preset-env')
            }
            await fs.writeFile(
                path.join(process.cwd(), 'babel.config.js'),
                `module.exports = ${JSON.stringify({
                    presets: [
                        ['@babel/preset-env', {
                            targets: {
                                node: '14'
                            }
                        }]
                    ]
                }, null, 4)}`
            )
        }
    }

    /**
     * add packages that are required by services
     */
    addServiceDeps(servicePackages, packagesToInstall)
    /**
     * update package version if CLI is a pre release
     */
    packagesToInstall = specifyVersionIfNeeded(packagesToInstall, pkg.version)

    /**
     * run npm install only if required by the user
     */
    if (parsedAnswers.npmInstall){
        console.log('\nInstalling wdio packages:\n-', packagesToInstall.join('\n- '))
        const result = yarnInstall({ deps: packagesToInstall, dev: true, respectNpm5: !useYarn })
        if (result.status !== 0) {
            const customError = 'An unknown error happened! Please retry ' +
                `installing dependencies via "${useYarn ? 'yarn add --dev' : 'npm i --save-dev'} ` +
                `${packagesToInstall.join(' ')}"\n\nError: ${result.stderr || 'unknown'}`
            console.log(customError)

            /**
             * don't exit if running unit tests
             */
            if (exit /* istanbul ignore next */ && !process.env.VITEST_WORKER_ID) {
                /* istanbul ignore next */
                process.exit(1)
            }

            return { success: false }
        }

        console.log('\nPackages installed successfully, creating configuration file...')
    } else {
        const installationCommand = `${useYarn ? 'yarn add --dev' : 'npm i --save-dev'} ${packagesToInstall.join(' ')}`
        console.log(util.format(DEPENDENCIES_INSTALLATION_MESSAGE,
            installationCommand
        ))
    }

    try {
        await renderConfigurationFile(parsedAnswers)
        if (answers.generateTestFiles) {
            console.log('\nConfig file installed successfully, creating test files...')
            await generateTestFiles(parsedAnswers)
        }
    } catch (err: any) {
        throw new Error(`Couldn't write config file: ${err.stack}`)
    }

    console.log(util.format(CONFIG_HELPER_SUCCESS_MESSAGE,
        parsedAnswers.isUsingTypeScript ? 'test/' : '',
        parsedAnswers.isUsingTypeScript ? 'ts' : 'js'
    ))

    /**
     * don't exit if running unit tests
     */
    if (exit /* istanbul ignore next */ && !process.env.VITEST_WORKER_ID) {
        /* istanbul ignore next */
        process.exit(0)
    }

    return {
        success: true,
        parsedAnswers,
        installedPackages: packagesToInstall.map((pkg) => pkg.split('--')[0])
    }
}

export function handler(argv: ConfigCommandArguments) {
    return runConfig(argv.yarn, argv.yes)
}

/**
 * Helper utility used in `run` and `install` command to create config if none exist
 * @param {string}   command        to be executed by user
 * @param {string}   message        to show when no config is suppose to be created
 * @param {boolean}  useYarn        parameter set to true if yarn is used
 * @param {Function} runConfigCmd   runConfig method to be replaceable for unit testing
 */
export async function missingConfigurationPrompt(command: string, message: string, useYarn = false, runConfigCmd = runConfig) {
    const configMessage = command === 'run'
        ? `Error: Could not execute "run" due to missing configuration, file "${message}" not found! Would you like to create one?`
        : `Error: Could not execute "${command}" due to missing configuration. Would you like to create one?`

    const { config } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'config',
            message: configMessage,
            default: false
        }
    ])

    /**
     * don't exit if running unit tests
     */
    if (!config && !process.env.VITEST_WORKER_ID) {
        /* istanbul ignore next */
        console.log(command === 'run'
            ? `No WebdriverIO configuration found in "${process.cwd()}"`
            : message)

        /* istanbul ignore next */
        return process.exit(0)
    }

    return await runConfigCmd(useYarn, false, true)
}
