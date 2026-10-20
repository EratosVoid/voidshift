import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBattery, parseBootTime, parseSleepDisabled, parseThermalSerious } from '../src/parse.ts';

test('SleepDisabled flag', () => {
  assert.equal(parseSleepDisabled('System-wide power settings:\n SleepDisabled\t\t0\nCurrently in use:'), false);
  assert.equal(parseSleepDisabled('System-wide power settings:\n SleepDisabled\t\t1\n'), true);
});

test('battery on battery power', () => {
  const out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=21430371)\t89%; discharging; 7:44 remaining present: true";
  assert.deepEqual(parseBattery(out), { onBattery: true, percent: 89 });
});

test('battery on AC', () => {
  const out = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true";
  assert.deepEqual(parseBattery(out), { onBattery: false, percent: 100 });
});

test('thermal: nothing recorded is not serious', () => {
  const out = 'Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded';
  assert.equal(parseThermalSerious(out), false);
});

test('thermal: throttled CPU or a warning level is serious', () => {
  assert.equal(parseThermalSerious('CPU_Scheduler_Limit \t= 100\nCPU_Speed_Limit \t= 45'), true);
  assert.equal(parseThermalSerious('CPU_Speed_Limit \t= 100'), false);
  assert.equal(parseThermalSerious('Thermal warning level set to 2.'), true);
});

test('boot time', () => {
  assert.equal(parseBootTime('{ sec = 1787598645, usec = 753120 } Mon Aug 24 13:10:45 2026')?.getTime(), 1787598645000);
});
