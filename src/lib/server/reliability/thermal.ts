/**
 * Host thermal observability (brief §7) — deliberately limited scope.
 *
 * DUMBscope reads the sysfs thermal zones' temp files (readable from inside
 * the container on standard Docker; no privileges, no host monitoring suite).
 * The only job: know the package/board temperature, detect ≥90/95/100 °C
 * crossings, and capture a small correlation snapshot (host load, DUMB CPU,
 * top DUMB services, InfiniDysk repair state) at the moment of the spike.
 * No causality is claimed — the snapshot exists so a human (or Hermes) can
 * correlate afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ThermalCorrelationSnapshot, ThermalSnapshot, ThermalZoneSample } from '$lib/types';

export const THERMAL_TUNING = {
	/** Sample cadence (driven by the hub housekeeper). */
	sampleIntervalMs: 60_000,
	/** Spike thresholds in °C (crossing produces a timeline + snapshot). */
	levels: [90, 95, 100],
	/** Recovery hysteresis below the triggered level. */
	recoveryDeltaC: 5,
	/** Series points kept in memory (1-minute cadence ≈ 6h). */
	seriesPoints: 360
} as const;

export type ThermalTuning = {
	sampleIntervalMs: number;
	levels: readonly number[];
	recoveryDeltaC: number;
	seriesPoints: number;
};

/** Read all thermal zones; nulls for unreadable files, never a throw. */
export function readThermalZones(base = '/sys/class/thermal'): ThermalZoneSample[] {
	const zones: ThermalZoneSample[] = [];
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(base).filter((e) => e.startsWith('thermal_zone'));
	} catch {
		return zones;
	}
	entries.sort();
	for (const entry of entries) {
		let type = '';
		let temp: number | null = null;
		try {
			type = fs.readFileSync(path.join(base, entry, 'type'), 'utf8').trim();
		} catch {
			// type optional
		}
		try {
			const raw = fs.readFileSync(path.join(base, entry, 'temp'), 'utf8').trim();
			const n = Number(raw);
			if (Number.isFinite(n)) temp = n / 1000;
		} catch {
			// no temp readable
		}
		zones.push({ zone: entry, type, tempC: temp });
	}
	return zones;
}

export interface ThermalSampleContext {
	/** Host load average (from the DUMB metrics snapshot). */
	hostLoad: number | null;
	/** DUMB cgroup CPU percent (from the DUMB metrics snapshot). */
	dumbCpuPercent: number | null;
	/** Top DUMB processes by CPU right now. */
	topProcesses: { name: string; cpuPercent: number | null }[];
	/** InfiniDysk repair currently active (from the log aggregator). */
	infiniDyskRepairActive: boolean;
}

/** Pure spike evaluation: returns the level crossed for this sample, if any. */
export function evaluateThermalSpike(
	tempC: number,
	previousActiveLevel: number | null,
	tuning: ThermalTuning = { ...THERMAL_TUNING, levels: THERMAL_TUNING.levels }
): number | null {
	let crossed: number | null = null;
	for (const l of tuning.levels) {
		if (tempC >= l) crossed = l;
	}
	// Hysteresis: escalate to higher levels immediately; otherwise hold the
	// active level until the temp drops below it − 5 °C (sustained recovery).
	if (previousActiveLevel === null) return crossed;
	if (crossed !== null && crossed > previousActiveLevel) return crossed;
	return tempC >= previousActiveLevel - tuning.recoveryDeltaC ? previousActiveLevel : null;
}

/** Build the correlation snapshot captured at a spike (pure). */
export function buildThermalCorrelation(input: {
	at: number;
	level: number;
	tempC: number;
	zoneType: string | null;
	ctx: ThermalSampleContext;
}): ThermalCorrelationSnapshot {
	return {
		at: input.at,
		level: (input.level as 90 | 95 | 100) ?? 90,
		tempC: input.tempC,
		zoneType: input.zoneType,
		hostLoad: input.ctx.hostLoad,
		dumbCpuPercent: input.ctx.dumbCpuPercent,
		topProcesses: input.ctx.topProcesses.slice(0, 3),
		infiniDyskRepairActive: input.ctx.infiniDyskRepairActive,
		recoveredAt: null
	};
}

