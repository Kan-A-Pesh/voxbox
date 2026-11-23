//! Device lifecycle of the engine: which devices are open, what to reopen after
//! a failure, and what the UI is told. Runs on the control thread; the audio
//! hardware is behind [`Backend`] so every transition is tested with a fake.
//!
//! Rules:
//! - Automatic restarts aim at `wanted`, the selection the app has saved.
//! - A reopened device only counts as recovered after [`PROBATION`] without
//!   error (WASAPI reports a failed start asynchronously). Until then the
//!   published status keeps saying the sound is down.
//! - If the wanted devices open but fail to start, the next attempt tries the
//!   system defaults first.
//! - While running on the defaults, the wanted devices are checked
//!   periodically and switched back to once they are plugged in again.
//!
//! [`PROBATION`]: crate::recovery::PROBATION

use std::time::{Duration, Instant};

use crate::recovery::Recovery;
use crate::{DeviceSelection, EngineError, EngineEvent, EngineStatus, Result};

pub(crate) trait Backend {
    type Streams;
    /// Opens and starts streams for `selection`.
    fn open(&mut self, selection: &DeviceSelection) -> Result<Self::Streams>;
    /// Stops audio processing and closes `streams`.
    fn close(&mut self, streams: Self::Streams);
    /// Lets audio processing run on the streams just opened.
    fn resume(&mut self);
    fn status_of(&self, streams: &Self::Streams) -> EngineStatus;
    /// Whether every explicitly chosen device of `selection` is plugged in.
    fn available(&self, selection: &DeviceSelection) -> bool;
    fn now(&self) -> Instant;
    /// Waits briefly for the just-opened streams to really start (WASAPI
    /// reports a refused start asynchronously). Used for manual changes, which
    /// must not be saved if the device does not start.
    fn confirm_started(&mut self) -> bool;
    /// False once the open streams reported a failure.
    fn healthy(&self) -> bool;
}

/// First wait before trying to go back to the wanted devices; doubles after
/// each failed switch-back, up to [`SWITCH_BACK_MAX`].
const SWITCH_BACK: Duration = Duration::from_secs(15);
const SWITCH_BACK_MAX: Duration = Duration::from_secs(120);

struct Probation {
    status: EngineStatus,
    selection: DeviceSelection,
    /// Switching back from the defaults rather than recovering from silence.
    switch_back: bool,
}

pub(crate) struct Manager<B: Backend> {
    backend: B,
    streams: Option<B::Streams>,
    /// Selection the open streams were built from.
    active: Option<DeviceSelection>,
    wanted: DeviceSelection,
    recovery: Recovery,
    probation: Option<Probation>,
    /// The wanted devices opened but failed to start: try the defaults first.
    prefer_fallback: bool,
    switch_back_at: Option<Instant>,
    switch_back_every: Duration,
    status: EngineStatus,
    events: Vec<EngineEvent>,
}

fn stopped_status() -> EngineStatus {
    EngineStatus {
        running: false,
        input_name: None,
        cable_name: None,
        monitor_name: None,
        cable_found: false,
        latency_ms: 0,
        last_error: None,
        restarting: false,
        fallback: false,
        revision: 0,
    }
}

impl<B: Backend> Manager<B> {
    pub fn new(backend: B, wanted: DeviceSelection) -> Self {
        Self {
            backend,
            streams: None,
            active: None,
            wanted,
            recovery: Recovery::default(),
            probation: None,
            prefer_fallback: false,
            switch_back_at: None,
            switch_back_every: SWITCH_BACK,
            status: stopped_status(),
            events: Vec::new(),
        }
    }

    pub fn status(&self) -> &EngineStatus {
        &self.status
    }

    pub fn take_events(&mut self) -> Vec<EngineEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn has_streams(&self) -> bool {
        self.streams.is_some()
    }

    /// Every status change bumps `revision`, so the UI can drop stale reads.
    fn set_status(&mut self, update: impl FnOnce(&mut EngineStatus)) {
        let revision = self.status.revision;
        update(&mut self.status);
        self.status.revision = revision + 1;
    }

