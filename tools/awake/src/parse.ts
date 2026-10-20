// Parsers for macOS power tool output. Kept pure so they are testable
// against captured samples.

export interface Battery {
  onBattery: boolean;
  percent: number | null;
}

// `pmset -g`: " SleepDisabled\t\t1"
export function parseSleepDisabled(out: string): boolean {
  const m = out.match(/SleepDisabled\s+(\d)/);
  return m?.[1] === '1';
}

// `pmset -g batt`: "Now drawing from 'Battery Power'" then " -InternalBattery-0 ... 89%; discharging"
export function parseBattery(out: string): Battery {
  const onBattery = /'Battery Power'/.test(out);
  const m = out.match(/(\d{1,3})%/);
  return { onBattery, percent: m ? Number(m[1]) : null };
}

// `pmset -g therm`: nothing recorded on a cool Mac. Under load it reports a
// thermal warning level and CPU_Speed_Limit (100 = no throttling).
export function parseThermalSerious(out: string): boolean {
  const level = out.match(/thermal warning level[^0-9]*(\d+)/i);
  if (level && Number(level[1]) > 0) return true;
  const speed = out.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  return speed ? Number(speed[1]) < 60 : false;
}

// `sysctl -n kern.boottime`: "{ sec = 1787598645, usec = 753120 } Mon Aug 24 ..."
export function parseBootTime(out: string): Date | null {
  const m = out.match(/sec = (\d+)/);
  return m ? new Date(Number(m[1]) * 1000) : null;
}