export class ThermalMonitor {
	private readonly nowFn: () => number;
	private readonly t: ThermalTuning;
	private onSpike: (snapshot: ThermalCorrelationSnapshot) => void;
	private onRecovery: (snapshot: ThermalCorrelationSnapshot) => void;
	private activeLevel: number | null = null;
	private activeSince: number | null = null;
	private lastSnapshot: ThermalCorrelationSnapshot | null = null;
	private series: { at: number; maxC: number | null; packageC: number | null }[] = [];
	private zones: ThermalZoneSample[] = [];
	private lastSampleAt = 0;
	private unavailableReason: string | null = null;

	constructor(options: {
		now?: () => number;
		tuning?: Partial<ThermalTuning>;
		onSpike: (snapshot: ThermalCorrelationSnapshot) => void;
		onRecovery?: (snapshot: ThermalCorrelationSnapshot) => void;
	}) {
		this.nowFn = options.now ?? (() => Date.now());
		this.t = { ...THERMAL_TUNING, ...options.tuning };
		this.onSpike = options.onSpike;
		this.onRecovery = options.onRecovery ?? (() => {});
	}

	getSnapshot(): ThermalSnapshot {
		const temps = this.zones.map((z) => z.tempC).filter((t): t is number => t !== null);
		const max = temps.length > 0 ? Math.max(...temps) : null;
		const maxZone = this.zones.find((z) => z.tempC === max) ?? null;
		const pkg = this.zones.find((z) => z.type === 'x86_pkg_temp')?.tempC ?? null;
		return {
			available: temps.length > 0,
			unavailableReason: this.unavailableReason,
			zones: this.zones,
			maxTempC: max,
			maxZoneType: maxZone?.type ?? null,
			packageTempC: pkg,
			spikeLevel: (this.activeLevel as ThermalSnapshot['spikeLevel']) ?? null,
			spikeSince: this.activeSince,
			lastSpike: this.lastSnapshot
		};
	}

	getSeries(): { at: number; maxC: number | null; packageC: number | null }[] {
		return this.series;
	}

	/** One sample pass. `ctx` supplies the correlation inputs. */
	sample(ctx: ThermalSampleContext): ThermalSnapshot {
		const now = this.nowFn();
		if (now - this.lastSampleAt < this.t.sampleIntervalMs) return this.getSnapshot();
		this.lastSampleAt = now;
		this.zones = readThermalZones();
		const temps = this.zones.map((z) => z.tempC).filter((t): t is number => t !== null);
		if (temps.length === 0) {
			this.unavailableReason = 'no readable thermal zones (/sys/class/thermal)';
		} else {
			this.unavailableReason = null;
		}
		const max = temps.length > 0 ? Math.max(...temps) : null;
		const pkg = this.zones.find((z) => z.type === 'x86_pkg_temp')?.tempC ?? null;
		this.series.push({ at: now, maxC: max, packageC: pkg });
		if (this.series.length > this.t.seriesPoints) {
			this.series = this.series.slice(-this.t.seriesPoints);
		}
		if (max !== null) {
			const level = evaluateThermalSpike(max, this.activeLevel, this.t);
			if (level !== null && (this.activeLevel === null || level > this.activeLevel)) {
				// New (or escalated) spike: capture the correlation snapshot.
				const hottest = this.zones.find((z) => z.tempC === max) ?? null;
				this.activeLevel = level;
				this.activeSince = this.activeSince ?? now;
				this.lastSnapshot = buildThermalCorrelation({
					at: now,
					level,
					tempC: max,
					zoneType: hottest?.type ?? null,
					ctx
				});
				this.onSpike(this.lastSnapshot);
			} else if (this.activeLevel !== null && max < this.activeLevel - this.t.recoveryDeltaC) {
				// Sustained recovery.
				const snapshot = this.lastSnapshot;
				this.activeLevel = null;
				this.activeSince = null;
				if (snapshot) {
					snapshot.recoveredAt = now;
					this.onRecovery(snapshot);
				}
			}
		}
		return this.getSnapshot();
	}
}
