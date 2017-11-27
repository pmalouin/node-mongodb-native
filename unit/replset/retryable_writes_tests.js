'use strict';
var expect = require('chai').expect,
  ReplSet = require('../../../../lib/topologies/replset'),
  mock = require('../../../mock'),
  ReplSetFixture = require('../common').ReplSetFixture,
  ClientSession = require('../../../../lib/sessions').ClientSession,
  ServerSessionPool = require('../../../../lib/sessions').ServerSessionPool;

const test = new ReplSetFixture();
describe('Sessions (ReplSet)', function() {
  afterEach(() => mock.cleanup());
  beforeEach(() => test.setup({ ismaster: mock.DEFAULT_ISMASTER_36 }));

  it('should add `txnNumber` to write commands where `retryWrites` is true', {
    metadata: { requires: { topology: ['single'] } },
    test: function(done) {
      var replset = new ReplSet(
        [test.primaryServer.address(), test.firstSecondaryServer.address()],
        {
          setName: 'rs',
          connectionTimeout: 3000,
          socketTimeout: 0,
          haInterval: 100,
          size: 1
        }
      );

      const sessionPool = new ServerSessionPool(replset);
      const session = new ClientSession(replset, sessionPool);

      let command = null;
      test.primaryServer.setMessageHandler(request => {
        const doc = request.document;
        if (doc.ismaster) {
          request.reply(test.primaryStates[0]);
        } else if (doc.insert) {
          command = doc;
          request.reply({ ok: 1 });
        }
      });

      replset.on('all', () => {
        replset.insert('test.test', [{ a: 1 }], { retryWrites: true, session: session }, function(
          err
        ) {
          expect(err).to.not.exist;
          expect(command).to.have.property('txnNumber');
          expect(command.txnNumber).to.eql(1);

          replset.destroy();
          done();
        });
      });

      replset.on('error', done);
      replset.connect();
    }
  });
});
