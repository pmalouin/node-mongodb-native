'use strict';

import { RunCommandOnConnection } from "../../../interfaces/run_command_on_connection";
import { ConnectionInterface } from "../../../interfaces/connection";
import { MongoCredentials } from "./mongo_credentials";
import { DriverCallback } from "../../../interfaces/driver_callback";
import { Buffer as SafeBuffer } from 'safe-buffer';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'crypto';
import { retrieveBSON } from '../connection/utils';
import { MongoError } from '../error';
import { AuthProvider } from './auth_provider';
import { BSON as BSONType } from 'bson';

const BSON = retrieveBSON();
const Binary = BSON.Binary;

let saslprep: (x: string) => string;
try {
  saslprep = require('saslprep');
} catch (e) {
  // don't do anything;
}

var parsePayload = function(payload: string) {
  var dict: Record<string, string> = {};
  var parts = payload.split(',');

  for (var i = 0; i < parts.length; i++) {
    var valueParts = parts[i].split('=');
    dict[valueParts[0]] = valueParts[1];
  }

  return dict;
};

var passwordDigest = function(username: string, password: string) {
  if (typeof username !== 'string') throw new MongoError('username must be a string');
  if (typeof password !== 'string') throw new MongoError('password must be a string');
  if (password.length === 0) throw new MongoError('password cannot be empty');
  // Use node md5 generator
  var md5 = createHash('md5');
  // Generate keys used for authentication
  md5.update(username + ':mongo:' + password, 'utf8');
  return md5.digest('hex');
};

// XOR two buffers
function xor(a: Buffer, b: Buffer) {
  if (!SafeBuffer.isBuffer(a)) a = SafeBuffer.from(a) as unknown as Buffer;
  if (!SafeBuffer.isBuffer(b)) b = SafeBuffer.from(b) as unknown as Buffer;
  const length = Math.max(a.length, b.length);
  const res = [];

  for (let i = 0; i < length; i += 1) {
    res.push(a[i] ^ b[i]);
  }

  return SafeBuffer.from(res).toString('base64') as unknown as Buffer;
}

function H(method: string, text: Buffer) {
  return createHash(method)
    .update(text)
    .digest();
}

function HMAC(method: string, key: Buffer, text: string) {
  return createHmac(method, key)
    .update(text)
    .digest();
}

var _hiCache: Record<string, Buffer> = {};
var _hiCacheCount = 0;
var _hiCachePurge = function() {
  _hiCache = {};
  _hiCacheCount = 0;
};

const hiLengthMap = {
  sha256: 32,
  sha1: 20
};

function HI(data: string, salt: Buffer, iterations: number, cryptoMethod: 'sha1'|'sha256') {
  // omit the work if already generated
  const key = [data, salt.toString('base64'), iterations].join('_');
  if (_hiCache[key] !== undefined) {
    return _hiCache[key];
  }

  // generate the salt
  const saltedData = pbkdf2Sync(
    data,
    salt,
    iterations,
    hiLengthMap[cryptoMethod],
    cryptoMethod
  );

  // cache a copy to speed up the next lookup, but prevent unbounded cache growth
  if (_hiCacheCount >= 200) {
    _hiCachePurge();
  }

  _hiCache[key] = saltedData;
  _hiCacheCount += 1;
  return saltedData;
}

/**
 * Creates a new ScramSHA authentication mechanism
 * @class
 * @extends AuthProvider
 */
class ScramSHA extends AuthProvider {
  cryptoMethod: 'sha1'|'sha256';
  constructor(bson: BSONType, cryptoMethod: 'sha1'|'sha256') {
    super(bson);
    this.cryptoMethod = cryptoMethod || 'sha1';
  }

  static _getError(err: Error, r: any) {
    if (err) {
      return err;
    }

    if (r.$err || r.errmsg) {
      return new MongoError(r);
    }
  }

