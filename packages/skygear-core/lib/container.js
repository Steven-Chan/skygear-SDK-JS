/**
 * Copyright 2015 Oursky Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* eslint camelcase: 0 */
const request = require('superagent');
const _ = require('lodash');
const ee = require('event-emitter');

import Asset from './asset';
import User from './user';
import Role from './role';
import ACL from './acl';
import Record from './record';
import Reference from './reference';
import Query from './query';
import Database from './database';
import Pubsub from './pubsub';
import {RelationAction} from './relation';
import Geolocation from './geolocation';
import getStore from './store';
import {Sequence} from './type';
import {ErrorCodes, SkygearError} from './error';
import {EventHandle} from './util';

export const USER_CHANGED = 'userChanged';

export default class Container {

  constructor() {
    this.url = '/* @echo API_URL */';
    this.apiKey = null;
    this.token = null;
    this._accessToken = null;
    this._user = null;
    this._deviceID = null;
    this._getAccessToken();
    this._getDeviceID();
    this._privateDB = null;
    this._publicDB = null;
    this.request = request;
    this._internalPubsub = new Pubsub(this, true);
    this._relation = new RelationAction(this);
    this._pubsub = new Pubsub(this, false);
    this.autoPubsub = true;
    this._cacheResponse = true;
    this.ee = ee({});
    /**
     * Options for how much time to wait for client request to complete.
     *
     * @type {Object}
     * @property {number} [timeoutOptions.deadline] - deadline for the request
     * and response to complete (in milliseconds)
     * @property {number} [timeoutOptions.response=60000] - maximum time to
     * wait for an response (in milliseconds)
     *
     * @see http://visionmedia.github.io/superagent/#timeouts
     */
    this.timeoutOptions = {
      response: 60000
    };
  }

  config(options) {
    if (options.apiKey) {
      this.apiKey = options.apiKey;
    }
    if (options.endPoint) {
      this.endPoint = options.endPoint;
    }

    let promises = [
      this._getUser(),
      this._getAccessToken(),
      this._getDeviceID()
    ];
    return Promise.all(promises).then(()=> {
      this.reconfigurePubsubIfNeeded();
      return this;
    }, ()=> {
      return this;
    });
  }

  configApiKey(ApiKey) {
    this.apiKey = ApiKey;
  }

  clearCache() {
    return this.store.clearPurgeableItems();
  }

  onUserChanged(listener) {
    this.ee.on(USER_CHANGED, listener);
    return new EventHandle(this.ee, USER_CHANGED, listener);
  }

  signupWithUsername(username, password) {
    return this._signup(username, null, password);
  }

  signupWithEmail(email, password) {
    return this._signup(null, email, password);
  }

  signupWithUsernameAndProfile(username, password, profile = {}) {
    return this.signupWithUsername(username, password)
    .then((user)=>
      this._createProfile(user, profile)
    );
  }

  signupWithEmailAndProfile(email, password, profile = {}) {
    return this.signupWithEmail(email, password)
    .then((user)=>
      this._createProfile(user, profile)
    );
  }

  signupAnonymously() {
    return this._signup(null, null, null);
  }

  _signup(username, email, password) {
    return this.makeRequest('auth:signup', {
      username: username,
      email: email,
      password: password
    }).then(this._authResolve.bind(this));
  }

  _createProfile(user, profile) {
    let record = new this.UserRecord({
      _id: 'user/' + user.id,
      ...profile
    });
    return this.publicDB.save(record);
  }

  _authResolve(body) {
    return Promise.all([
      this._setUser(body.result),
      this._setAccessToken(body.result.access_token)
    ]).then(()=> {
      this.reconfigurePubsubIfNeeded();
      return this.currentUser;
    });
  }

  loginWithUsername(username, password) {
    return this.makeRequest('auth:login', {
      username: username,
      password: password
    }).then(this._authResolve.bind(this));
  }

  loginWithEmail(email, password) {
    return this.makeRequest('auth:login', {
      email: email,
      password: password
    }).then(this._authResolve.bind(this));
  }

  loginWithProvider(provider, authData) {
    return this.makeRequest('auth:login', {
      provider: provider,
      auth_data: authData
    }).then(this._authResolve.bind(this));
  }

