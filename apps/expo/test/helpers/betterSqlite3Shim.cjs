/**
 * Test-only stand-in for `better-sqlite3`, built on Node's bundled `node:sqlite`.
 *
 * WatermelonDB's Node SQLite driver (adapters/sqlite/sqlite-node) is the same
 * SQLiteAdapter the app runs on iOS/Android, except the final "run this SQL"
 * hop goes to better-sqlite3 instead of the native module. The SQL itself —
 * CREATE TABLE/INDEX from encodeSchema, ALTER TABLE from encodeMigrationSteps,
 * INSERT/UPDATE/DELETE from encodeBatch, SELECT from encodeQuery — is generated
 * by the shared JS and is byte-for-byte what native SQLite executes. Running it
 * against a real SQLite engine is what catches a migration that Loki (which has
 * no column types) would accept.
 *
 * Only the surface sqlite-node/Database.js touches is implemented. Using
 * node:sqlite avoids adding a native-compiled devDependency to the app; the
 * worker tests already rely on it.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');

class Statement {
  constructor(stmt) {
    this._stmt = stmt;
  }
  run(args = []) {
    return this._stmt.run(...args);
  }
  all(args = []) {
    return this._stmt.all(...args);
  }
  get(args = []) {
    return this._stmt.get(...args);
  }
}

class Database {
  constructor(path) {
    this.memory = path === ':memory:';
    this._db = new DatabaseSync(path);
    this.open = true;
  }
  prepare(sql) {
    return new Statement(this._db.prepare(sql));
  }
  exec(sql) {
    this._db.exec(sql);
    return this;
  }
  transaction(fn) {
    return (...args) => {
      this._db.exec('BEGIN');
      try {
        const out = fn(...args);
        this._db.exec('COMMIT');
        return out;
      } catch (e) {
        this._db.exec('ROLLBACK');
        throw e;
      }
    };
  }
  pragma(source, options = {}) {
    const rows = this._db.prepare(`PRAGMA ${source}`).all();
    if (options.simple) {
      const first = rows[0];
      return first ? Object.values(first)[0] : undefined;
    }
    return rows;
  }
  close() {
    this._db.close();
    this.open = false;
  }
}

module.exports = Database;
module.exports.default = Database;
