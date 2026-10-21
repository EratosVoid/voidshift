import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type AwakeState, type SystemReading } from '../src/decide.ts';

const now = new Date('2026-10-21T02:00:00Z');
const state: AwakeState = { managed: true, since: '2026-10-20T20:00:00Z', batteryFloor: 20 };
const sys: SystemReading = {
  sleepDisabled: true,
  battery: { onBattery: true, percent: 60 },
  thermalSerious: false,
  bootTime: new Date('2026-10-01T00:00:00Z'),
};

test('healthy session keeps going, no time cap by default', () => {
  assert.deepEqual(decide(state, sys, now), { action: 'keep' });
});

test('not managed: never touches sleep', () => {
  assert.deepEqual(decide({ managed: false, batteryFloor: 20 }, sys, now), { action: 'keep' });
});

test('battery floor reverts on battery power only', () => {
  const low = { ...sys, battery: { onBattery: true, percent: 20 } };
  assert.equal(decide(state, low, now).action, 'revert');
  const lowOnAc = { ...sys, battery: { onBattery: false, percent: 20 } };
  assert.equal(decide(state, lowOnAc, now).action, 'keep');
});

test('timer, heat and restart revert', () => {
  assert.equal(decide({ ...state, until: '2026-10-21T01:00:00Z' }, sys, now).action, 'revert');
  assert.equal(decide(state, { ...sys, thermalSerious: true }, now).action, 'revert');
  assert.equal(decide(state, { ...sys, bootTime: new Date('2026-10-20T23:00:00Z') }, now).action, 'revert');
});

test('sleep re-enabled elsewhere: forget, do not fight it', () => {
  assert.equal(decide(state, { ...sys, sleepDisabled: false }, now).action, 'forget');
});

test('heat switch off skips the thermal revert', () => {
  const hot = { ...sys, thermalSerious: true };
  assert.equal(decide({ ...state, heat: false }, hot, now).action, 'keep');
  assert.equal(decide({ ...state, heat: true }, hot, now).action, 'revert');
});

test('reboot switch off skips the restart revert', () => {
  const rebooted = { ...sys, bootTime: new Date('2026-10-20T23:00:00Z') };
  assert.equal(decide({ ...state, revertOnReboot: false }, rebooted, now).action, 'keep');
  assert.equal(decide({ ...state, revertOnReboot: true }, rebooted, now).action, 'revert');
});
