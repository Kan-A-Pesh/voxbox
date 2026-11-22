//! Automatic restart schedule of the audio engine, kept free of devices and
//! clocks so it can be tested deterministically.
//!
//! While no devices are open the engine retries with a growing delay. A
//! successful open is only announced once the streams stayed healthy for
//! [`PROBATION`]: WASAPI starts streams asynchronously and reports a failed
//! start later, so "opened" is not yet "sound is back".

use std::time::{Duration, Instant};

/// How long reopened streams must run without error before recovery is announced.
pub(crate) const PROBATION: Duration = Duration::from_millis(750);

/// Delay before automatic restart attempt `attempt` (0-based): 1 s, 2 s, 4 s,
/// 8 s, then every 10 s while the engine has no working devices.
pub(crate) fn retry_delay(attempt: u32) -> Duration {
    Duration::from_secs(1u64.checked_shl(attempt).unwrap_or(u64::MAX).min(10))
}

#[derive(Debug, Default)]
pub(crate) struct Recovery {
    /// Failed attempts so far in this outage (drives the delay).
    attempt: u32,
    next_at: Option<Instant>,
    probation_until: Option<Instant>,
}

impl Recovery {
    /// Streams are gone: schedule the next attempt. A loss during probation
    /// counts as a failed attempt, so a start that keeps failing backs off.
    pub fn lost(&mut self, now: Instant) {
        if self.probation_until.take().is_some() {
            self.attempt += 1;
        }
        if self.next_at.is_none() {
            self.next_at = Some(now + retry_delay(self.attempt));
        }
    }

    pub fn due(&self, now: Instant) -> bool {
        self.next_at.is_some_and(|at| now >= at)
    }

    pub fn open_failed(&mut self, now: Instant) {
        self.attempt += 1;
        self.next_at = Some(now + retry_delay(self.attempt));
    }

    pub fn opened(&mut self, now: Instant) {
        self.next_at = None;
        self.probation_until = Some(now + PROBATION);
    }

    /// True exactly once, when reopened streams have survived the probation.
    pub fn stable(&mut self, now: Instant) -> bool {
        match self.probation_until {
            Some(until) if now >= until => {
                *self = Self::default();
                true
            }
            _ => false,
        }
    }

    /// A manual device change replaces any automatic restart in progress.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_delay_grows_then_caps_at_ten_seconds() {
        let secs: Vec<u64> = (0..7).map(|a| retry_delay(a).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 10, 10, 10]);
        assert_eq!(
            retry_delay(200),
            Duration::from_secs(10),
            "no overflow on long outages"
        );
    }

    #[test]
    fn retries_until_open_then_announces_once_after_probation() {
        let t0 = Instant::now();
        let mut r = Recovery::default();
        r.lost(t0);
        assert!(!r.due(t0));
        assert!(r.due(t0 + Duration::from_secs(1)));
        r.open_failed(t0 + Duration::from_secs(1));
        assert!(!r.due(t0 + Duration::from_secs(2)), "second wait is 2 s");
        assert!(r.due(t0 + Duration::from_secs(3)));
        r.opened(t0 + Duration::from_secs(3));
        assert!(
            !r.due(t0 + Duration::from_secs(60)),
            "no retry while streams are open"
        );
        assert!(
            !r.stable(t0 + Duration::from_secs(3)),
            "not announced at open time"
        );
        assert!(r.stable(t0 + Duration::from_secs(3) + PROBATION));
        assert!(
            !r.stable(t0 + Duration::from_secs(10)),
            "announced only once"
        );
    }

    #[test]
    fn a_start_that_fails_during_probation_keeps_backing_off() {
        let t0 = Instant::now();
        let mut r = Recovery::default();
        r.lost(t0);
        r.opened(t0 + Duration::from_secs(1));
        // WASAPI reports the failed start asynchronously, before probation ends.
        r.lost(t0 + Duration::from_millis(1_100));
        assert!(
            !r.stable(t0 + Duration::from_secs(5)),
            "never announced as recovered"
        );
        assert!(
            !r.due(t0 + Duration::from_millis(2_500)),
            "delay grew to 2 s"
        );
        assert!(r.due(t0 + Duration::from_millis(3_100)));
    }

    #[test]
    fn manual_change_cancels_the_schedule() {
        let t0 = Instant::now();
        let mut r = Recovery::default();
        r.lost(t0);
        r.reset();
        assert!(!r.due(t0 + Duration::from_secs(60)));
        assert!(!r.stable(t0 + Duration::from_secs(60)));
    }
}
