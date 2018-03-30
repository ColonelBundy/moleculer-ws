import { expect, assert, should } from 'chai';
import { Packet, PacketType, WSGateway } from '../../src/index';
import path = require('path');
import Gateway = require('../services/gateway.service');
import { ServiceBroker, Context, Service } from 'moleculer';
import ws = require('ws');
import { Client } from 'moleculer-ws-client';

describe('Gateway', function() {
  this.timeout(10000);
  let broker: ServiceBroker, service: Service, client: Client;
  const payload = { foo: 'bar' };

  before(function(done) {
    broker = new ServiceBroker(); //{ logger: console, logLevel: 'debug' }
    service = broker.createService(<any>Gateway);

    broker.start();
    client = new Client('localhost:3000');
    client.on('connected', () => {
      done();
    });
  });

  after(function(done) {
    broker.stop();
    done();
  });

  describe('Actions', function() {
    it('Can call action', function(done) {
      client
        .call('test', 'Gateway.EchoParams', payload)
        .then(data => {
          done();
        })
        .catch(e => done(e));
    });

    it('Can emit action', function(done) {
      client.emit('test', 'Gateway.EmitAction', payload);
      client.on('EmitAction', data => {
        done();
      });
    });
  });

  describe('Events', function() {
    it('Can call event', function(done) {
      client
        .callEvent('CallEvent', payload)
        .then(data => {
          done();
        })
        .catch(e => done(e));
    });

    it('Can emit event', function(done) {
      client.emitEvent('EmitEvent', payload);
      client.on('EmitEvent', data => {
        done();
      });
    });
  });
});
