import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fault} from '../extension/protocol.js';

// Grants live only on an open control connection. A grant never stands in for
// the durable browser lease and is never stolen based on a PID or wall clock.
export class RecoveryCoordinator {
  constructor({budget = 60000, now = () => performance.now(), limit = 16} = {}) {
    this.budget = budget; this.now = now; this.limit = limit; this.grants = new Map();
  }
  begin(key, owner) {
    if (this.grants.has(key)) throw fault('SESSION_BUSY', 'Another live native operation holds this workspace/session.');
    if (this.grants.size >= this.limit) throw fault('BRIDGE_BUSY', 'Too many native operations.');
    const grant = {key, owner, nonce: crypto.randomUUID(), expires: this.now() + this.budget, active: true};
    this.grants.set(key, grant); return grant;
  }
  check(grant, owner, nonce) {
    if (!grant || !grant.active || this.grants.get(grant.key) !== grant || grant.owner !== owner || nonce !== grant.nonce || this.now() >= grant.expires)
      throw fault('OPERATION_FENCED', 'This native operation has ended; its outcome may be unknown. Inspect before retrying.');
  }
  end(grant) {
    if (!grant) return;
    grant.active = false;
    if (this.grants.get(grant.key) === grant) this.grants.delete(grant.key);
  }
}
