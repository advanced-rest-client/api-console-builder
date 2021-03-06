/**
 * Copyright (C) MuleSoft.
 * Shared under Apache 2.0 license
 *
 * @author Pawel Psztyc
 */
import fs from 'fs-extra';
import path from 'path';
import archiver from 'archiver';
import yauzl from 'yauzl';
import crypto from 'crypto';

/** @typedef {import('winston').Logger} Winston */
/** @typedef {import('./BuilderOptions').BuilderOptions} BuilderOptions */
/** @typedef {import('./BuilderOptions').ProjectConfiguration} ProjectConfiguration */

/**
 * A class responsible for caching and restoring complete build
 * of the API console.
 * It speeds up the build process on development machines.
 * This should not be used in the CI pipeline as it will prohibit downloading
 * latest version of the components.
 */
export class CacheBuild {
  /**
   * @param {BuilderOptions|ProjectConfiguration} opts User options.
   * @param {Winston} logger
   */
  constructor(opts, logger) {
    this.opts = opts;
    this.logger = logger;
    if (!this.opts.noCache) {
      this.hash = this.createHash(opts);
      logger.debug(`Build cache hash is ${this.hash}`);
      this.cacheFolder = this.locateAppDir();
    }
  }

  /**
   * Creates a path to cache folder under user data folder.
   *
   * @param {string=} platform Current platform. If not set `process.platform`
   * is used.
   * @return {string}
   */
  locateAppDir(platform) {
    let dir;
    if (!platform) {
      platform = process.platform;
    }
    if (typeof process.env.APPDATA !== 'undefined' && process.env.APPDATA) {
      dir = process.env.APPDATA;
    } else if (platform === 'darwin') {
      dir = path.join(process.env.HOME, 'Library', 'Preferences');
    } else if (platform === 'linux') {
      dir = path.join(process.env.HOME, '.config');
    } else {
      dir = '/var/local';
    }
    dir = path.join(dir, 'api-console', 'cache', 'builds');
    this.logger.debug(`Setting builds cache path to ${ dir}`);
    return dir;
  }

  /**
   * Creates cache file sha256 hash from user options.
   * This should ensure uniques of cached versions of the build.
   *
   * Note, only options that influence final build are considered.
   *
   * @param {BuilderOptions|ProjectConfiguration} opts Builder options
   * @return {String} Cache file sha256 hash.
   */
  createHash(opts) {
    const hash = crypto.createHash('sha256');
    const parts = [];
    if (opts.tagName) {
      parts.push(`tn=${opts.tagName}`);
    }
    if (opts.themeFile) {
      parts.push(`tf=${opts.themeFile}`);
    }
    if (opts.indexFile) {
      parts.push(`if=${opts.indexFile}`);
    }
    if (opts.appTitle) {
      parts.push(`at=${opts.appTitle}`);
    }
    if (opts.attributes) {
      try {
        parts.push(`a=${JSON.stringify(opts.attributes)}`);
      } catch (_) {
        // ..
      }
    }
    hash.update(parts.join('|'));
    return hash.digest('hex');
  }

  /**
   * Checks if cache file exists.
   * @return {Promise<boolean>}
   */
  async hasCache() {
    if (this.opts.noCache) {
      return false;
    }
    const location = path.join(this.cacheFolder, `${this.hash}.zip`);
    return fs.pathExists(location);
  }

  /**
   * Restores cached build to `build` location.
   * @param {string} build Build location
   * @return {Promise<void>}
   */
  async restore(build) {
    const source = path.join(this.cacheFolder, `${this.hash}.zip`);
    this.logger.debug('Opening cached zip file.');
    await this._processZip(source, build);
  }

  /**
   * Unzips files from the zip file and copy them to the destination folder.
   *
   * @param {string} source File location.
   * @param {string} destination Folder where to put the files.
   * @return {Promise<void>}
   */
  _processZip(source, destination) {
    return new Promise((resolve, reject) => {
      const promises = [];
      yauzl.open(source, { lazyEntries: true }, (err, zipFile) => {
        if (err) {
          reject(err);
          return;
        }
        zipFile.on('close', async () => {
          this.logger.debug('Build copied from cache.');
          try {
            await Promise.all(promises);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
        zipFile.readEntry();
        zipFile.on('entry', (entry) => {
          promises[promises.length] = this._processZipEntry(zipFile, entry, destination)
          .catch((cause) => {
            this.logger.warn(cause);
            throw cause;
          });
        });
      });
    });
  }

  /**
   * Copies a file to the destination file.
   * @param {yauzl.ZipFile} zip The source zip file
   * @param {yauzl.Entry} entry A currently iterated entry
   * @param {string} destination Folder where to put the file.
   * @return {Promise<void>}
   */
  async _processZipEntry(zip, entry, destination) {
    if (/\/$/.test(entry.fileName)) {
      zip.readEntry();
      return;
    }
    const dir = path.join(destination, path.dirname(entry.fileName));
    await fs.ensureDir(dir);
    await this._copyZipEntry(zip, entry, destination);
    zip.readEntry();
  }

  /**
   * Copies entry of a zip file to the destination.
   * @param {yauzl.ZipFile} zip The source zip file
   * @param {yauzl.Entry} entry A currently iterated entry
   * @param {string} destination Folder where to put the file.
   * @return {Promise<void>}
   */
  _copyZipEntry(zip, entry, destination) {
    return new Promise((resolve, reject) => {
      zip.openReadStream(entry, (err, readStream) => {
        if (err) {
          reject(err);
          return;
        }
        const dest = path.join(destination, entry.fileName);
        const writeStream = fs.createWriteStream(dest);
        writeStream.on('close', () => {
          resolve();
        });
        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Caches build files.
   * @param {string} sources Location of generated build files.
   * @return {Promise<void>} Resolved when file is created
   */
  async cacheBuild(sources) {
    if (this.opts.noCache) {
      return;
    }
    const { logger, cacheFolder } = this;
    logger.debug(`caching build files to ${cacheFolder}`);
    await fs.ensureDir(cacheFolder);
    await this._createPackage(sources);
  }

  /**
   * Creates a build cache file.
   * @param {string} sources Location of generated build files.
   * @return {Promise<void>} Resolved when file is created
   */
  _createPackage(sources) {
    return new Promise((resolve, reject) => {
      const { logger } = this;

      const dest = path.join(this.cacheFolder, `${this.hash}.zip`);
      const output = fs.createWriteStream(dest);
      const archive = archiver('zip', {
        zlib: {
          level: 9,
        },
      });
      output.on('close', () => {
        logger.debug('Cache build saved.');
        logger.debug(`${archive.pointer() } total bytes.`);
        resolve();
      });
      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
          logger.warn(err);
        } else {
          logger.error(err);
          reject(err);
        }
      });
      archive.on('error', (err) => {
        logger.error(err);
        reject(err);
      });
      archive.pipe(output);

      try {
        // eslint-disable-next-line
        const files = fs.readdirSync(sources, {
          withFileTypes: true,
        });
        files.forEach((dirEnt) => {
          const { name } = dirEnt;
          if (dirEnt.isFile()) {
            logger.debug(`Adding ${name} file to the cache...`);
            archive.file(path.join(sources, name), { name });
          } else if (dirEnt.isDirectory()) {
            logger.debug(`Adding ${name} directory to the cache...`);
            archive.directory(path.join(sources, name), name);
          }
        });
      } catch (e) {
        logger.error(e);
        reject(e);
        return;
      }
      archive.finalize();
    });
  }
}
