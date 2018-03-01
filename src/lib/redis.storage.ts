import { storage, Client } from './base.storage';
import bluebird = require('bluebird');
import redisClient = require('ioredis');
import { GenericObject } from 'moleculer';
import _ = require('lodash');

export default class Redis implements storage {
  private client: redisClient.Redis

  constructor(opts: redisClient.RedisOptions) {
    this.client = new redisClient(opts);
  }

  /**
   * Get client(s)
   * 
   * @param {string} [id] 
   * @returns {bluebird<Client[]>} 
   * @memberof Redis
   */
  public Get(id?: string) : bluebird<Client[]> {
    return new bluebird.Promise((resolve, reject) => {
      if (id) {
        this.client.hget('clients', id).then(value => resolve(JSON.parse(value))).catch(reject);
      }
      this.client.hgetall('clients').then(value => resolve(JSON.parse(value))).catch(reject);
    });
  }

  /**
   * Set client(s)
   * 
   * @param {(string | Client[])} id 
   * @param {GenericObject} [props] 
   * @returns {bluebird<any>} 
   * @memberof Redis
   */
  public Set(id: string | Client[], props?: GenericObject) : bluebird<any> {
    return new bluebird.Promise((resolve, reject) => {
      if (_.isArray(id)) {
        const transaction = this.client.multi();
        id.map(c => transaction.hset('clients', c.id, JSON.stringify(c.props)));
        return transaction.exec();
      } else {
        return this.client.hset('clients', id, JSON.stringify(props))
      }
    });
  }

  /**
   * Remove a client
   * 
   * @param {string} id 
   * @returns {bluebird<any>} 
   * @memberof Redis
   */
  public remove(id: string) : bluebird<any> {
    return new bluebird.Promise((resolve, reject) => {
      return this.client.hdel('clients', id);
    });
  }

  /**
   * Purge hash list
   * 
   * @returns {bluebird<any>} 
   * @memberof Redis
   */
  public Purge() : bluebird<any> {
    return new bluebird.Promise((resolve, reject) => {
      return this.client.hdel('clients');
    });
  }
}