  /**
   * @ignore
   */
  _executeScram(
    sendAuthCommand: RunCommandOnConnection,
    connection: ConnectionInterface,
    credentials: MongoCredentials,
    nonce: string,
    callback: DriverCallback
  ) {
    let username = credentials.username;
    const password = credentials.password as string;
    const db = credentials.source;

    const cryptoMethod = this.cryptoMethod;
    let mechanism = 'SCRAM-SHA-1';
    let processedPassword: string;

    if (cryptoMethod === 'sha256') {
      mechanism = 'SCRAM-SHA-256';

      processedPassword = saslprep ? saslprep(password) : password;
    } else {
      try {
        processedPassword = passwordDigest(username, password);
      } catch (e) {
        return callback(e);
      }
    }

    // Clean up the user
    username = username.replace('=', '=3D').replace(',', '=2C');

    // NOTE: This is done b/c Javascript uses UTF-16, but the server is hashing in UTF-8.
    // Since the username is not sasl-prep-d, we need to do this here.
    const firstBare = SafeBuffer.concat([
      SafeBuffer.from('n=', 'utf8'),
      SafeBuffer.from(username, 'utf8'),
      SafeBuffer.from(',r=', 'utf8'),
      SafeBuffer.from(nonce, 'utf8')
    ]);

    // Build command structure
    const saslStartCmd = {
      saslStart: 1,
      mechanism,
      payload: new Binary(SafeBuffer.concat([SafeBuffer.from('n,,', 'utf8'), firstBare]) as unknown as Buffer),
      autoAuthorize: 1
    };

    // Write the commmand on the connection
    sendAuthCommand(connection, `${db}.$cmd`, saslStartCmd, (err: any, r: any) => {
      let tmpError = ScramSHA._getError(err, r);
      if (tmpError) {
        return callback(tmpError, null);
      }

      const payload = SafeBuffer.isBuffer(r.payload) ? new Binary(r.payload) : r.payload;
      const dict = parsePayload(payload.value());
      const iterations = parseInt(dict.i, 10);
      const salt = dict.s;
      const rnonce = dict.r;

      // Set up start of proof
      const withoutProof = `c=biws,r=${rnonce}`;
      const saltedPassword = HI(
        processedPassword,
        SafeBuffer.from(salt, 'base64') as unknown as Buffer,
        iterations,
        cryptoMethod
      );

      if (iterations && iterations < 4096) {
        const error = new MongoError(`Server returned an invalid iteration count ${iterations}`);
        return callback(error, false as any);
      }

      const clientKey = HMAC(cryptoMethod, saltedPassword, 'Client Key');
      const storedKey = H(cryptoMethod, clientKey);
      const authMessage = [firstBare, payload.value().toString('base64'), withoutProof].join(',');

      const clientSignature = HMAC(cryptoMethod, storedKey, authMessage);
      const clientProof = `p=${xor(clientKey, clientSignature)}`;
      const clientFinal = [withoutProof, clientProof].join(',');
      const saslContinueCmd = {
        saslContinue: 1,
        conversationId: r.conversationId,
        payload: new Binary(SafeBuffer.from(clientFinal) as unknown as Buffer)
      };

      sendAuthCommand(connection, `${db}.$cmd`, saslContinueCmd, ((err: Error|null|undefined, r: any) => {
        if (!r || r.done !== false) {
          return callback(err, r);
        }

        const retrySaslContinueCmd = {
          saslContinue: 1,
          conversationId: r.conversationId,
          payload: SafeBuffer.alloc(0)
        };

        sendAuthCommand(connection, `${db}.$cmd`, retrySaslContinueCmd, callback);
      }));
    });
  }

  /**
   * Implementation of authentication for a single connection
   * @override
   */
  _authenticateSingleConnection(
    sendAuthCommand: RunCommandOnConnection, 
    connection: ConnectionInterface,
    credentials: MongoCredentials,
    callback: DriverCallback
  ) {
    // Create a random nonce
    randomBytes(24, (err, buff) => {
      if (err) {
        return callback(err, null);
      }

      return this._executeScram(
        sendAuthCommand,
        connection,
        credentials,
        buff.toString('base64'),
        callback
      );
    });
  }

  /**
   * Authenticate
   * @override
   * @method
   */
  auth(
    sendAuthCommand: RunCommandOnConnection,
    connections: ConnectionInterface[],
    credentials: MongoCredentials,
    callback: DriverCallback
  ) {
    this._checkSaslprep();
    super.auth(sendAuthCommand, connections, credentials, callback);
  }

  _checkSaslprep() {
    const cryptoMethod = this.cryptoMethod;

    if (cryptoMethod === 'sha256') {
      if (!saslprep) {
        console.warn('Warning: no saslprep library specified. Passwords will not be sanitized');
      }
    }
  }
}

/**
 * Creates a new ScramSHA1 authentication mechanism
 * @class
 * @extends ScramSHA
 */
export class ScramSHA1 extends ScramSHA {
  constructor(bson: BSONType) {
    super(bson, 'sha1');
  }
}

/**
 * Creates a new ScramSHA256 authentication mechanism
 * @class
 * @extends ScramSHA
 */
export class ScramSHA256 extends ScramSHA {
  constructor(bson: BSONType) {
    super(bson, 'sha256');
  }
}