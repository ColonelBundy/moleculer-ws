import { expect, assert, should } from 'chai';
import { Packet, PacketType } from '../../src/index';
import path = require('path');
import Gateway = require('../services/gateway.service');
import { ServiceBroker, Context, Service } from 'moleculer';
import ws = require('ws');

function Setup() {
  const broker = new ServiceBroker /**{logger: console, logLevel: 'debug'} **/();
  const service = broker.createService(<any>Gateway);

  return [broker, service];
}

describe('Gateway', function() {
  let broker, service, server: ws;

  before(() => {
    [broker, service] = Setup();
  });

  describe('Actions', function() {
    beforeEach(() => {
      server = new ws('ws://localhost:3000');
    });
  });
});
