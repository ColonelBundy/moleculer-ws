import { expect, assert, should } from 'chai';
import { Packet, PacketType } from '../../src/index';
import path = require('path');
import Gateway = require('../services/gateway.service');
import { ServiceBroker, Context, Service } from 'moleculer';
import ws = require('ws');

function Setup() {
  const broker = new ServiceBroker(/**{logger: console, logLevel: 'debug'} **/);
  const service = broker.createService(<any>Gateway);

  return [
    broker,
    service
  ]
}

describe('Gateway', function() {
  let broker, service, server: ws;

  before(() => {
    [ broker, service ] = Setup();
  });

  describe('Actions', function() {
    beforeEach(() => {
      server = new ws('ws://localhost:3000');
    })

    describe('Internal', () => {
      it('Should echo back packet', (done) => {
        const client = server;
        
        let response = false;
        const packet: Packet = {
          type: PacketType.INTERNAL,
          name: 'Gateway',
          action: 'EchoParams',
          data: {
            one: '1',
            two: '2'
          }
        };

        client.once('open', () => {
          client.emit('message', JSON.stringify(packet))
        });

        client.once('close', () => {
          assert.ok(response);
          done();
        });

        client.once('message', (data) => {
          assert.deepEqual(packet, JSON.parse(data.toString()));
          response = true;
          client.close();
        });
      });
    })
    
    describe('Custom', () => {
      it('Should respond #1', (done) => {
        const client = server;
        
        let response = false;
        const packet: Packet = {
          type: PacketType.CUSTOM,
          name: 'Gateway',
          action: 'test.respond',
          data: {
            one: '1',
            two: '2'
          },
          ack: 5
        };

        client.once('open', () => {
          client.emit('message', JSON.stringify(packet))
        });

        client.once('close', () => {
          assert.ok(response);
          done();
        });

        client.once('message', (data) => {
          assert.deepEqual(packet, JSON.parse(data.toString()));
          response = true;
          client.close();
        });
      });

      it('Should respond #2', (done) => {
        const client = server;
        
        let response = false;
        const packet: Packet = {
          type: PacketType.CUSTOM,
          name: 'Gateway',
          action: 'test.respond.emit',
          data: {
            one: '1',
            two: '2'
          },
          ack: 5
        };

        client.once('open', () => {
          client.emit('message', JSON.stringify(packet))
        });

        client.once('close', () => {
          assert.ok(response);
          done();
        });

        client.once('message', (data) => {
          assert.deepEqual(packet, JSON.parse(data.toString()));
          response = true;
          client.close();
        });
      });

      it('Should respond #3', (done) => {
        const client = server;
        
        let response = false;
        const packet: Packet = {
          type: PacketType.CUSTOM,
          name: 'Gateway',
          action: 'test.respond.send',
          data: {
            one: '1',
            two: '2'
          },
          ack: 5
        };

        client.once('open', () => {
          client.emit('message', JSON.stringify(packet))
        });

        client.once('close', () => {
          assert.ok(response);
          done();
        });

        client.once('message', (data) => {
          assert.deepEqual(packet, JSON.parse(data.toString()));
          response = true;
          client.close();
        });
      });
    })
  });
});
