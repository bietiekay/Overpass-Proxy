import { parentPort } from 'node:worker_threads';

if (!parentPort) throw new Error('fixture worker requires parent port');

const applied = new Set();
let appliedRequests = 0;

parentPort.on('message', (message) => {
  if (message?.type === 'fixtureAckBatch') {
    parentPort.postMessage({ type: 'ack', batchId: message.batchId });
    parentPort.postMessage({ type: 'fixtureReport', appliedRequests });
    return;
  }
  if (message?.type === 'fixtureAckNotification') {
    parentPort.postMessage({ type: 'notificationAck', notificationId: message.notificationId });
    return;
  }
  if (message?.type === 'recordBatch') {
    if (!applied.has(message.batch.batchId)) {
      applied.add(message.batch.batchId);
      appliedRequests += message.batch.totalRequests;
    }
    parentPort.postMessage({ type: 'fixtureSeen', commandType: message.type, batchId: message.batch.batchId, appliedRequests });
    return;
  }
  if (message?.type === 'notifications') {
    parentPort.postMessage({ type: 'fixtureSeen', commandType: message.type, notificationId: message.notificationId, dirtyTargets: message.dirtyTargets, refreshTargets: message.refreshTargets });
    return;
  }
  if (message?.type === 'shutdown') {
    for (const batch of message.batches ?? []) {
      if (applied.has(batch.batchId)) continue;
      applied.add(batch.batchId);
      appliedRequests += batch.totalRequests;
    }
    parentPort.postMessage({ type: 'stopped' });
  }
});

parentPort.postMessage({ type: 'ready' });
