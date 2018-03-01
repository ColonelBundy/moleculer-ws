import moleculer = require('moleculer');
import bluebird = require('bluebird');

export interface Client {
  id: string,
  props: moleculer.GenericObject
}

export interface storage {
  Get(id?: string): bluebird<Client[]>, // Get clients
  Set(id: string, props: moleculer.GenericObject): bluebird<any>, // Set client
  Set(clients: Client[]): bluebird<any>, // Set clients
  remove(id: string): bluebird<any>,
  Purge(): bluebird<any>
}