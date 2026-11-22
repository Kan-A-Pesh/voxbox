use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    sync::{atomic::Ordering, Arc},
};
use voxbox_dsp::{EffectKind, EffectSpec};
use voxbox_engine::{
    graph::{Command, Control, Graph, Settings, Voice, BLOCK},
    DecodedSound, EngineEvent,
};

struct Counting;
thread_local! {
    static TRACK: Cell<bool> = const { Cell::new(false) };
    static ALLOCS: Cell<usize> = const { Cell::new(0) };
    static FREES: Cell<usize> = const { Cell::new(0) };
}
// SAFETY: this wrapper forwards every allocation/deallocation to System with
// the original layout/pointer. Thread-local counters do not allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        TRACK.with(|t| {
            if t.get() {
                ALLOCS.with(|n| n.set(n.get() + 1));
            }
        });
        // SAFETY: caller supplies a valid allocation layout.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        TRACK.with(|t| {
            if t.get() {
                FREES.with(|n| n.set(n.get() + 1));
            }
        });
        // SAFETY: pointer and layout are the original System allocation.
        unsafe {
            System.dealloc(ptr, layout);
        }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        TRACK.with(|t| {
            if t.get() {
                ALLOCS.with(|n| n.set(n.get() + 1));
                FREES.with(|n| n.set(n.get() + 1));
            }
        });
        // SAFETY: caller upholds GlobalAlloc's realloc requirements.
        unsafe { System.realloc(ptr, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn graph() -> (Graph, Control, Arc<Settings>) {
    let settings = Arc::new(Settings::default());
    let (graph, control) = Graph::new(Arc::clone(&settings));
    (graph, control, settings)
}
fn send(control: &mut Control, command: Command) {
    assert!(control.send(command).is_ok());
}
fn render(graph: &mut Graph, input: f32) -> ([f32; BLOCK], [f32; BLOCK]) {
    let mut cable = [0.0; BLOCK];
    let mut monitor = [0.0; BLOCK];
    graph.process(&[input; BLOCK], &mut cable, &mut monitor);
    (cable, monitor)
}
fn sound(samples: Vec<f32>) -> DecodedSound {
    DecodedSound {
        duration_ms: (samples.len() / 48) as u32,
        samples: samples.into(),
    }
}
fn gain(db: f32) -> Box<Voice> {
    Voice::new(
        &[EffectSpec {
            kind: EffectKind::Gain,
            enabled: true,
            params: [("db".into(), db)].into(),
        }],
        None,
    )
}
fn events(control: &mut Control) -> Vec<EngineEvent> {
    std::iter::from_fn(|| control.event())
        .map(|e| e.into_event())
        .collect()
}
fn close(actual: f32, expected: f32) {
    assert!((actual - expected).abs() < 1e-4, "{actual} != {expected}");
}

#[test]
fn dry_mic_ptt_and_monitor_are_independent() {
    let (mut graph, _control, settings) = graph();
    let (cable, monitor) = render(&mut graph, 0.25);
    assert_eq!(cable, [0.25; BLOCK]);
    assert_eq!(monitor, [0.0; BLOCK]);
    settings.ptt.store(true, Ordering::Relaxed);
    assert_eq!(render(&mut graph, 0.25).0, [0.0; BLOCK]);
    settings.pressed.store(true, Ordering::Relaxed);
    settings.monitor.store(true, Ordering::Relaxed);
    let (cable, monitor) = render(&mut graph, 0.25);
    assert_eq!(cable, [0.25; BLOCK]);
    assert_eq!(monitor, cable);
    settings.pressed.store(false, Ordering::Relaxed);
    assert_eq!(render(&mut graph, 0.25).1, [0.0; BLOCK]);
}
#[test]
fn voice_changes_crossfade_and_off_returns_dry() {
    let (mut graph, mut control, settings) = graph();
    settings.voice.store(true, Ordering::Relaxed);
    send(&mut control, Command::Voice(gain(6.0206)));
    render(&mut graph, 0.2);
    let (before, monitor) = render(&mut graph, 0.2);
    close(before[479], 0.4);
    assert_eq!(monitor, [0.0; BLOCK]);
    send(&mut control, Command::Voice(gain(-6.0206)));
    let (changed, _) = render(&mut graph, 0.2);
    close(changed[0], before[479]);
    assert!(changed.windows(2).all(|w| (w[1] - w[0]).abs() < 0.002));
    close(render(&mut graph, 0.2).0[479], 0.1);
    settings.voice.store(false, Ordering::Relaxed);
    render(&mut graph, 0.2);
    let (dry, _) = render(&mut graph, 0.2);
    close(dry[0], 0.2);
}
#[test]
fn sound_buses_mix_volume_loop_restart_stop_and_events() {
    let (mut graph, mut control, settings) = graph();
    settings
        .cable_volume
        .store(0.5f32.to_bits(), Ordering::Relaxed);
    settings
        .monitor_volume
        .store(0.25f32.to_bits(), Ordering::Relaxed);
    settings.ptt.store(true, Ordering::Relaxed); // PTT only gates mic.
    let data = sound([vec![0.8; BLOCK], vec![0.4; BLOCK]].concat());
    send(&mut control, Command::play("loop", data.clone(), 0.5, true));
    let (c, m) = render(&mut graph, 0.9);
    close(c[0], 0.2);
    close(m[0], 0.1);
    close(render(&mut graph, 0.0).0[0], 0.1);
    close(render(&mut graph, 0.0).0[0], 0.2); // loop wraps
    assert!(events(&mut control).iter().any(|e| matches!(e, EngineEvent::SoundProgress { id, position_ms: 10, duration_ms: 20 } if id == "loop")));
    send(&mut control, Command::play("loop", data, 0.5, true));
    close(render(&mut graph, 0.0).0[0], 0.2); // replay restarts
    send(&mut control, Command::Stop("loop".into()));
    assert_eq!(render(&mut graph, 0.0).0, [0.0; BLOCK]);
    assert!(events(&mut control)
        .iter()
        .any(|e| matches!(e, EngineEvent::SoundEnded { id } if id == "loop")));
    send(
        &mut control,
        Command::play("a", sound(vec![0.4; 48]), 1.0, false),
    );
    let (c, _) = render(&mut graph, 0.0);
    assert_eq!(&c[48..], &[0.0; BLOCK - 48]);
    let done = events(&mut control);
    assert!(done
        .iter()
        .any(|e| matches!(e, EngineEvent::SoundProgress { id, position_ms: 1, .. } if id == "a")));
    assert!(done
        .iter()
        .any(|e| matches!(e, EngineEvent::SoundEnded { id } if id == "a")));
    for id in ["b", "c"] {
        send(
            &mut control,
            Command::play(id, sound(vec![0.4; BLOCK]), 1.0, true),
        );
    }
    render(&mut graph, 0.0);
    send(&mut control, Command::StopAll);
    assert_eq!(render(&mut graph, 0.0).0, [0.0; BLOCK]);
    assert_eq!(
        events(&mut control)
            .iter()
            .filter(|e| matches!(e, EngineEvent::SoundEnded { .. }))
            .count(),
        2
    );
}
#[test]
fn mixing_clamps_and_meter_reports_dbfs_at_33_hz() {
    let (mut graph, mut control, settings) = graph();
    settings.monitor.store(true, Ordering::Relaxed);
    for id in ["one", "two"] {
        send(
            &mut control,
            Command::play(id, sound(vec![0.9; BLOCK]), 1.0, true),
        );
    }
    let (c, m) = render(&mut graph, 0.5);
    assert_eq!(c, [1.0; BLOCK]);
    assert_eq!(m, [1.0; BLOCK]);
    render(&mut graph, 0.5);
    render(&mut graph, 0.5);
    let observed = events(&mut control);
    let meters: Vec<_> = observed
        .iter()
        .filter_map(|e| {
            if let EngineEvent::Meter {
                input_db,
                output_db,
            } = e
            {
                Some((*input_db, *output_db))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(meters.len(), 1);
    close(meters[0].0, -6.0206);
    close(meters[0].1, 0.0);
    assert_eq!(voxbox_engine::graph::dbfs(&[0.0; BLOCK]), -60.0);
    assert_eq!(voxbox_engine::graph::dbfs(&[0.00001; BLOCK]), -60.0);
    close(voxbox_engine::graph::dbfs(&[1.0; BLOCK]), 0.0);
}
#[test]
fn empty_sound_finishes_and_full_event_queue_recovers() {
    let (mut graph, mut control, _) = graph();
    send(
        &mut control,
        Command::play("empty", sound(vec![]), 1.0, true),
    );
    assert_eq!(render(&mut graph, 0.0).0, [0.0; BLOCK]);
    assert!(events(&mut control)
        .iter()
        .any(|e| matches!(e, EngineEvent::SoundEnded { id } if id == "empty")));
    send(
        &mut control,
        Command::play("many", sound(vec![0.1; BLOCK]), 1.0, true),
    );
    for _ in 0..800 {
        render(&mut graph, 0.0);
    }
    send(&mut control, Command::StopAll);
    events(&mut control);
    control.reclaim();
    assert_eq!(render(&mut graph, 0.0).0, [0.0; BLOCK]);
    assert!(events(&mut control)
        .iter()
        .any(|e| matches!(e, EngineEvent::SoundEnded { id } if id == "many")));
}
#[test]
fn block_path_neither_allocates_nor_drops_owned_resources() {
    let (mut graph, mut control, settings) = graph();
    settings.voice.store(true, Ordering::Relaxed);
    settings.noise.store(true, Ordering::Relaxed);
    send(&mut control, Command::Voice(gain(3.0)));
    send(
        &mut control,
        Command::play("rt", sound(vec![0.1; 100]), 1.0, false),
    );
    let mut c = [0.0; BLOCK];
    let mut m = [0.0; BLOCK];
    let input = std::array::from_fn::<_, BLOCK, _>(|i| (i as f32 * 0.05).sin() * 0.5);
    ALLOCS.with(|n| n.set(0));
    FREES.with(|n| n.set(0));
    TRACK.with(|t| t.set(true));
    for _ in 0..40 {
        graph.process(&input, &mut c, &mut m);
    }
    TRACK.with(|t| t.set(false));
    assert_eq!(ALLOCS.with(Cell::get), 0, "allocation in process");
    assert_eq!(FREES.with(Cell::get), 0, "resource dropped in process");
    control.reclaim();
    events(&mut control);
    send(&mut control, Command::Voice(gain(-3.0)));
    send(&mut control, Command::Stop("missing".into()));
    ALLOCS.with(|n| n.set(0));
    FREES.with(|n| n.set(0));
    TRACK.with(|t| t.set(true));
    graph.process(&input, &mut c, &mut m);
    TRACK.with(|t| t.set(false));
    assert_eq!(ALLOCS.with(Cell::get), 0);
    assert_eq!(FREES.with(Cell::get), 0);
}