    /// Records why the sound is down; quiet `StatusChanged` only when the
    /// reason changed, so retries never spam.
    fn set_outage(&mut self, message: String, loud: bool) {
        // Every outage has a retry scheduled from the moment it starts.
        self.recovery.lost(self.backend.now());
        let changed = self.status.last_error.as_deref() != Some(message.as_str());
        self.set_status(|s| {
            s.running = false;
            s.restarting = true;
            s.last_error = Some(message.clone());
        });
        if loud {
            tracing::warn!("{message}");
            self.events.push(EngineEvent::DeviceError { message });
        } else if changed {
            tracing::warn!("{message}");
            self.events.push(EngineEvent::StatusChanged);
        }
    }

    fn install(&mut self, streams: B::Streams, selection: DeviceSelection) {
        let status = self.backend.status_of(&streams);
        let fallback = selection != self.wanted;
        self.streams = Some(streams);
        self.active = Some(selection);
        self.backend.resume();
        self.set_status(|s| {
            *s = EngineStatus {
                revision: s.revision,
                fallback,
                ..status
            };
        });
    }

    /// Opens `selection` and waits until it really started.
    fn open_started(&mut self, selection: &DeviceSelection) -> Result<B::Streams> {
        let streams = self.backend.open(selection)?;
        if self.backend.confirm_started() {
            Ok(streams)
        } else {
            self.backend.close(streams);
            Err(EngineError::Stream(String::from(
                "le périphérique s’est ouvert mais n’a pas démarré",
            )))
        }
    }

    fn close_streams(&mut self) {
        if let Some(streams) = self.streams.take() {
            self.backend.close(streams);
        }
    }

    fn schedule_switch_back(&mut self) {
        let fallback_used = self.active.as_ref().is_some_and(|a| *a != self.wanted);
        self.switch_back_at = fallback_used.then(|| self.backend.now() + self.switch_back_every);
    }

    /// Startup: the saved devices, else the system defaults, else retry later.
    pub fn start(&mut self) {
        let wanted = self.wanted.clone();
        match self.backend.open(&wanted) {
            Ok(streams) => self.install(streams, wanted),
            Err(error) => {
                let fallback = DeviceSelection::default();
                let opened = if wanted == fallback {
                    None
                } else {
                    self.backend.open(&fallback).ok()
                };
                match opened {
                    Some(streams) => {
                        self.install(streams, fallback);
                        let message = format!("{error}. Les périphériques par défaut du système sont utilisés en attendant.");
                        tracing::warn!("{message}");
                        self.events.push(EngineEvent::DeviceError { message });
                        self.schedule_switch_back();
                    }
                    None => {
                        self.set_outage(format!("{error}. Nouvelle tentative automatique…"), true)
                    }
                }
            }
        }
    }

    /// The app saved a new selection: automatic restarts aim for it from now on.
    pub fn set_target(&mut self, selection: DeviceSelection) {
        self.wanted = selection;
        self.prefer_fallback = false;
        self.switch_back_every = SWITCH_BACK;
        self.schedule_switch_back();
        let fallback =
            self.status.running && self.active.as_ref().is_some_and(|a| *a != self.wanted);
        if fallback != self.status.fallback {
            self.set_status(|s| s.fallback = fallback);
        }
    }

    /// Manual device change from Réglages.
    pub fn request(&mut self, selection: DeviceSelection) -> Result<()> {
        self.close_streams();
        self.probation = None;
        self.recovery.reset();
        match self.open_started(&selection) {
            Ok(streams) => {
                self.install(streams, selection);
                self.schedule_switch_back();
                Ok(())
            }
            Err(error) => {
                let previous = self.active.clone();
                match previous.as_ref().map(|p| (p.clone(), self.open_started(p))) {
                    Some((previous, Ok(streams))) => {
                        self.install(streams, previous);
                        let message =
                            format!("{error}. Les périphériques précédents restent utilisés.");
                        self.events.push(EngineEvent::DeviceError { message });
                    }
                    _ => {
                        self.active = None;
                        self.set_outage(format!("{error}. Nouvelle tentative automatique…"), true);
                    }
                }
                Err(error)
            }
        }
    }

