/**
 * An attempt's `attemptTimeoutMs` deadline. It can be paused so that VM boot,
 * which Gondolin bounds with its own start timeout, is not charged to it: a
 * guest that never becomes ready then fails as a sandbox launch, not as an
 * attempt timeout.
 */
export type AttemptDeadline = {
	/** Aborts with a `TimeoutError` once the charged time reaches the limit. */
	readonly signal: AbortSignal;
	/** Whole milliseconds charged so far. */
	chargedMs(): number;
	pause(): void;
	resume(): void;
	dispose(): void;
};

export function createAttemptDeadline(
	timeoutMs: number,
	now: () => number = () => performance.now(),
): AttemptDeadline {
	const controller = new AbortController();
	let charged = 0;
	let runningSince: number | undefined;
	let timer: NodeJS.Timeout | undefined;
	const stop = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (runningSince !== undefined) charged += now() - runningSince;
		runningSince = undefined;
	};
	const start = () => {
		if (runningSince !== undefined || controller.signal.aborted) return;
		runningSince = now();
		timer = setTimeout(
			() => {
				stop();
				controller.abort(
					new DOMException(
						"The operation was aborted due to timeout",
						"TimeoutError",
					),
				);
			},
			Math.max(0, timeoutMs - charged),
		);
		// Like AbortSignal.timeout, the deadline alone keeps no process alive.
		timer.unref?.();
	};
	start();
	return {
		signal: controller.signal,
		chargedMs: () =>
			Math.max(
				0,
				Math.ceil(
					charged + (runningSince === undefined ? 0 : now() - runningSince),
				),
			),
		pause: stop,
		resume: start,
		dispose: stop,
	};
}