  logout() {
    return this.unregisterDevice()
    .then(()=> {
      this.clearCache();
      return this.makeRequest('auth:logout', {});
    }, (error)=> {
      if (error.code === ErrorCodes.InvalidArgument &&
          error.message === 'Missing device id'
      ) {
        this.clearCache();
        return this.makeRequest('auth:logout', {});
      }
      return Promise.reject(error);
    })
    .then(()=> {
      return Promise.all([
        this._setAccessToken(null),
        this._setUser(null)
      ]).then(()=> null);
    }, (err)=> {
      return this._setAccessToken(null).then(()=> {
        return Promise.reject(err);
      });
    });
  }

  whoami() {
    return this.makeRequest('me', {})
    .then(this._authResolve.bind(this));
  }

  changePassword(oldPassword, newPassword, invalidate = false) {
    if (invalidate) {
      throw Error('Invalidate is not yet implemented');
    }
    return this.makeRequest('auth:password', {
      old_password: oldPassword,
      password: newPassword
    })
    .then(this._authResolve.bind(this));
  }

  saveUser(user) {
    const payload = {
      _id: user.id,     // eslint-disable-line camelcase
      email: user.email,
      username: user.username
    };
    if (user.roles) {
      payload.roles = _.map(user.roles, function (perRole) {
        return perRole.name;
      });
    }
    return this.makeRequest('user:update', payload).then((body)=> {
      const newUser = this.User.fromJSON(body.result);
      const currentUser = this.currentUser;

      if (newUser && currentUser && newUser.id === currentUser.id) {
        return this._setUser(body.result);
      } else {
        return newUser;
      }
    });
  }

  _getUsersBy(emails, usernames) {
    return this.makeRequest('user:query', {
      emails: emails,
      usernames: usernames
    }).then((body)=> {
      return body.result.map(r => new this.User(r.data));
    });
  }

  getUsersByEmail(emails) {
    return this._getUsersBy(emails, null);
  }

  getUsersByUsername(usernames) {
    return this._getUsersBy(null, usernames);
  }

  discoverUserByEmails(emails) {
    return this.publicDB.query(
      new Query(this.UserRecord).havingEmails(emails)
    );
  }

  discoverUserByUsernames(usernames) {
    return this.publicDB.query(
      new Query(this.UserRecord).havingUsernames(usernames)
    );
  }

  setAdminRole(roles) {
    let roleNames = _.map(roles, function (perRole) {
      return perRole.name;
    });

    return this.makeRequest('role:admin', {
      roles: roleNames
    }).then((body)=> body.result);
  }

  setDefaultRole(roles) {
    let roleNames = _.map(roles, function (perRole) {
      return perRole.name;
    });

    return this.makeRequest('role:default', {
      roles: roleNames
    }).then((body)=> body.result);
  }

  get defaultACL() {
    return this.Record.defaultACL;
  }

  setDefaultACL(acl) {
    this.Record.defaultACL = acl;
  }

  setRecordCreateAccess(recordClass, roles) {
    let roleNames = _.map(roles, function (perRole) {
      return perRole.name;
    });

    return this.makeRequest('schema:access', {
      type: recordClass.recordType,
      create_roles: roleNames
    }).then((body)=> body.result);
  }

  setRecordDefaultAccess(recordClass, acl) {
    return this.makeRequest('schema:default_access', {
      type: recordClass.recordType,
      default_access: acl.toJSON()
    }).then((body)=> body.result);
  }

  inferDeviceType() {
    // To be implmented by subclass
    // TODO: probably web / node, handle it later
    throw new Error('Failed to infer type, please supply a value');
  }

  /**
   * You can register your device for receiving push notifications.
   *
   * @param {string} token - The device token
   * @param {string} type - The device type (either 'ios' or 'android')
   * @param {string} topic - The device topic, refer to application bundle
   * identifier on iOS and application package name on Android.
   **/
  registerDevice(token, type, topic) {
    if (!token) {
      throw new Error('Token cannot be empty');
    }
    if (!type) {
      type = this.inferDeviceType();
    }

    let deviceID;
    if (this.deviceID) {
      deviceID = this.deviceID;
    }

    return this.makeRequest('device:register', {
      type: type,
      id: deviceID,
      topic: topic,
      device_token: token
    }).then((body)=> {
      return this._setDeviceID(body.result.id);
    }, (error)=> {
      // Will set the deviceID to null and try again iff deviceID is not null.
      // The deviceID can be deleted remotely, by apns feedback.
      // If the current deviceID is already null, will regards as server fail.
      let errorCode = null;
      if (error.error) {
        errorCode = error.error.code;
      }
      if (this.deviceID && errorCode === ErrorCodes.ResourceNotFound) {
        return this._setDeviceID(null).then(()=> {
          return this.registerDevice(token, type);
        });
      } else {
        return Promise.reject(error);
      }
    });
  }

