import moleculer = require('moleculer');
import { Service, Action, Method } from 'moleculer-decorators';
import { WSGateway, Settings, route, Request, BaseClass } from '../../src';
import Bluebird = require('bluebird');

@Service({
  mixins: [WSGateway],
  settings: <Settings>{
    port: 3000,
    path: '/',
    routes: [
      <route>{
        name: 'SomeName',
        whitelist: ['SomeService.*'],
        mappingPolicy: 'strict',
        authorization: true // Mark this route as protected
      }
    ]
  }
})
class Gateway extends BaseClass {
  @Method
  authorize(client, params) {
    if (params.username == 'test' && params.password == 'test') {
      // The 'props' property on the client class is reserved for stuff like usernames.
      // it'll also get synced down to the client so don't put any sensitive data here.
      client.props.username = 'test';
      return Bluebird.Promise.resolve();
    }

    return Bluebird.Promise.reject('Invalid login');
  }

  @Method
  deauthorize(client, params) {
    client.props = ''; // Clear props

    return Bluebird.Promise.resolve({
      status: 'Success'
    });
  }
}
