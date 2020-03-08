'use strict';
const EventEmitter = require('events');
const { ConnectionPool } = require('../../../lib/cmap/connection_pool');
const { format: f } = require('util');
const bson = require('bson');
const { Query } = require('../../../lib/cmap/commands');
const ReadPreference = require('../../../lib/read_preference');

function executeCommand(configuration, db, cmd, options, cb) {
  // Optional options
  if (typeof options === 'function') (cb = options), (options = {});
  // Set the default options object if none passed in
  options = options || {};

  // Alternative options
  var host = options.host || configuration.host;
  var port = options.port || configuration.port;

  // Attempt to connect
  var pool = new ConnectionPool(null, {
    host: host,
    port: port,
    bson: new bson()
  });

  // Add event listeners
  pool.on('connect', function(_pool) {
    var query = new Query(new bson(), f('%s.$cmd', db), cmd, {
      numberToSkip: 0,
      numberToReturn: 1
    });

    _pool.write(
      query,
      {
        command: true
      },
      function(err, result) {
        if (err) console.log(err.stack);
        // Close the pool
        _pool.destroy();
        // If we have an error return
        if (err) return cb(err);
        // Return the result
        cb(null, result.result);
      }
    );
  });

  pool.connect(options.credentials);
}

function locateAuthMethod(configuration, cb) {
  var ConnectionPool = require('../../../lib/cmap/connection_pool'),
    bson = require('bson'),
    f = require('util').format,
    { Query } = require('../../../lib/cmap/commands');

  // Set up operations
  var db = 'admin';
  var cmd = { ismaster: true };

  // Attempt to connect
  var pool = new ConnectionPool(null, {
    host: configuration.host,
    port: configuration.port,
    bson: new bson()
  });

  // Add event listeners
  pool.on('connect', function(_pool) {
    var query = new Query(new bson(), f('%s.$cmd', db), cmd, {
      numberToSkip: 0,
      numberToReturn: 1
    });
    _pool.write(
      query,
      {
        command: true
      },
      function(err, result) {
        if (err) console.log(err.stack);
        // Close the pool
        _pool.destroy();
        // If we have an error return
        if (err) return cb(err);

        // Establish the type of auth method
        if (!result.result.maxWireVersion || result.result.maxWireVersion === 2) {
          cb(null, 'mongocr');
        } else {
          cb(null, 'scram-sha-1');
        }
      }
    );
  });

  pool.connect.apply(pool);
}

const delay = function(timeout) {
  return new Promise(function(resolve) {
    setTimeout(function() {
      resolve();
    }, timeout);
  });
};

class ConnectionSpy extends EventEmitter {
  constructor() {
    super();
    this.connections = {};
  }

  addConnection(id, connection) {
    // console.log(`=== added connection ${id} :: ${connection.port}`);

    this.connections[id] = connection;
    this.emit('connectionAdded');
  }

  deleteConnection(id) {
    // console.log(
    //   `=== deleted connection ${id} :: ${this.connections[id] ? this.connections[id].port : ''}`
    // );

    delete this.connections[id];
    this.emit('connectionRemoved');

    if (this.connectionCount() === 0) {
      this.emit('drained');
    }
  }

  connectionCount() {
    return Object.keys(this.connections).length;
  }
}

/**
 * Prepares a database for testing, dropping all databases
 *
 * @param {Configuration} configuration The test configuration
 * @param {String[]} [dbsToClean] The databases to clean
 */
function setupDatabase(configuration, dbsToClean) {
  return new Promise((resolve, reject) => {
    dbsToClean = Array.isArray(dbsToClean) ? dbsToClean : [];
    const configDbName = configuration.db;

    const topology = configuration.newTopology();
    dbsToClean.push(configDbName);
    topology.on('connect', function() {
      let cleanedCount = 0;
      const dropHandler = err => {
        if (err) return reject(err);
        cleanedCount++;
        if (cleanedCount === dbsToClean.length) {
          topology.destroy(resolve);
        }
      };

      dbsToClean.forEach(dbName => {
        topology.command(
          `${dbName}.$cmd`,
          { dropDatabase: 1 },
          { readPreference: ReadPreference.primary },
          dropHandler
        );
      });
    });

    topology.connect();
  });
}

module.exports = {
  executeCommand,
  locateAuthMethod,
  delay,
  ConnectionSpy,
  setupDatabase
};
