use crate::{EffectDescriptor, EffectKind, ParamDescriptor};

fn param(
    key: &'static str,
    label: &'static str,
    range: (f32, f32),
    step: f32,
    default: f32,
    unit: &'static str,
) -> ParamDescriptor {
    ParamDescriptor {
        key,
        label,
        min: range.0,
        max: range.1,
        step,
        default,
        unit,
    }
}

/// All editor controls and construction defaults have this single source of truth.
pub fn effect_catalog() -> Vec<EffectDescriptor> {
    use EffectKind::*;
    vec![
        EffectDescriptor {
            kind: PitchShift,
            label: "Hauteur",
            description: "Transpose la voix sans changer sa vitesse.",
            params: vec![param(
                "semitones",
                "Demi-tons",
                (-12.0, 12.0),
                0.1,
                0.0,
                "st",
            )],
        },
        EffectDescriptor {
            kind: FormantShift,
            label: "Formants",
            description: "Déplace la couleur des voyelles en conservant la hauteur.",
            params: vec![param(
                "semitones",
                "Demi-tons",
                (-12.0, 12.0),
                0.1,
                0.0,
                "st",
            )],
        },
        EffectDescriptor {
            kind: Gain,
            label: "Volume",
            description: "Ajuste le niveau de la voix.",
            params: vec![param("db", "Gain", (-36.0, 24.0), 0.5, 0.0, "dB")],
        },
        EffectDescriptor {
            kind: LowPass,
            label: "Passe-bas",
            description: "Adoucit les aigus et assombrit la voix.",
            params: vec![
                param("cutoffHz", "Fréquence", (40.0, 20000.0), 10.0, 4500.0, "Hz"),
                param("q", "Résonance", (0.1, 10.0), 0.1, 0.707, ""),
            ],
        },
        EffectDescriptor {
            kind: HighPass,
            label: "Passe-haut",
            description: "Retire les graves et les bruits sourds.",
            params: vec![
                param("cutoffHz", "Fréquence", (20.0, 16000.0), 10.0, 120.0, "Hz"),
                param("q", "Résonance", (0.1, 10.0), 0.1, 0.707, ""),
            ],
        },
        EffectDescriptor {
            kind: BandPass,
            label: "Passe-bande",
            description: "Isole une bande de fréquences pour une voix nasale ou téléphonique.",
            params: vec![
                param("cutoffHz", "Fréquence", (80.0, 16000.0), 10.0, 1200.0, "Hz"),
                param("q", "Résonance", (0.1, 10.0), 0.1, 0.8, ""),
            ],
        },
        EffectDescriptor {
            kind: Distortion,
            label: "Distorsion",
            description: "Ajoute une saturation douce et maîtrisée.",
            params: vec![
                param("drive", "Intensité", (1.0, 30.0), 0.1, 3.0, "×"),
                param("mix", "Mélange", (0.0, 1.0), 0.01, 0.4, ""),
            ],
        },
        EffectDescriptor {
            kind: Bitcrush,
            label: "Réduction numérique",
            description: "Réduit la résolution et la fréquence pour un son rétro.",
            params: vec![
                param("bits", "Résolution", (2.0, 16.0), 1.0, 8.0, "bits"),
                param(
                    "downsample",
                    "Sous-échantillonnage",
                    (1.0, 32.0),
                    1.0,
                    4.0,
                    "×",
                ),
            ],
        },
        EffectDescriptor {
            kind: RingMod,
            label: "Modulation en anneau",
            description: "Ajoute une texture métallique à la voix.",
            params: vec![
                param("freqHz", "Fréquence", (10.0, 2000.0), 1.0, 70.0, "Hz"),
                param("mix", "Mélange", (0.0, 1.0), 0.01, 0.5, ""),
            ],
        },
        EffectDescriptor {
            kind: Tremolo,
            label: "Trémolo",
            description: "Fait pulser le volume régulièrement.",
            params: vec![
                param("rateHz", "Vitesse", (0.1, 20.0), 0.1, 4.0, "Hz"),
                param("depth", "Profondeur", (0.0, 1.0), 0.01, 0.5, ""),
            ],
        },
        EffectDescriptor {
            kind: Vibrato,
            label: "Vibrato",
            description: "Fait onduler la hauteur de la voix.",
            params: vec![
                param("rateHz", "Vitesse", (0.2, 12.0), 0.1, 5.0, "Hz"),
                param("depthSemitones", "Profondeur", (0.0, 2.0), 0.05, 0.25, "st"),
            ],
        },
        EffectDescriptor {
            kind: Echo,
            label: "Écho",
            description: "Répète la voix avec un retard réglable.",
            params: vec![
                param("delayMs", "Retard", (5.0, 1000.0), 1.0, 220.0, "ms"),
                param("feedback", "Répétitions", (0.0, 0.9), 0.01, 0.3, ""),
                param("mix", "Mélange", (0.0, 1.0), 0.01, 0.25, ""),
            ],
        },
        EffectDescriptor {
            kind: Reverb,
            label: "Réverbération",
            description: "Place la voix dans un espace diffus et résonnant.",
            params: vec![
                param("roomSize", "Taille de la pièce", (0.0, 1.0), 0.01, 0.6, ""),
                param("damping", "Absorption", (0.0, 1.0), 0.01, 0.5, ""),
                param("mix", "Mélange", (0.0, 1.0), 0.01, 0.25, ""),
            ],
        },
        EffectDescriptor {
            kind: Chorus,
            label: "Chœur",
            description: "Double la voix avec une légère modulation.",
            params: vec![
                param("rateHz", "Vitesse", (0.1, 8.0), 0.1, 0.8, "Hz"),
                param("depthMs", "Profondeur", (0.0, 10.0), 0.1, 3.0, "ms"),
                param("mix", "Mélange", (0.0, 1.0), 0.01, 0.35, ""),
            ],
        },
        EffectDescriptor {
            kind: Robotize,
            label: "Robot",
            description: "Un résonateur en peigne donne une hauteur mécanique fixe.",
            params: vec![param(
                "freqHz",
                "Hauteur du robot",
                (50.0, 500.0),
                1.0,
                100.0,
                "Hz",
            )],
        },
        EffectDescriptor {
            kind: Whisper,
            label: "Chuchotement",
            description: "Remplace les vibrations de la voix par un souffle articulé.",
            params: vec![param("amount", "Intensité", (0.0, 1.0), 0.01, 0.85, "")],
        },
        EffectDescriptor {
            kind: NoiseGate,
            label: "Porte de bruit",
            description: "Atténue le microphone au repos avec une fermeture progressive.",
            params: vec![param(
                "thresholdDb",
                "Seuil",
                (-80.0, -6.0),
                1.0,
                -45.0,
                "dB",
            )],
        },
        EffectDescriptor {
            kind: Compressor,
            label: "Compresseur",
            description: "Régularise le volume des paroles avec une attaque douce.",
            params: vec![
                param("thresholdDb", "Seuil", (-60.0, 0.0), 1.0, -18.0, "dB"),
                param("ratio", "Rapport", (1.0, 20.0), 0.1, 4.0, ":1"),
                param("makeupDb", "Gain de sortie", (0.0, 24.0), 0.5, 3.0, "dB"),
            ],
        },
    ]
}
