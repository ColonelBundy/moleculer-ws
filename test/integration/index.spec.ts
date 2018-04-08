import { expect, assert, should } from 'chai';
import { Packet, PacketType } from '../../src/index';
import path = require('path');
import Gateway = require('../services/gateway.service');
import { ServiceBroker, Context, Service } from 'moleculer';
import ws = require('ws');
import { Client } from 'moleculer-ws-client/dist';

describe('Gateway', function() {
  this.timeout(10000);
  let broker: ServiceBroker, service: Service, client: Client;
  const payload = { foo: 'bar' };

  before(function(done) {
    broker = new ServiceBroker(); //{ logger: console, logLevel: 'debug' }
    service = broker.createService(<any>Gateway);

    broker.start();
    done();
  });

  after(function(done) {
    broker.stop();
    done();
  });

  describe('Connect', function() {
    it('Can connect', function(done) {
      client = new Client('localhost:3000');
      client.on('connected', () => {
        done();
      });
    });
  });

  describe('Actions', function() {
    it('call action', function(done) {
      client
        .call('test', 'Gateway.EchoParams', payload)
        .then(data => {
          assert.deepEqual(payload, data);
          done();
        })
        .catch(e => done(e));
    });

    it('call action with error', function(done) {
      client.call('test', 'Gateway.ErrorAction', payload).catch(e => {
        assert.equal(e, 'Some error');
        done();
      });
    });

    it('call action with error and onError handler', function(done) {
      client.call('test', 'Gateway.ErrorAction', { onError: true }).catch(e => {
        assert.equal(e, 'success');
        done();
      });
    });

    it('call action not found', function(done) {
      client.call('test', 'Gateway.notfound', payload).catch(e => {
        assert.equal(e, 'Service currently not available');
        done();
      });
    });

    it('emit action', function(done) {
      client.emit('test', 'Gateway.EmitAction', payload);
      client.on('EmitAction', data => {
        assert.deepEqual(payload, data);
        done();
      });
    });
  });

  describe('Events', function() {
    it('call event', function(done) {
      client
        .callEvent('CallEvent', payload)
        .then(data => {
          assert.deepEqual(payload, data);
          done();
        })
        .catch(e => done(e));
    });

    it('call event with error', function(done) {
      client
        .callEvent('CallEventError', payload)
        .then(d => done(d))
        .catch(e => {
          assert.equal('Some error', e);
          done();
        });
    });

    it('emit event', function(done) {
      client.emitEvent('EmitEvent', payload);
      client.on('EmitEvent', data => {
        done();
      });
    });

    it('onBeforeEvent', function(done) {
      client.callEvent('onBeforeEvent', payload).then(data => {
        assert.deepEqual({ wrong: 'data' }, data);
        done();
      });
    });

    it('onAfterEvent', function(done) {
      client.callEvent('onAfterEvent', payload).then(data => {
        assert.deepEqual({ ...payload, after: 'nice' }, data);
        done();
      });
    });
  });

  describe('Authorize', function() {
    it('Authroize status should be false', function(done) {
      assert.equal(client.authorized, false);
      done();
    });

    it('Wrong details', function(done) {
      client
        .authenticate({
          username: 'test1',
          password: 'test1'
        })
        .catch(e => {
          assert.equal(e, 'Invalid login');
          done();
        });
    });

    it('Authenticate', function(done) {
      client
        .authenticate({
          username: 'test',
          password: 'test'
        })
        .then(() => {
          done();
        });
    });

    it('Props contain username', function(done) {
      assert.equal(client.props['username'], 'test');
      done();
    });

    it('Authroize status should be true', function(done) {
      assert.equal(client.authorized, true);
      done();
    });

    it('Already authenticated', function(done) {
      client
        .authenticate({
          username: 'test',
          password: 'test'
        })
        .catch(e => {
          assert.equal(e, 'Already authenticated');
          done();
        });
    });

    it('Deauthenticate', function(done) {
      client.deauthenticate().then(d => {
        assert.equal(d, 'Done');
        done();
      });
    });

    it('Authroize status should be false', function(done) {
      assert.equal(client.authorized, false);
      done();
    });

    it('Props empty', function(done) {
      assert.deepEqual(client.props, {});
      done();
    });

    it('Deauthenticate not authenticated', function(done) {
      client.deauthenticate().catch(e => {
        assert.equal(e, 'Not authenticated');
        done();
      });
    });
  });
});