  unregisterDevice() {
    if (!this.deviceID) {
      return Promise.reject(
        new SkygearError('Missing device id', ErrorCodes.InvalidArgument)
      );
    }

    return this.makeRequest('device:unregister', {
      id: this.deviceID
    }).then(()=> {
      // do nothing
      return;
    }, (error)=> {
      let errorCode = null;
      if (error.error) {
        errorCode = error.error.code;
      }
      if (errorCode === ErrorCodes.ResourceNotFound) {
        // regard it as success
        return this._setDeviceID(null);
      } else {
        return Promise.reject(error);
      }
    });
  }

  lambda(name, data) {
    return this.makeRequest(name, {
      args: data
    }).then((resp)=> resp.result);
  }

  makeUploadAssetRequest(asset) {
    return new Promise((resolve, reject)=> {
      this.makeRequest('asset:put', {
        filename: asset.name,
        'content-type': asset.contentType,
        'content-size': asset.file.size
      })
      .then((res)=> {
        const newAsset = Asset.fromJSON(res.result.asset);
        const postRequest = res.result['post-request'];

        let postUrl = postRequest.action;
        if (postUrl.indexOf('/') === 0) {
          postUrl = postUrl.substring(1);
        }
        if (postUrl.indexOf('http') !== 0) {
          postUrl = this.url + postUrl;
        }

        let _request = this.request
          .post(postUrl)
          .set('X-Skygear-API-Key', this.apiKey);
        if (postRequest['extra-fields']) {
          _.forEach(postRequest['extra-fields'], (value, key)=> {
            _request = _request.field(key, value);
          });
        }

        _request.attach('file', asset.file).end((err)=> {
          if (err) {
            reject(err);
            return;
          }

          resolve(newAsset);
        });
      }, (err)=> {
        reject(err);
      });
    });
  }

  sendRequestObject(action, data) {
    if (this.apiKey === null) {
      throw Error('Please config ApiKey');
    }
    let _data = _.assign({
      action: action,
      api_key: this.apiKey,
      access_token: this.accessToken
    }, data);
    let _action = action.replace(/:/g, '/');
    let req = this.request
      .post(this.url + _action)
      .set('X-Skygear-API-Key', this.apiKey)
      .set('X-Skygear-Access-Token', this.accessToken)
      .set('Accept', 'application/json');
    if (this.timeoutOptions !== undefined && this.timeoutOptions !== null) {
      req = req.timeout(this.timeoutOptions);
    }
    return req.send(_data);
  }

  makeRequest(action, data) {
    let _request = this.sendRequestObject(action, data);
    return new Promise((resolve, reject)=> {
      _request.end((err, res)=> {
        // Do an application JSON parse because in some condition, the
        // content-type header will got strip and it will not deserial
        // the json for us.
        let body = getRespJSON(res);

        if (err) {
          let skyErr = body.error || err;
          if (skyErr.code === this.ErrorCodes.AccessTokenNotAccepted) {
            return Promise.all([
              this._setAccessToken(null),
              this._setUser(null)
            ]).then(function () {
              reject({
                status: err.status,
                error: skyErr
              });
            });
          }
          reject({
            status: err.status,
            error: skyErr
          });
        } else {
          resolve(body);
        }
      });
    });
  }

  get Query() {
    return Query;
  }

  get User() {
    return User;
  }

  get Role() {
    return Role;
  }

  get ACL() {
    return ACL;
  }

  get Record() {
    return Record;
  }

  get UserRecord() {
    return Record.extend('user');
  }

  get Sequence() {
    return Sequence;
  }

  get Asset() {
    return Asset;
  }

  get Reference() {
    return Reference;
  }

  get Geolocation() {
    return Geolocation;
  }

  get ErrorCodes() {
    return ErrorCodes;
  }

  get currentUser() {
    return this._user;
  }

  get cacheResponse() {
    return this._cacheResponse;
  }

  set cacheResponse(value) {
    const b = !!value;
    this._cacheResponse = b;
    if (this._publicDB) {
      this._publicDB.cacheResponse = b;
    }
    if (this._privateDB) {
      this._privateDB.cacheResponse = b;
    }
  }

  _getUser() {
    return this.store.getItem('skygear-user').then((userJSON)=> {
      let attrs = JSON.parse(userJSON);
      this._user = this.User.fromJSON(attrs);
    }, (err)=> {
      console.warn('Failed to get user', err);
      this._user = null;
      return null;
    });
  }

