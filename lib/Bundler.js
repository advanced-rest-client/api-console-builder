/**
 * Copyright (C) MuleSoft.
 * Shared under Apache 2.0 license
 *
 * @author Pawel Psztyc
 */
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs-extra';
import path from 'path';

const pExec = util.promisify(exec);

/** @typedef {import('winston').Logger} Winston */

/**
 * Bundles the console sources.
 */
export class Bundler {
  /**
   * @param {string} workingDir
   * @param {Winston} logger
   */
  constructor(workingDir, logger) {
    this.workingDir = workingDir;
    this.logger = logger;
  }

  /**
   * @return {string} The destination location for the build
   */
  get dest() {
    const { workingDir } = this;
    return path.join(workingDir, 'dist');
  }

  /**
   * Creates API Console bundles.
   * @return {Promise<void>}
   */
  async bundle() {
    await this.cleanOutput();
    await this.runBundler();
  }

  /**
   * Removes build destination output directory.
   * @return {Promise<void>}
   */
  async cleanOutput() {
    const { dest, logger } = this;
    logger.debug('Cleaning build output directory...');
    await fs.remove(dest);
  }

  /**
   * Bundles the console.
   * @return {Promise<void>}
   */
  async runBundler() {
    const { logger } = this;
    logger.info('Bundling API Console...');
    let command = path.join('node_modules', '.bin', 'rollup');
    if (process.platform === 'win32') {
      command += '.cmd';
    }
    command += ' -c rollup.config.js';
    await this._runCmd(command);
    logger.info('Bundler finished.');
  }

  /**
   * Runs command in a separated process.
   * @param {String} command The command to execute.
   * @return {Promise<void>}
   */
  async _runCmd(command) {
    const { workingDir, logger } = this;
    const options = {
      cwd: workingDir,
      maxBuffer: 1024 * 5000,
    };
    const { stdout, stderr } = await pExec(command, options);
    if (stdout) {
      logger.debug(stdout);
    }
    if (stderr) {
      logger.error(stderr);
    }
  }
}
