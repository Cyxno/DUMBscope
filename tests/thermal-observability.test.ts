/**
 * Thermal correlation tests (observability spec §7): zone reading, spike
 * levels with hysteresis, correlation snapshot content and recovery.
 */
import { describe, expect, it } from 'vitest';
import {
	buildThermalCorrelation,
	evaluateThermalSpike,
	readThermalZones,
	ThermalMonitor,
	THERMAL_TUNING
} from '../src/lib/server/reliability/thermal';

describe('zone reading', () => {
	it('returns an empty list (not a throw) for an unreadable base', () => {
		expect(readThermalZones('/nonexistent-thermal-xyz')).toEqual([]);
	});

	it('reads real zones when sysfs is available in the environment', () => {
		const zones = readThermalZones();
		// In this container the host sysfs is visible; assert shape, not values.
		for (const z of zones) {
			expect(z.zone).toMatch(/^thermal_zone/);
			if (z.tempC !== null) {
				expect(z.tempC).toBeGreaterThan(-100);
				expect(z.tempC).toBeLessThan(250);
			}
		}
	});
});

describe('spike evaluation with hysteresis', () => {
	it('returns null below all thresholds', () => {
		expect(evaluateThermalSpike(70, null)).toBeNull();
	});

	it('returns the highest crossed level', () => {
		expect(evaluateThermalSpike(91, null)).toBe(90);
		expect(evaluateThermalSpike(96, null)).toBe(95);
		expect(evaluateThermalSpike(101, null)).toBe(100);
	});

	it('stays at the active level inside the hysteresis band', () => {
		// Active at 95, now 91.5 → still >= 95 - 5: no recovery yet.
		expect(evaluateThermalSpike(91.5, 95)).toBe(95);
		// 89.5 < 90: recovered.
		expect(evaluateThermalSpike(89.5, 95)).toBeNull();
	});
});

describe('monitor correlation snapshots', () => {
	function makeMonitor(clock: { now: number }) {
		const spikes: ReturnType<typeof buildThermalCorrelation>[] = [];
		const recoveries: ReturnType<typeof buildThermalCorrelation>[] = [];
		const monitor = new ThermalMonitor({
			now: () => clock.now,
			tuning: { sampleIntervalMs: 0 },
			onSpike: (s) => spikes.push(s),
			onRecovery: (s) => recoveries.push(s)
		});
		return { monitor, spikes, recoveries };
	}
	const ctx = {
		hostLoad: 4.7,
		dumbCpuPercent: 34,
		topProcesses: [{ name: 'rclone instances RD', cpuPercent: 18 }],
		infiniDyskRepairActive: true
	};

	it('samples real zones into the series without spiking below thresholds', () => {
		const clock = { now: 1_800_000_000_000 };
		const { monitor, spikes } = makeMonitor(clock);
		const snap = monitor.sample(ctx);
		// The test host exposes real zones; shape assertions only.
		expect(Array.isArray(snap.zones)).toBe(true);
		expect(monitor.getSeries()).toHaveLength(1);
		if (snap.available && (snap.maxTempC ?? 0) < 90) {
			expect(snap.spikeLevel).toBeNull();
			expect(spikes).toHaveLength(0);
		}
	});

	it('builds a spike snapshot with the correlation inputs, no causality', () => {
		const snapshot = buildThermalCorrelation({
			at: 1_800_000_000_000,
			level: 95,
			tempC: 96,
			zoneType: 'x86_pkg_temp',
			ctx
		});
		expect(snapshot.level).toBe(95);
		expect(snapshot.tempC).toBe(96);
		expect(snapshot.zoneType).toBe('x86_pkg_temp');
		expect(snapshot.hostLoad).toBe(4.7);
		expect(snapshot.dumbCpuPercent).toBe(34);
		expect(snapshot.topProcesses[0]!.name).toBe('rclone instances RD');
		expect(snapshot.infiniDyskRepairActive).toBe(true);
		expect(snapshot.recoveredAt).toBeNull();
		expect(
			evaluateThermalSpike(96, null, { ...THERMAL_TUNING, levels: THERMAL_TUNING.levels })
		).toBe(95);
	});
});