  _setUser(attrs) {
    let value;
    if (attrs !== null) {
      this._user = new this.User(attrs);
      value = JSON.stringify(this._user.toJSON());
    } else {
      this._user = null;
      value = null;
    }

    const setItem = value === null ? this.store.removeItem('skygear-user')
        : this.store.setItem('skygear-user', value);
    return setItem.then(()=> {
      this.ee.emit(USER_CHANGED, this._user);
      return value;
    }, (err)=> {
      console.warn('Failed to persist user', err);
      return value;
    });
  }

  get accessToken() {
    return this._accessToken;
  }

  _getAccessToken() {
    return this.store.getItem('skygear-accesstoken').then((token)=> {
      this._accessToken = token;
      return token;
    }, (err)=> {
      console.warn('Failed to get access', err);
      this._accessToken = null;
      return null;
    });
  }

  _setAccessToken(value) {
    this._accessToken = value;
    const setItem = value === null
        ? this.store.removeItem('skygear-accesstoken')
        : this.store.setItem('skygear-accesstoken', value);
    return setItem.then(()=> {
      return value;
    }, (err)=> {
      console.warn('Failed to persist accesstoken', err);
      return value;
    });
  }

  get deviceID() {
    return this._deviceID;
  }

  _getDeviceID() {
    return this.store.getItem('skygear-deviceid').then((deviceID)=> {
      this._deviceID = deviceID;
      return deviceID;
    }, (err)=> {
      console.warn('Failed to get deviceid', err);
      this._deviceID = null;
      return null;
    });
  }

  _setDeviceID(value) {
    this._deviceID = value;
    const setItem = value === null ? this.store.removeItem('skygear-deviceid')
        : this.store.setItem('skygear-deviceid', value);
    return setItem.then(()=> {
      return value;
    }, (err)=> {
      console.warn('Failed to persist deviceid', err);
      return value;
    }).then((deviceID)=> {
      this.reconfigurePubsubIfNeeded();
      return deviceID;
    });
  }

  get endPoint() {
    return this.url;
  }

  set endPoint(newEndPoint) {
    // TODO: Check the format
    if (newEndPoint) {
      if (!_.endsWith(newEndPoint, '/')) {
        newEndPoint = newEndPoint + '/';
      }
      this.url = newEndPoint;
    }
  }

  get store() {
    if (!this._store) {
      this._store = getStore();
    }
    return this._store;
  }

  get publicDB() {
    if (this._publicDB === null) {
      this._publicDB = new Database('_public', this);
      this._publicDB.cacheResponse = this._cacheResponse;
    }
    return this._publicDB;
  }

  get privateDB() {
    if (this.accessToken === null) {
      throw new Error('You must login before access to privateDB');
    }
    if (this._privateDB === null) {
      this._privateDB = new Database('_private', this);
      this._privateDB.cacheResponse = this._cacheResponse;
    }
    return this._privateDB;
  }

  get Database() {
    return Database;
  }

  get relation() {
    return this._relation;
  }

  get pubsub() {
    return this._pubsub;
  }

  reconfigurePubsubIfNeeded() {
    if (!this.autoPubsub) {
      return;
    }

    this._internalPubsub.reset();
    if (this.deviceID !== null) {
      this._internalPubsub.subscribe('_sub_' + this.deviceID, function (data) {
        console.log('Receivied data for subscription: ' + data);
      });
    }
    this._internalPubsub.reconfigure();
    this._pubsub.reconfigure();
  }

  /**
   * Subscribe a function callback on receiving message at the specified
   * channel.
   *
   * @param {string} channel - Name of the channel to subscribe
   * @param {function(object:*)} callback - function to be trigger with
   * incoming data.
   **/
  on(channel, callback) {
    return this.pubsub.on(channel, callback);
  }

  /**
   * Unsubscribe a function callback on the specified channel.
   *
   * If pass in `callback` is null, all callbacks in the specified channel
   * will be removed.
   *
   * @param {string} channel - Name of the channel to unsubscribe
   * @param {function(object:*)=} callback - function to be trigger with
   * incoming data.
   **/
  off(channel, callback = null) {
    this.pubsub.off(channel, callback);
  }
}

function getRespJSON(res) {
  if (res && res.body) {
    return res.body;
  }
  if (res && res.text) {
    try {
      return JSON.parse(res.text);
    } catch (err) {
      console.log('getRespJSON error. error: ', err);
    }
  }

  return {};
}