    /// The streams reported a failure (device unplugged, start refused…).
    pub fn lost(&mut self) {
        let now = self.backend.now();
        self.close_streams();
        self.recovery.lost(now);
        match self.probation.take() {
            Some(p) => {
                // Opened but did not start: never announced, so stay quiet.
                // Alternate: whichever selection just failed to start, the next
                // attempt begins with the other one, so a replugged headset is
                // tried again after the defaults also failed.
                if p.selection == self.wanted && p.selection != DeviceSelection::default() {
                    self.prefer_fallback = true;
                } else if p.selection != self.wanted {
                    self.prefer_fallback = false;
                }
                if p.switch_back {
                    self.switch_back_every = (self.switch_back_every * 2).min(SWITCH_BACK_MAX);
                }
                self.set_outage(
                    String::from("Un périphérique audio n’a pas démarré. Nouvelle tentative automatique…"),
                    false,
                );
            }
            None => self.set_outage(
                String::from("Un périphérique audio a été déconnecté ou son flux a échoué. Nouvelle tentative automatique…"),
                true,
            ),
        }
    }

    fn try_open(&mut self) -> std::result::Result<(B::Streams, DeviceSelection), EngineError> {
        let fallback = DeviceSelection::default();
        let mut order = vec![self.wanted.clone()];
        if self.wanted != fallback {
            if self.prefer_fallback {
                order.insert(0, fallback);
            } else {
                order.push(fallback);
            }
        }
        let mut first_error = None;
        for selection in order {
            match self.backend.open(&selection) {
                Ok(streams) => return Ok((streams, selection)),
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
        Err(first_error.unwrap_or_else(|| EngineError::Stream("aucun périphérique".into())))
    }

    /// Called every control-loop iteration.
    pub fn tick(&mut self) {
        if self.streams.is_some() && !self.backend.healthy() {
            // Failed after the runtime last looked: never promote it.
            self.lost();
            return;
        }
        let now = self.backend.now();
        if self.streams.is_none() {
            self.recovery.lost(now);
            if !self.recovery.due(now) {
                return;
            }
            match self.try_open() {
                Ok((streams, selection)) => {
                    let status = self.backend.status_of(&streams);
                    self.streams = Some(streams);
                    self.backend.resume();
                    // Not published yet: WASAPI may still refuse to start.
                    self.recovery.opened(self.backend.now());
                    self.probation = Some(Probation {
                        status,
                        selection,
                        switch_back: false,
                    });
                }
                Err(error) => {
                    self.recovery.open_failed(self.backend.now());
                    self.set_outage(format!("{error}. Nouvelle tentative automatique…"), false);
                }
            }
            return;
        }
        if self.probation.is_some() {
            if !self.recovery.stable(now) {
                return;
            }
            let Some(p) = self.probation.take() else {
                return;
            };
            self.active = Some(p.selection.clone());
            let fallback = p.selection != self.wanted;
            self.set_status(|s| {
                *s = EngineStatus {
                    revision: s.revision,
                    fallback,
                    ..p.status
                }
            });
            let message = if p.selection == self.wanted {
                self.switch_back_every = SWITCH_BACK;
                if p.switch_back {
                    "Périphériques choisis rétablis."
                } else {
                    "Son rétabli."
                }
                .to_string()
            } else {
                let input = self.status.input_name.clone().unwrap_or_default();
                format!("Son rétabli avec les périphériques par défaut (micro : {input}). Retour automatique à vos périphériques dès qu’ils sont branchés.")
            };
            self.schedule_switch_back();
            tracing::info!("{message}");
            self.events.push(EngineEvent::Recovered { message });
            return;
        }
        if self.switch_back_at.is_some_and(|at| now >= at) {
            let wanted = self.wanted.clone();
            if !self.backend.available(&wanted) {
                self.switch_back_at = Some(now + self.switch_back_every);
                return;
            }
            self.close_streams();
            match self.backend.open(&wanted) {
                Ok(streams) => {
                    let status = self.backend.status_of(&streams);
                    self.streams = Some(streams);
                    self.backend.resume();
                    self.switch_back_at = None;
                    self.recovery.opened(self.backend.now());
                    // Audio already flows through the saved devices: show them.
                    let shown = status.clone();
                    self.set_status(|s| {
                        *s = EngineStatus {
                            revision: s.revision,
                            ..shown
                        }
                    });
                    self.events.push(EngineEvent::StatusChanged);
                    self.probation = Some(Probation {
                        status,
                        selection: wanted,
                        switch_back: true,
                    });
                }
                Err(_) => {
                    // Still not usable: back to the defaults right away.
                    self.switch_back_every = (self.switch_back_every * 2).min(SWITCH_BACK_MAX);
                    let fallback = self.active.clone().unwrap_or_default();
                    match self.backend.open(&fallback) {
                        Ok(streams) => {
                            self.install(streams, fallback);
                            self.events.push(EngineEvent::StatusChanged);
                            self.schedule_switch_back();
                        }
                        Err(error) => self
                            .set_outage(format!("{error}. Nouvelle tentative automatique…"), true),
                    }
                }
            }
        }
    }

    /// The audio worker died: nothing will restart it.
    pub fn worker_died(&mut self) {
        self.close_streams();
        self.set_status(|s| {
            s.running = false;
            s.restarting = false;
            s.last_error = Some(
                "Le traitement audio s’est arrêté de manière inattendue. Redémarrez VoxBox.".into(),
            );
        });
        self.events.push(EngineEvent::DeviceError {
            message: "Le traitement audio s’est arrêté de manière inattendue. Redémarrez VoxBox."
                .into(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery::PROBATION;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    /// Fake hardware: which selections open, which are plugged, and a clock.
    #[derive(Clone, Default)]
    struct World {
        now: Rc<Cell<Option<Instant>>>,
        broken: Rc<RefCell<Vec<DeviceSelection>>>,
        unplugged: Rc<RefCell<Vec<DeviceSelection>>>,
        opens: Rc<RefCell<Vec<DeviceSelection>>>,
        resumed: Rc<Cell<u32>>,
        /// Selections that open fine but whose start is refused asynchronously.
        no_start: Rc<RefCell<Vec<DeviceSelection>>>,
        failed: Rc<Cell<bool>>,
    }
    impl World {
        fn new() -> Self {
            let w = Self::default();
            w.now.set(Some(Instant::now()));
            w
        }
        fn advance(&self, d: Duration) {
            self.now.set(Some(self.now.get().unwrap() + d));
        }
    }
    impl Backend for World {
        type Streams = DeviceSelection;
        fn open(&mut self, s: &DeviceSelection) -> Result<DeviceSelection> {
            self.opens.borrow_mut().push(s.clone());
            if self.broken.borrow().contains(s) || self.unplugged.borrow().contains(s) {
                Err(EngineError::DeviceNotFound(format!("{:?}", s.monitor)))
            } else {
                Ok(s.clone())
            }
        }
        fn close(&mut self, _: DeviceSelection) {}
        fn resume(&mut self) {
            self.resumed.set(self.resumed.get() + 1);
        }
        fn status_of(&self, s: &DeviceSelection) -> EngineStatus {
            EngineStatus {
                running: true,
                monitor_name: s.monitor.clone(),
                input_name: Some("micro".into()),
                ..stopped_status()
            }
        }
        fn available(&self, s: &DeviceSelection) -> bool {
            !self.unplugged.borrow().contains(s)
        }
        fn now(&self) -> Instant {
            self.now.get().unwrap()
        }
        fn confirm_started(&mut self) -> bool {
            let last = self.opens.borrow().last().cloned();
            !last.is_some_and(|s| self.no_start.borrow().contains(&s))
        }
        fn healthy(&self) -> bool {
            !self.failed.get()
        }
    }

    fn headset() -> DeviceSelection {
        DeviceSelection {
            input: None,
            cable: None,
            monitor: Some("Casque USB".into()),
        }
    }

    fn manager(world: &World) -> Manager<World> {
        let mut m = Manager::new(world.clone(), headset());
        m.start();
        m.take_events();
        m
    }

    fn recovered(events: &[EngineEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                EngineEvent::Recovered { message } => Some(message.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn unplug_then_replug_recovers_after_probation_only() {
        let w = World::new();
        let mut m = manager(&w);
        w.unplugged.borrow_mut().push(headset());
        w.broken.borrow_mut().push(DeviceSelection::default());
        m.lost();
        assert!(matches!(
            m.take_events()[..],
            [EngineEvent::DeviceError { .. }]
        ));
        assert!(m.status().restarting && !m.status().running);

        w.advance(Duration::from_secs(1));
        m.tick();
        let reason = m.status().last_error.clone().unwrap();
        assert!(
            reason.contains("Casque USB"),
            "the retry names the device: {reason}"
        );
        assert_eq!(m.take_events(), vec![EngineEvent::StatusChanged]);
        w.advance(Duration::from_secs(2));
        m.tick();
        assert!(
            m.take_events().is_empty(),
            "same failure again: no new event"
        );

        w.unplugged.borrow_mut().clear();
        w.advance(Duration::from_secs(4));
        m.tick();
        assert!(m.has_streams());
        assert!(
            !m.status().running,
            "not published as running during probation"
        );
        assert!(m.take_events().is_empty());
        w.advance(PROBATION);
        m.tick();
        assert_eq!(
            recovered(&m.take_events()),
            vec!["Son rétabli.".to_string()]
        );
        assert!(m.status().running && !m.status().restarting && m.status().last_error.is_none());
    }

    #[test]
    fn a_start_that_fails_asynchronously_tries_the_defaults_next() {
        let w = World::new();
        let mut m = manager(&w);
        m.lost();
        w.advance(Duration::from_secs(1));
        m.tick(); // reopens the headset
        assert_eq!(w.opens.borrow().last(), Some(&headset()));
        m.lost(); // ...whose start fails during probation
        assert!(!recovered(&m.take_events()).iter().any(|_| true));
        w.advance(Duration::from_secs(10));
        m.tick();
        assert_eq!(
            w.opens.borrow().last(),
            Some(&DeviceSelection::default()),
            "defaults tried first"
        );
        w.advance(PROBATION);
        m.tick();
        let messages = recovered(&m.take_events());
        assert!(
            messages[0].contains("périphériques par défaut"),
            "{messages:?}"
        );
        assert!(m.status().running);
    }

    #[test]
    fn missing_saved_devices_start_on_the_defaults_and_say_so() {
        let w = World::new();
        w.unplugged.borrow_mut().push(headset());
        let mut m = Manager::new(w.clone(), headset());
        m.start();
        assert!(m.status().running && !m.status().restarting);
        assert!(
            m.status().last_error.is_none(),
            "working defaults are not an outage"
        );
        let events = m.take_events();
        let [EngineEvent::DeviceError { message }] = &events[..] else {
            panic!("{events:?}")
        };
        assert!(
            message.contains("périphériques par défaut du système"),
            "{message}"
        );
    }

    #[test]
    fn nothing_usable_at_startup_is_an_outage_that_retries() {
        let w = World::new();
        w.unplugged.borrow_mut().push(headset());
        w.broken.borrow_mut().push(DeviceSelection::default());
        let mut m = Manager::new(w.clone(), headset());
        m.start();
        assert!(!m.status().running && m.status().restarting);
        assert!(m
            .status()
            .last_error
            .as_deref()
            .is_some_and(|e| e.contains("Nouvelle tentative")));
        let opens = w.opens.borrow().len();
        w.advance(Duration::from_secs(1));
        m.tick();
        assert!(w.opens.borrow().len() > opens, "retried after 1 s");
    }

    #[test]
    fn after_both_fail_to_start_the_saved_devices_are_tried_first_again() {
        let w = World::new();
        let mut m = manager(&w);
        m.lost();
        w.advance(Duration::from_secs(1));
        m.tick(); // headset opens...
        assert_eq!(w.opens.borrow().last(), Some(&headset()));
        m.lost(); // ...but does not start
        w.advance(Duration::from_secs(10));
        m.tick(); // defaults open...
        assert_eq!(w.opens.borrow().last(), Some(&DeviceSelection::default()));
        m.lost(); // ...but do not start either
        w.advance(Duration::from_secs(10));
        m.tick(); // the headset (now working again) is tried first
        assert_eq!(w.opens.borrow().last(), Some(&headset()));
        w.advance(PROBATION);
        m.tick();
        assert_eq!(
            recovered(&m.take_events()),
            vec!["Son rétabli.".to_string()]
        );
        assert_eq!(m.status().monitor_name.as_deref(), Some("Casque USB"));
    }

    #[test]
    fn a_manual_choice_that_does_not_start_is_rejected_and_previous_kept() {
        let w = World::new();
        let mut m = manager(&w);
        let dead = DeviceSelection {
            monitor: Some("Enceinte Bluetooth".into()),
            ..Default::default()
        };
        w.no_start.borrow_mut().push(dead.clone());
        assert!(
            m.request(dead).is_err(),
            "not reported as accepted, so not saved"
        );
        assert!(m.status().running);
        assert_eq!(m.status().monitor_name.as_deref(), Some("Casque USB"));
    }

    #[test]
    fn a_failure_noticed_at_tick_time_is_never_announced_as_recovered() {
        let w = World::new();
        let mut m = manager(&w);
        m.lost();
        w.advance(Duration::from_secs(1));
        m.tick();
        w.advance(PROBATION);
        w.failed.set(true); // set between the runtime's check and this tick
        m.tick();
        assert!(recovered(&m.take_events()).is_empty());
        assert!(!m.status().running && m.status().restarting);
    }

    #[test]
    fn switch_back_shows_the_route_audio_really_uses() {
        let w = World::new();
        w.unplugged.borrow_mut().push(headset());
        let mut m = Manager::new(w.clone(), headset());
        m.start();
        assert!(
            m.status().fallback,
            "durable marker, not only a one-time event"
        );
        m.take_events();
        w.unplugged.borrow_mut().clear();
        w.advance(SWITCH_BACK);
        m.tick();
        assert_eq!(
            m.status().monitor_name.as_deref(),
            Some("Casque USB"),
            "shown as soon as audio uses it"
        );
        assert!(!m.status().fallback);
        assert_eq!(
            m.take_events(),
            vec![EngineEvent::StatusChanged],
            "the UI is told right away, not at the end of probation"
        );
        w.advance(PROBATION);
        m.tick();
        assert!(!m.status().fallback);
    }

    #[test]
    fn switches_back_to_the_saved_devices_once_plugged_in() {
        let w = World::new();
        w.unplugged.borrow_mut().push(headset());
        let mut m = Manager::new(w.clone(), headset());
        m.start();
        assert!(m.status().running, "started on the defaults");
        m.take_events();

        w.advance(SWITCH_BACK);
        m.tick();
        assert_eq!(
            w.opens.borrow().iter().filter(|s| **s == headset()).count(),
            1,
            "only checked availability"
        );

        w.unplugged.borrow_mut().clear();
        w.advance(SWITCH_BACK);
        m.tick();
        assert_eq!(w.opens.borrow().last(), Some(&headset()));
        w.advance(PROBATION);
        m.tick();
        assert_eq!(
            recovered(&m.take_events()),
            vec!["Périphériques choisis rétablis.".to_string()]
        );
        assert_eq!(m.status().monitor_name.as_deref(), Some("Casque USB"));
    }

    #[test]
    fn restarts_aim_at_the_saved_target_not_the_last_request() {
        let w = World::new();
        let mut m = manager(&w);
        let other = DeviceSelection {
            monitor: Some("Haut-parleurs".into()),
            ..Default::default()
        };
        m.request(other.clone()).unwrap();
        // The app could not save `other` and put the target back on the headset.
        m.set_target(headset());
        m.lost();
        w.advance(Duration::from_secs(1));
        m.tick();
        assert_eq!(w.opens.borrow().last(), Some(&headset()));
    }

    #[test]
    fn revision_grows_with_every_status_change() {
        let w = World::new();
        let mut m = manager(&w);
        let r0 = m.status().revision;
        m.lost();
        let r1 = m.status().revision;
        w.advance(Duration::from_secs(1));
        m.tick();
        w.advance(PROBATION);
        m.tick();
        assert!(r0 < r1 && r1 < m.status().revision);
    }

    #[test]
    fn rejected_request_keeps_previous_devices() {
        let w = World::new();
        let mut m = manager(&w);
        let bad = DeviceSelection {
            monitor: Some("Absent".into()),
            ..Default::default()
        };
        w.broken.borrow_mut().push(bad.clone());
        assert!(m.request(bad).is_err());
        assert!(m.status().running);
        assert_eq!(m.status().monitor_name.as_deref(), Some("Casque USB"));
    }
}
